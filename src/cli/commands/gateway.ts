/**
 * `compaction gateway start|status|stop`, the local Compaction Gateway (PUBLIC CLI).
 *
 * A byte-safe, OpenAI-compatible local reverse proxy with record/cache and gated apply behavior. Cache
 * mode leaves model-visible request bytes unchanged. Cache + context can compose deterministic request
 * mutations only under matching stored authorization and per-request safety/recovery gates; responses
 * remain unmodified and LCM apply remains unreachable. Every call records one content-free receipt. The
 * client's API key rides straight through to the provider and is NEVER read, stored, or logged.
 *
 * `runGatewayStart` is exported so the guided onboarding TUI (`GatewayTui` → `init`) can start the same
 * gateway with a config picked interactively, no duplicate server, no new behavior.
 */
import { URL } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { startGatewayServer, type GatewayServerMode } from "../../core/gateway/server.js";
import { DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_RECEIPTS_FILE, formatFreshBilledInputReduction } from "../../core/gateway/receipt.js";
import {
  writeGatewayPid,
  removeGatewayPid,
  readGatewayPid,
  getGatewayStatus,
  isProcessAlive,
  readReceipts
} from "../../core/gateway/status.js";
import { planGatewayConfigure, applyGatewayConfigure, formatConfigurePlan } from "../../core/gateway/configure.js";
import { DEDUPE_POLICY } from "../../core/gateway/request-shape.js";
import { GATEWAY_RECOVERY_DIR, readRecovery } from "../../core/gateway/recovery.js";
import { isInputCompactionAvailable } from "../../core/gateway/input-compaction-seam.js";
import { runThroughGateway, injectionEnv, defaultUpstreamFor, type RunThroughGatewayOptions } from "./dev.js";
import { ensureGateway } from "../../core/gateway/ensure.js";
import { resolveApplyRoutingActivation } from "../../core/gateway/apply-routing-activation.js";
import { compareGatewayProof, formatGatewayProof, proofSummaryFromReceipt, receiptsForGatewayProof } from "../../core/gateway/proof.js";
import { computeCapabilityMatrix } from "../../core/gateway/capability-matrix.js";
import { formatCapabilityMatrix } from "../../core/gateway/capability-view.js";
import { liveVerificationsForMatrix } from "../../core/gateway/verification-store.js";
import { autoWorkflowNote, resolveWorkflowForGatewayStart, resolveProviderForGatewayStart, providerInferenceNote } from "../../core/gateway/workflow-default.js";
import { runVerifyCache } from "./gateway-verify-cache.js";

interface GatewayStartOptions {
  provider?: string;
  upstream?: string;
  listen?: string;
  mode?: string;
  policy?: string;
  approval?: string;
  workflow?: string;
  idleTtl?: string;
}

/** Parse `--listen http://127.0.0.1:8787` (or `127.0.0.1:8787`) into host + port. */
export function parseListen(listen: string): { host: string; port: number } {
  const raw = listen.includes("://") ? listen : `http://${listen}`;
  const u = new URL(raw);
  const port = u.port ? Number.parseInt(u.port, 10) : 8787;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid --listen port in '${listen}'`);
  }
  return { host: u.hostname || "127.0.0.1", port };
}

/** Human form of an idle TTL for log lines: whole minutes when even, otherwise milliseconds. */
function formatIdleTtl(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${ms}ms`;
}

export interface GatewayStartConfig {
  provider: string;
  upstream: string;
  mode: GatewayServerMode;
  /** Deterministic apply policy (required for apply/dry-run). Only `deterministic-dedupe` is implemented. */
  policy?: string;
  /**
   * The workflow/tool identity of this gateway connection (e.g. "claude-code" / "codex"). Enables
   * ONLY the stored-authorization lookup: a persisted, enabled, narrow-scoped `auto-when-gates-pass`
   * preference for this exact tool may then drive automatic deterministic apply when every
   * fail-closed eligibility gate passes. Absent → stored authorizations are never consulted.
   */
  workflow?: string;
  host: string;
  port: number;
  cwd?: string;
  log?: (line: string) => void;
  /** Install SIGINT/SIGTERM handlers that close the server + remove the pidfile (default true). */
  installSignals?: boolean;
  /**
   * Own the shared `gateway.json` lifecycle record (default true). Transient `gateway run` servers set
   * this false: they are scoped to their child process and must never replace or remove the record used
   * by the independently managed `gateway start|status|stop` lifecycle.
   */
  persistLifecycle?: boolean;
  /** Default-off Claude Code subscription envelope (`gateway run --subscription`); never accepted by `gateway start`. */
  claudeSubscription?: { capability: string };
  /**
   * Idle auto-shutdown TTL in ms - DEFAULT OFF (absent/0 = long-lived until `gateway stop`/Ctrl-C).
   * When > 0 the gateway self-stops cleanly after being idle that long (no request in flight is ever
   * cut off) and removes its own pidfile so start-or-reuse never sees a dead gateway as live. Set by
   * `gateway ensure` for the transparent-routing gateway; an explicit `gateway start` opts in via
   * `--idle-ttl`.
   */
  idleTtlMs?: number;
}

export interface RunningGateway {
  base: string;
  close: () => Promise<void>;
}

/**
 * Start the gateway from a validated config: bind the server, write the content-free pidfile (so
 * `status`/`stop` work), print the honest banner, and install shutdown handlers that remove the pidfile.
 * Reused by both `gateway start` and the guided onboarding. Throws on bind failure (the caller reports it).
 */
export async function runGatewayStart(config: GatewayStartConfig): Promise<RunningGateway> {
  if (config.mode !== "record" && config.mode !== "apply" && config.mode !== "dry-run") {
    throw new Error(`gateway mode '${config.mode}' is not implemented (record | apply | dry-run)`);
  }
  const mutating = config.mode === "apply" || config.mode === "dry-run";
  if (mutating && config.policy !== DEDUPE_POLICY) {
    throw new Error(`gateway --mode ${config.mode} requires --policy ${DEDUPE_POLICY} (the only deterministic policy implemented)`);
  }
  const cwd = config.cwd ?? process.cwd();
  const log = config.log ?? ((line: string) => console.log(line));
  const persistLifecycle = config.persistLifecycle !== false;
  const idleTtlMs = config.idleTtlMs !== undefined && config.idleTtlMs > 0 ? config.idleTtlMs : undefined;

  const started = await startGatewayServer({
    provider: config.provider,
    upstream: config.upstream,
    mode: config.mode,
    ...(config.policy ? { policy: config.policy } : {}),
    ...(config.workflow ? { workflow: config.workflow } : {}),
    ...(config.claudeSubscription ? { claudeSubscription: config.claudeSubscription } : {}),
    ...(idleTtlMs !== undefined
      ? {
          idleTtlMs,
          // Idle shutdown removes the pidfile as the listener closes: start-or-reuse never sees this
          // dead gateway as live, and the next routed run transparently starts a fresh one. With the
          // listener closed, the unref'd timer cleared, and no other handles, the process exits cleanly.
          onIdleShutdown: () => {
            if (persistLifecycle) removeGatewayPid(cwd);
            log(
              `compaction gateway: idle for over ${formatIdleTtl(idleTtlMs)} - stopped cleanly ` +
                "(the next routed run starts a fresh gateway automatically; or run 'compaction gateway start')."
            );
          }
        }
      : {}),
    cwd,
    log,
    host: config.host,
    port: config.port
  });

  // ---- Entitlement self-repair, once per gateway process ------------------------------------------
  //
  // THE GATEWAY START IS THE AUTOMATIC PATH. A Community user runs their workflow; the gateway comes
  // up underneath them. That makes it the one moment in normal use where the device can hand its
  // recorded usage to the service and take back a current allowance, without anybody being told that
  // leases or reconciliation exist. `init`/`mode`/`login` do the same repair, but they are setup
  // commands — a device that never runs them again would otherwise keep spending an allowance the
  // service had already debited.
  //
  // NOT AWAITED, DELIBERATELY. The gateway is already listening on the line above and must stay ready
  // to serve immediately: an entitlement service that is slow or down would otherwise add its timeout
  // to every single workflow start. The repair lands on disk, and the apply path re-reads the lease
  // verdict from disk on EVERY request, so the refreshed allowance — including an exhausted one — is
  // observed by this same running process as soon as it is written. Errors cannot escape: this
  // function never throws, and the `catch` is here only so a rejected promise can never become an
  // unhandled rejection that takes the gateway down.
  //
  // It is a no-op with no network call on an Open device (no credentials) and on a Community device
  // whose usage is already reconciled and whose lease is still valid.
  void (async () => {
    try {
      const { ensureCommunityRuntime } = await import("../../core/entitlement/community-runtime.js");
      await ensureCommunityRuntime(process.env);
    } catch {
      // Entitlement repair is best-effort and never affects whether traffic flows.
    }
  })();

  const base = `http://${started.address.host}:${started.address.port}`;
  if (persistLifecycle) {
    writeGatewayPid(
      {
        pid: process.pid,
        host: started.address.host,
        port: started.address.port,
        upstream: config.upstream,
        provider: config.provider,
        mode: config.mode,
        ...(config.workflow === "codex" || config.workflow === "claude-code" ? { workflow: config.workflow } : {}),
        startedAt: new Date().toISOString()
      },
      cwd
    );
  }

  // Asked, not assumed. The banner below describes a mutation capability before any request has
  // arrived to demonstrate it, and in a public build that capability is absent — see F76.
  const inputCompactionAvailable = mutating ? await isInputCompactionAvailable() : false;

  const receiptsPath = path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_RECEIPTS_FILE);
  if (config.mode === "record") {
    log("compaction gateway - RECORD mode (byte-safe; no mutation; content-free receipts)");
  } else if (config.mode === "dry-run") {
    log(`compaction gateway - DRY-RUN mode (policy ${config.policy}; computes a candidate but forwards the ORIGINAL request unchanged)`);
  } else {
    log(`compaction gateway - APPLY mode · EXPERIMENTAL (policy ${config.policy}; DETERMINISTIC only)`);
    if (inputCompactionAvailable) {
      log("  Apply changes model-visible input for KNOWN-SAFE shapes only; the original is retained locally;");
      log("  unknown/complex shapes FAIL CLOSED (forwarded unchanged). System/developer instructions & tool schemas are never touched.");
    } else {
      // The mutating half of deterministic input compaction is not in this build. Saying otherwise
      // here would promise, at the moment the user opts into an EXPERIMENTAL mutation mode, the one
      // thing this binary cannot do — and every request would then silently fail closed while the
      // banner still read as a capability statement.
      log("  This build has NO deterministic input compactor, so apply mode cannot change model-visible");
      log("  input: every request is forwarded UNCHANGED and each receipt records why. Nothing is mutated,");
      log("  so no original needs retaining and there is nothing to recover.");
    }
  }
  log(`  provider:  ${config.provider}  →  upstream ${config.upstream}`);
  if (config.workflow) {
    log(`  workflow:  ${config.workflow}   (stored scoped authorizations for this tool are honored: eligible requests`);
    log("             apply automatically ONLY under an enabled stored policy - compaction policies list / explain;");
    log(
      inputCompactionAvailable
        ? "             disable anytime: compaction policies disable <id>; originals retained: compaction gateway recover <id>)"
        : "             disable anytime: compaction policies disable <id>)"
    );
  }
  if (idleTtlMs !== undefined) {
    log(`  idle stop: auto-stops cleanly after ${formatIdleTtl(idleTtlMs)} without a request (in-flight requests always finish)`);
  }
  log(`  receipts:  ${receiptsPath}   (local-only, gitignored; token/cache counts only - no prompt/response content)`);
  // Printed only when something can actually be written there. Without the compactor no request is
  // ever mutated, so this path would name a directory that stays empty for the life of the process.
  if (mutating && inputCompactionAvailable) {
    log(`  recovery:  ${path.join(cwd, GATEWAY_RECOVERY_DIR)}   (local-only; the ORIGINAL request body when apply changes it - recover with 'compaction gateway recover <id>')`);
  }
  log("");
  log(`Gateway running at ${base}`);
  log("");
  log("Run one command through Compaction:");
  log("  compaction gateway run -- npm run dev");
  log("");
  log("Inspect traffic:");
  log("  compaction gateway status");
  log("");
  log("If manual setup is needed:");
  log(`  compaction gateway configure    (or point your OpenAI client at  baseURL = ${base}/v1  - keep your key on the client; the gateway never stores it)`);
  log("");
  log("  Stop from another terminal:  compaction gateway stop   ·   or press Ctrl-C here.");

  const close = async (): Promise<void> => {
    if (persistLifecycle) removeGatewayPid(cwd);
    await started.close();
  };

  if (config.installSignals !== false) {
    const shutdown = async (): Promise<void> => {
      await close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  }

  return { base, close };
}

export function registerGatewayCommand(program: Command): void {
  const gateway = program
    .command("gateway")
    .description(
      "Local Compaction Gateway - a byte-safe, OpenAI-compatible reverse proxy that records a content-free " +
        "token/cache/cost receipt per call. Default RECORD mode (no mutation); EXPERIMENTAL deterministic " +
        "apply/dry-run modes are explicit opt-in (no cache-opt, no LCM, no semantic compaction)."
    );

  gateway
    .command("start")
    .description("Start the local gateway. Point your OpenAI client's base URL at --listen. RECORD forwards byte-for-byte; APPLY (experimental, explicit) deterministically dedupes known-safe shapes and retains the original locally.")
    .option(
      "--provider <name>",
      "Upstream provider route: openai | anthropic. Omitted: inferred from --workflow (claude-code → anthropic, codex → openai), else from your single connected workflow (compaction init); no signal → openai."
    )
    .option("--upstream <url>", "Upstream provider base URL (the request path is forwarded to its origin; default: the resolved provider's public API).")
    .option("--listen <url>", "Local address to listen on (e.g. http://127.0.0.1:8787).", "http://127.0.0.1:8787")
    .option("--mode <mode>", "Gateway mode: record (default, byte-safe) | apply (experimental, deterministic) | dry-run (preview, forwards original).", "record")
    .option("--policy <name>", `Deterministic apply policy (required for apply/dry-run). Only '${DEDUPE_POLICY}' is implemented.`)
    .option("--approval <mode>", "Apply approval model (informational: starting apply mode IS the explicit approval; per-request interactive approval is deferred).", "ask")
    .option(
      "--workflow <tool>",
      "Workflow identity of this connection (claude-code | codex | auto | none). Lets a STORED scoped authorization (compaction policies list) drive automatic deterministic apply on eligible requests - only if you explicitly authorized that tool; without a stored authorization this changes nothing. Omitted (or `auto`): defaults deterministically to the provider-matched workflow you connected via `compaction init` (openai → codex, anthropic → claude-code); no connected match → no workflow identity. `none` disables the default."
    )
    .option(
      "--idle-ttl <ms>",
      "Auto-stop the gateway cleanly after this many milliseconds without a request (in-flight requests always finish; the pidfile is removed on stop). Omitted or 0: the gateway is long-lived until 'compaction gateway stop' or Ctrl-C. The transparent-routing gateway spawned by 'gateway ensure' sets this automatically; an explicit start opts in here."
    )
    .action(async (options: GatewayStartOptions) => {
      const mode = (options.mode ?? "record") as GatewayServerMode;
      if (mode !== "record" && mode !== "apply" && mode !== "dry-run") {
        console.error(`error: gateway mode '${mode}' is not implemented (record | apply | dry-run).`);
        process.exitCode = 1;
        return;
      }
      if ((mode === "apply" || mode === "dry-run") && options.policy !== DEDUPE_POLICY) {
        console.error(
          `error: --mode ${mode} requires --policy ${DEDUPE_POLICY} (the only deterministic policy implemented). ` +
            `Apply is deterministic-only - no semantic compaction, no LCM.`
        );
        process.exitCode = 1;
        return;
      }
      // Provider inference (explicit > --workflow match > single connected workflow > openai
      // fallback): a Claude Code gateway must never silently point at the OpenAI upstream.
      const providerResolution = resolveProviderForGatewayStart({
        ...(options.provider !== undefined ? { explicitProvider: options.provider } : {}),
        ...(options.workflow !== undefined ? { explicitWorkflow: options.workflow } : {})
      });
      const provider = providerResolution.provider;
      // Only the SOURCE of the workflow identity is resolved here (explicit > auto-from-connect > none).
      // The stored-authorization lookup and every apply eligibility gate downstream are unchanged.
      let workflowResolution;
      try {
        workflowResolution = resolveWorkflowForGatewayStart({ provider, ...(options.workflow !== undefined ? { explicit: options.workflow } : {}) });
      } catch (err) {
        console.error(`error: ${(err as Error).message}.`);
        process.exitCode = 1;
        return;
      }
      const workflow = workflowResolution.workflow;
      if (providerResolution.source === "workflow" || providerResolution.source === "connected") {
        console.log(`compaction gateway start: ${providerInferenceNote(providerResolution)}`);
      }
      const upstream = options.upstream ?? defaultUpstreamFor(provider);
      try {
        new URL(upstream);
      } catch {
        console.error(`error: --upstream '${upstream}' is not a valid URL.`);
        process.exitCode = 1;
        return;
      }
      let listen;
      try {
        listen = parseListen(options.listen ?? "http://127.0.0.1:8787");
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      let idleTtlMs: number | undefined;
      if (options.idleTtl !== undefined) {
        const parsed = Number(options.idleTtl);
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
          console.error(`error: --idle-ttl '${options.idleTtl}' is not a non-negative integer (milliseconds; 0 = never auto-stop).`);
          process.exitCode = 1;
          return;
        }
        idleTtlMs = parsed;
      }
      if (workflowResolution.source === "auto-connected" && workflow) {
        console.log(`compaction gateway start: ${autoWorkflowNote(workflow)}`);
      }
      try {
        await runGatewayStart({
          provider,
          upstream,
          mode,
          ...(options.policy ? { policy: options.policy } : {}),
          ...(workflow ? { workflow } : {}),
          ...(idleTtlMs !== undefined ? { idleTtlMs } : {}),
          host: listen.host,
          port: listen.port
        });
      } catch (err) {
        console.error(`error: could not start the gateway on ${listen.host}:${listen.port} - ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  gateway
    .command("status")
    .description("Show whether the local gateway is running + a content-free rollup of its receipts (token/cache; no content).")
    .option("--json", "Print the content-free status as JSON.")
    .action(async (options: { json?: boolean }) => {
      const status = await getGatewayStatus(process.cwd());
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log("compaction gateway status");
      if (status.running) {
        console.log(`  gateway running:      yes  ${status.base ?? ""}  (pid ${status.pid})`);
        console.log(`  provider / mode:      ${status.provider} / ${status.mode}`);
        console.log(`  workflow identity:    ${status.workflow ?? "none (generic or legacy gateway)"}`);
        console.log(`  listen URL:           ${status.base ?? "(unknown)"}`);
      } else if (status.pid) {
        console.log(`  gateway running:      no  (stale pidfile for pid ${status.pid} - run 'compaction gateway stop' to clear it)`);
      } else {
        console.log("  gateway running:      no  (start it with 'compaction gateway start', or 'compaction' → Gateway setup)");
      }
      console.log(`  requests observed:    ${status.receiptsCount}  (local-only, content-free)`);
      console.log(`  last request:         ${status.lastRequestAt ?? "none observed yet"}`);
      console.log(`  cached input seen:    ${status.receiptsCount > 0 ? (status.cachedObserved ? "yes" : "no") : "unknown (no requests yet)"}`);
      if (status.receiptsCount > 0) {
        console.log(`  best fresh/billed input reduction:  ${formatFreshBilledInputReduction(status.summary.bestReduction)}`);
        console.log(`  ${status.summary.modelVisibleBytesUnchanged ? "model-visible bytes unchanged" : "model-visible bytes: mixed - check receipts"}`);
      }
    });


  gateway
    .command("capabilities")
    .description(
      "Show what is actually supported per workflow (cache-proof / provider-reported / activity-only / " +
        "local-estimate / unavailable + the reason), rendered from the capability matrix. Content-free. " +
        "Supported ≠ live-verified: nothing is live-proven this cycle."
    )
    .option("--json", "Print the content-free capability matrix as JSON.")
    .action((options: { json?: boolean }) => {
      // Reflect REAL operator-run verifications: liveVerified flips true only where a passing content-free
      // verify-cache record exists (default: none → false everywhere, exactly as before).
      const matrix = computeCapabilityMatrix({ verifications: liveVerificationsForMatrix(process.cwd()) });
      if (options.json) {
        console.log(JSON.stringify(matrix, null, 2));
        return;
      }
      console.log(formatCapabilityMatrix(matrix));
    });

  gateway
    .command("proof")
    .description("Compare local content-free baseline/compacted receipts for one proof run and show provider-reported fresh input reduction.")
    .requiredOption("--proof-run <id>", "Client-set proof-run id from x-compaction-proof-run.")
    .action((options: { proofRun: string }) => {
      const receipts = readReceipts(process.cwd());
      const paired = receiptsForGatewayProof(receipts, options.proofRun);
      const delta = compareGatewayProof({
        proofRunId: options.proofRun,
        ...(paired.baseline ? { baseline: proofSummaryFromReceipt(paired.baseline) } : {}),
        ...(paired.compacted ? { compacted: proofSummaryFromReceipt(paired.compacted) } : {})
      });
      console.log(formatGatewayProof(delta));
    });

  gateway
    .command("verify-cache")
    .description(
      "OPERATOR-run LIVE provider cache verification. Needs YOUR provider API key in the env (e.g. OPENAI_API_KEY); " +
        "issues a cold + warm request through the local gateway under one proof-run id, reads the content-free " +
        "receipts, and records a content-free result. It marks live-verified ONLY on real provider-reported cache " +
        "- never a fabricated pass. No key is stored/logged/printed; with no key it makes NO call (key-gated, exits " +
        "non-zero). On success it flips liveVerified for that provider in 'compaction gateway capabilities'."
    )
    .requiredOption("--provider <id>", "Provider to verify (openai | anthropic).")
    .option("--upstream <url>", "Upstream provider base URL (default: the provider's public API).")
    .option("--model <model>", "Model for the two cheap verification requests (default: a small model).")
    .option("--listen <url>", "Local listen address when starting a gateway (default: an ephemeral local port).")
    .option("--json", "Print the content-free verification result as JSON.")
    .action(async (options: { provider: string; upstream?: string; model?: string; listen?: string; json?: boolean }) => {
      const result = await runVerifyCache({ ...options, cwd: process.cwd() });
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    });

  gateway
    .command("ensure")
    .description(
      "Start-or-reuse the persistent local RECORD-mode gateway for transparent tool routing and print its " +
        "base URL (one line, stdout). Used by the Claude Code PATH shim before every normal `claude` run. " +
        "Record-only by construction: a running gateway is reused ONLY when it is byte-safe for transparent " +
        "traffic (record mode, matching provider/upstream, no workflow identity - a workflow-scoped gateway " +
        "may honor a stored apply authorization and is never reused here); otherwise a detached " +
        "`gateway start --mode record --workflow none` is spawned on a free 127.0.0.1 port. Any failure exits " +
        "non-zero with nothing on stdout - fail-open callers then run their tool unchanged. " +
        "A gateway started this way is PERSISTENT by default (it never idle-shuts-down, so it cannot " +
        "take down a live session), and its port is health-checked before reuse so the shim never routes " +
        "to a dead URL (opt into idle auto-stop with env COMPACTION_GATEWAY_IDLE_TTL_MS in ms; 0 = never). " +
        "Stop it anytime: compaction gateway stop."
    )
    .option("--provider <name>", "Provider route to ensure: openai | anthropic.", "openai")
    .option(
      "--upstream <url>",
      "Upstream provider base URL (default: the provider's public API; env override COMPACTION_GATEWAY_UPSTREAM - a local test seam)."
    )
    .option("--json", "Print the content-free ensure result as JSON instead of the bare base URL.")
    .action(async (options: { provider?: string; upstream?: string; json?: boolean }) => {
      const provider = options.provider ?? "openai";
      const envUpstream = process.env.COMPACTION_GATEWAY_UPSTREAM;
      const upstream =
        options.upstream ?? (envUpstream && envUpstream.trim() !== "" ? envUpstream : defaultUpstreamFor(provider));
      try {
        new URL(upstream);
      } catch {
        console.error(`error: --upstream '${upstream}' is not a valid URL.`);
        process.exitCode = 1;
        return;
      }
      // APPLY-ROUTING (DEFAULT OFF): decide whether this transparent-routing ensure engages the
      // workflow-scoped gateway so the server's fail-closed stored-authorization path may upgrade
      // eligible requests to deterministic apply. The dormant guard checks key + input-opt + stored
      // auth + explicit init + not-stopped; ANY miss (or any error) stays record-only (fail-closed).
      // The shim contract is unchanged: only the base URL prints on success, and any failure is
      // fail-open (the tool runs unrouted). Never throws.
      const applyRouting = await resolveApplyRoutingActivation({ provider, cwd: process.cwd() });
      const result = await ensureGateway({
        provider,
        upstream,
        cwd: process.cwd(),
        ...(applyRouting.engage ? { applyRouting: applyRouting.workflow } : {})
      });
      if (options.json) {
        // Content-free: the ensure result plus the honest apply-routing posture (engaged workflow or the
        // dormant reason + version). No credential, no content - a diagnostic label only.
        console.log(JSON.stringify({ ...result, applyRouting }, null, 2));
        if (result.status !== "reused" && result.status !== "started") process.exitCode = 1;
        return;
      }
      if (result.status === "reused" || result.status === "started") {
        // The bare base URL is the whole contract: the shim substitutes this into ANTHROPIC_BASE_URL.
        console.log(result.base);
        return;
      }
      console.error(`compaction gateway ensure: ${result.reason} - callers fail open (the tool runs unchanged).`);
      process.exitCode = 1;
    });

  // Built standalone and attached with `addCommand`, NOT with `gateway.command("run")`, because of the
  // `configureOutput` call below. Commander's `.command()` calls `copyInheritedSettings`, which assigns
  // the parent's `_outputConfiguration` object BY REFERENCE, and `.configureOutput()` then `Object.assign`s
  // into whatever object it holds - so configuring output on a `.command()`-created child silently
  // rewrites error output for the ENTIRE program. It did: every unknown option on every command answered
  // "unknown option '--x' on compaction gateway run ... See 'compaction gateway run --help'", so a user
  // who typo'd a flag on `compaction init` was sent to the help of a command they never ran, and told
  // about `--` passthrough rules that do not apply to it. `addCommand` does not copy
  // inherited settings, so this command keeps the fresh configuration its own constructor built and the
  // override stays scoped to the one command whose `--` semantics motivate it.
  const runCommand = new Command("run")
    .description(
      "Run a command through the local Compaction Gateway. Usage: compaction gateway run -- <command>. " +
        "Starts/reuses the gateway, injects the endpoint into the child (never a key), streams its output " +
        "unchanged, preserves its exit code, and prints a content-free traffic summary. " +
        "Route Codex:  compaction gateway run --workflow codex -- codex exec --json \"<task>\"   ·   " +
        "Route Claude Code:  compaction gateway run --provider anthropic --workflow claude-code -- claude   ·   " +
        "Keyless Claude Code (saved login, no API key):  compaction gateway run --provider anthropic --subscription -- claude   ·   " +
        "One-command deterministic apply (EXPERIMENTAL, same gates as 'gateway start --mode apply'):  " +
        `compaction gateway run --mode apply --policy ${DEDUPE_POLICY} --provider anthropic -- claude -p \"<task>\"`
    )
    .option("--provider <name>", "Provider to route: openai (default, OpenAI-compatible) | anthropic (Claude Code). Any other id uses OpenAI-compatible injection.", "openai")
    .option(
      "--mode <mode>",
      "Gateway mode for this run: record (default - byte-safe, no mutation) | apply (EXPERIMENTAL - the same " +
        "gated deterministic apply as 'gateway start --mode apply'; requires --policy; not available with --subscription).",
      "record"
    )
    .option("--policy <name>", `Deterministic apply policy (required for --mode apply). Only '${DEDUPE_POLICY}' is implemented.`)
    .option("--upstream <url>", "Upstream provider base URL (default: the provider's public API - OpenAI, or Anthropic when --provider anthropic).")
    .option("--listen <url>", "Local listen address when starting a gateway (default: an ephemeral local port).")
    .option("--workflow <tool>", "Routed workflow identity: codex | claude-code | auto | none. Omitted (or `auto`): defaults ONLY when the launched command is the connected workflow's own tool binary on its matching provider route (connected via `compaction init`); a generic command never inherits an identity. `none` disables the default; an explicit tool always wins.")
    .option(
      "--subscription",
      "EXPLICIT keyless route for Claude Code under your saved login (Anthropic/Claude Code ONLY; default off). " +
        "Credential-free: your saved-login credential rides through UNTOUCHED - never read, stored, or logged. " +
        "Byte-safe; pinned to api.anthropic.com (no cross-origin redirects); fail-open (any failure runs the " +
        "original claude command unchanged). Not yet live-proven. Codex/ChatGPT subscription routing is " +
        "vendor-blocked and is rejected honestly."
    )
    .argument("[command...]", "The command to run through the gateway (after --), e.g. -- npm run dev")
    // Unknown flags BEFORE `--` are rejected (they used to be swallowed into the child command, producing
    // opaque child errors); everything AFTER `--` still reaches the wrapped tool verbatim. This message is
    // true ONLY of this command, which is why the command is attached with `addCommand` - see above.
    .configureOutput({
      outputError: (str, write) => {
        const unknown = /^error: unknown option '(.+)'\n?$/.exec(str);
        write(
          unknown
            ? `error: unknown option '${unknown[1]}' on compaction gateway run. Options go before '--'; everything after ` +
                `'--' is passed to the wrapped command verbatim. (Apply mode is:  --mode apply --policy ${DEDUPE_POLICY}.) ` +
                "See 'compaction gateway run --help'.\n"
            : str
        );
      }
    })
    .action(async (command: string[], options: RunThroughGatewayOptions) => {
      await runThroughGateway(command, options, "compaction gateway run");
    });

  gateway.addCommand(runCommand);

  gateway
    .command("activate")
    .description(
      "Print shell export lines that point THIS shell's provider base URL at the local gateway. Use:  " +
        "eval \"$(compaction gateway activate)\"  (OpenAI-compatible) or  eval \"$(compaction gateway activate " +
        "--provider anthropic)\"  (Claude Code). It only PRINTS - it never edits files or mutates your shell, " +
        "and it never attaches to a running process."
    )
    .option("--provider <name>", "Provider whose base-url env to print: openai (default) | anthropic (Claude Code).", "openai")
    .option("--listen <url>", "Gateway listen address to point at (default: the running gateway, else http://127.0.0.1:8787).")
    .action(async (options: { provider?: string; listen?: string }) => {
      const provider = options.provider ?? "openai";
      const status = await getGatewayStatus(process.cwd());
      let base: string;
      if (options.listen) {
        const l = parseListen(options.listen);
        base = `http://${l.host}:${l.port}`;
      } else if (status.running && status.base) {
        base = status.base;
      } else {
        base = "http://127.0.0.1:8787";
      }
      // Guidance to STDERR (not captured by eval); the exports go to STDOUT (captured by eval).
      console.error('# compaction gateway activate - apply to this shell with:  eval "$(compaction gateway activate)"');
      if (!(status.running && status.base) && !options.listen) {
        console.error("# note: no running gateway detected; start one with 'compaction gateway start' (these exports point at the default local address).");
      }
      console.error("# your provider API key stays in your shell - the gateway never reads or stores it.");
      // Provider-aware base-url env: OPENAI_BASE_URL/OPENAI_API_BASE (with /v1) for openai; ANTHROPIC_BASE_URL
      // (NO /v1, Claude Code appends /v1/messages itself) for anthropic. Base only, never a key.
      for (const [k, v] of Object.entries(injectionEnv(base, provider))) {
        console.log(`export ${k}=${v}`);
      }
    });

  gateway
    .command("configure")
    .description("Propose pointing this project's OpenAI base URL at the local gateway (approval-gated: shows a diff; writes nothing without --apply; backs up first; never overwrites an existing base URL without --force).")
    .option("--listen <url>", "Gateway listen address to route to (default: http://127.0.0.1:8787).", "http://127.0.0.1:8787")
    .option("--apply", "Actually write the change (creates a .bak backup first).")
    .option("--force", "Overwrite an existing provider base URL (only with --apply).")
    .action((options: { listen?: string; apply?: boolean; force?: boolean }) => {
      let listen;
      try {
        listen = parseListen(options.listen ?? "http://127.0.0.1:8787");
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const baseUrl = `http://${listen.host}:${listen.port}/v1`;
      const cwd = process.cwd();
      const plan = planGatewayConfigure(cwd, baseUrl);
      for (const line of formatConfigurePlan(plan)) console.log(line);
      if (!options.apply) return;
      const result = applyGatewayConfigure(cwd, plan, options.force ?? false);
      console.log("");
      if (result.wrote) {
        console.log(`compaction gateway configure: wrote ${result.targetFile}${result.backupFile ? ` (backup: ${result.backupFile})` : ""}.`);
        console.log("  restart your app so it picks up the new base URL, or run:  compaction gateway run -- <command>");
      } else {
        console.log(`compaction gateway configure: not written - ${result.reason}`);
        process.exitCode = 1;
      }
    });

  gateway
    .command("recover")
    .description("Recover the ORIGINAL request body that apply mode changed (retained locally under .compaction/gateway/recovery). Prints to stdout or writes to --out.")
    .argument("<recovery_id>", "The recovery_id shown on the apply receipt.")
    .option("--out <file>", "Write the original body to this file instead of stdout.")
    .action((recoveryId: string, options: { out?: string }) => {
      const rec = readRecovery(process.cwd(), recoveryId);
      if (!rec) {
        console.error(`compaction gateway recover: no retained original found for id '${recoveryId}' under ${GATEWAY_RECOVERY_DIR}.`);
        process.exitCode = 1;
        return;
      }
      if (options.out) {
        writeFileSync(options.out, rec.original_body, "utf8");
        console.error(`compaction gateway recover: wrote the original request body (${rec.endpoint}, policy ${rec.policy}, captured ${rec.captured_at}) to ${options.out}.`);
        return;
      }
      // The original body IS request content - it prints to stdout only on explicit recovery, never stored in a receipt.
      process.stdout.write(rec.original_body.endsWith("\n") ? rec.original_body : `${rec.original_body}\n`);
    });

  gateway
    .command("stop")
    .description("Stop a running local gateway (started in another terminal) via its pidfile.")
    .action(() => {
      const rec = readGatewayPid(process.cwd());
      if (!rec) {
        console.log("compaction gateway stop: no gateway pidfile found - nothing to stop.");
        return;
      }
      if (!isProcessAlive(rec.pid)) {
        removeGatewayPid(process.cwd());
        console.log(`compaction gateway stop: pid ${rec.pid} is not running - cleared the stale pidfile.`);
        return;
      }
      try {
        process.kill(rec.pid, "SIGTERM");
        console.log(`compaction gateway stop: sent SIGTERM to pid ${rec.pid} (${rec.host}:${rec.port}). It removes its own pidfile on exit.`);
      } catch (err) {
        console.error(`compaction gateway stop: could not signal pid ${rec.pid} - ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
