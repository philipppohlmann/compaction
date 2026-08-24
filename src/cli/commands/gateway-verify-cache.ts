/**
 * `compaction gateway verify-cache`, the OPERATOR-RUN LIVE provider cache-verification command (PUBLIC CLI).
 *
 * WHAT IT DOES: with the operator's OWN provider key present in the environment, it starts/reuses the local
 * Gateway in RECORD mode pointed at the real provider, issues TWO cheap requests under ONE proof-run id, a
 * COLD baseline and a WARM repeat with the SAME long static benign prefix so the provider serves part of the
 * input from its prompt cache, reads the resulting content-free receipts, runs the EXISTING proof math
 * (`proof.ts`), and records a content-free verification result (`verification-store.ts`). That record is what
 * flips `liveVerified` for the provider in `compaction gateway capabilities` (derived from real evidence).
 *
 * HARD RAILS:
 *  - The provider key is read from the operator ENV and rides through the gateway to the provider untouched.
 *    It is NEVER stored, logged, or printed by this command (we read only its PRESENCE and put the value on
 *    the outbound Authorization/x-api-key header).
 *  - NO key present → NO provider call is made; the command prints the concrete key-gate (env var + exact
 *    command + which flag flips) and exits non-zero with a distinct KEY-GATED code. So CI (no key) NEVER
 *    makes a live call and NEVER writes a verification record.
 *  - Live-verified is marked ONLY when BOTH receipts are provider-reported AND the provider reported cached
 *    input tokens AND a fresh-input reduction is derivable. Otherwise the result is honestly not-confirmed
 *    with a reason, NEVER a fabricated zero or pass.
 *  - The request prefix is a FIXED benign constant (no user/prompt content); receipts stay content-free.
 *  - No new dependency: the HTTP client is `node:http`/`node:https`.
 */
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { runGatewayStart, parseListen, type RunningGateway } from "./gateway.js";
import { readReceipts } from "../../core/gateway/status.js";
import {
  compareGatewayProof,
  formatGatewayProof,
  proofSummaryFromReceipt,
  receiptsForGatewayProof,
  type GatewayProofDelta
} from "../../core/gateway/proof.js";
import { writeVerification, type GatewayCacheVerification, type ProviderPricedCostImpact } from "../../core/gateway/verification-store.js";
import { computeApiCostImpact } from "../../core/gateway/api-cost-impact.js";
import { updateNetBilledCalibrationFromDelta } from "../../core/gateway/net-billed-calibration-store.js";

/** Distinct exit code when the command is key-gated (no provider key in the env), NOT a generic failure. */
export const VERIFY_CACHE_KEY_GATED_EXIT = 3;

/**
 * A FIXED, benign, content-free prefix, long enough to exceed provider prompt-cache minimums (~1024 tokens).
 * It is a constant, NOT user content: identical on both the cold and warm requests so the warm one is served
 * partly from the provider's prompt cache.
 */
const STATIC_PREFIX =
  "This is a fixed, benign Compaction cache-verification prefix. It carries no user or prompt content; " +
  "its only purpose is to exceed the provider prompt-cache minimum so the warm repeat is served partly from " +
  "the provider cache, which lets Compaction read a provider-reported cached-input count from a real receipt. "
    .repeat(90);

/** The trivial, fixed user turn (content-free constant). */
const USER_TURN = "Reply with the single word: ok";

interface ProviderSpec {
  /** Env vars that may hold the operator key, in priority order. */
  keyEnvVars: string[];
  /** The request path posted THROUGH the gateway (the gateway forwards the path authoritatively). */
  endpoint: string;
  /** Default upstream base for this provider (only its origin is used by the gateway). */
  defaultUpstream: string;
  /** A small/cheap default model. */
  defaultModel: string;
  /** Build the provider auth header(s) from the key. The value is NEVER logged/printed. */
  authHeaders: (key: string) => Record<string, string>;
  /** Build the (content-free, fixed-prefix) request body. Identical across variants. */
  body: (model: string) => string;
}

const PROVIDER_SPECS: Record<string, ProviderSpec> = {
  openai: {
    keyEnvVars: ["OPENAI_API_KEY", "OPENAI_KEY"],
    endpoint: "/v1/chat/completions",
    defaultUpstream: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
    body: (model) =>
      JSON.stringify({
        model,
        max_tokens: 16,
        messages: [
          { role: "system", content: STATIC_PREFIX },
          { role: "user", content: USER_TURN }
        ]
      })
  },
  anthropic: {
    keyEnvVars: ["ANTHROPIC_API_KEY"],
    endpoint: "/v1/messages",
    defaultUpstream: "https://api.anthropic.com",
    defaultModel: "claude-3-5-haiku-latest",
    authHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    // Anthropic prompt caching needs an explicit cache_control breakpoint on the (long) static system block.
    body: (model) =>
      JSON.stringify({
        model,
        max_tokens: 16,
        system: [{ type: "text", text: STATIC_PREFIX, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: USER_TURN }]
      })
  }
};

export interface VerifyCacheOptions {
  provider: string;
  upstream?: string;
  model?: string;
  listen?: string;
  json?: boolean;
  cwd?: string;
  /** Injectable for tests (default `process.env`). We read only PRESENCE + the value for the outbound header. */
  env?: NodeJS.ProcessEnv;
  /** Injectable gateway starter (default the real `runGatewayStart`). */
  startGateway?: (config: Parameters<typeof runGatewayStart>[0]) => Promise<RunningGateway>;
  /** Injectable HTTP client (default `node:http`/`node:https`). */
  httpRequest?: (
    url: string,
    opts: { method: string; headers?: Record<string, string> },
    body?: string
  ) => Promise<{ status: number; body: string }>;
  /** Injectable clock/id for deterministic tests. */
  now?: () => string;
  proofRunId?: string;
  /** Sink for human-readable lines (default console). */
  out?: (line: string) => void;
}

export interface VerifyCacheResult {
  keyGated: boolean;
  verified: boolean;
  exitCode: number;
  provider: string;
  proofRunId?: string;
  freshInputReductionPercent?: number;
  reason?: string;
  recordPath?: string;
}

/** Raw async node:http(s) client (never spawnSync - an in-worker fake upstream would deadlock). */
function defaultHttpRequest(
  url: string,
  opts: { method: string; headers?: Record<string, string> },
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === "http:" ? http : https;
    const req = client.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method,
        headers: opts.headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Poll the local receipts until BOTH paired receipts for a proof-run are present (bounded; never throws). */
async function waitForPairedReceipts(cwd: string, proofRunId: string, tries = 80, delayMs = 50): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    const paired = receiptsForGatewayProof(readReceipts(cwd), proofRunId);
    if (paired.baseline && paired.compacted) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** Resolve the operator key from the env for a provider - returns the value only (never logged). */
function resolveKey(spec: ProviderSpec, env: NodeJS.ProcessEnv): string | undefined {
  for (const name of spec.keyEnvVars) {
    const v = env[name];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/** The concrete key-gate block: the exact env var, the exact command, and exactly which flag flips. */
export function keyGateLines(provider: string, spec: ProviderSpec, upstream: string): string[] {
  const envVar = spec.keyEnvVars[0];
  return [
    "compaction gateway verify-cache: key-gated - no live verification was performed.",
    "  A LIVE cache verification calls the real provider, so it needs YOUR provider API key in the environment.",
    "  Compaction never stores, logs, or prints your key - it rides through the local gateway to the provider untouched.",
    "",
    `  Required env var:  ${envVar}   (provider: ${provider})`,
    `  Run:               ${envVar}=... compaction gateway verify-cache --provider ${provider} --upstream ${upstream}`,
    `  On success:        flips liveVerified:true for provider '${provider}' in \`compaction gateway capabilities\` (derived from the recorded content-free verification; no key or content is stored).`,
    "",
    "  No provider call was made and no verification record was written."
  ];
}

/** Decide live-verified from the proof delta, TRUE only on real provider-reported cache + a real reduction. */
function decideVerified(delta: GatewayProofDelta): { verified: boolean; reason?: string } {
  const cached = delta.afterCachedTokens;
  const abs = delta.freshInputReductionAbsolute;
  const pct = delta.freshInputReductionPercent;
  if (
    delta.available &&
    typeof cached === "number" &&
    cached > 0 &&
    typeof abs === "number" &&
    abs > 0 &&
    typeof pct === "number"
  ) {
    return { verified: true };
  }
  // Honest not-confirmed reason, never a fabricated zero/pass.
  if (delta.reasons.length > 0) {
    return { verified: false, reason: `no provider-reported cache observed - live verification not confirmed: ${delta.reasons.join("; ")}` };
  }
  if (typeof cached === "number" && cached === 0) {
    return {
      verified: false,
      reason:
        "no provider-reported cache observed - live verification not confirmed: the warm request reported 0 cached input tokens (the provider served nothing from its prompt cache)."
    };
  }
  return {
    verified: false,
    reason:
      "no provider-reported cache observed - live verification not confirmed: no fresh-input reduction was derivable from the two receipts."
  };
}

/**
 * Run the operator LIVE cache verification. Terminal-safe: prints a content-free result and returns an exit
 * code (the caller sets `process.exitCode`). Makes NO provider call when the key is absent.
 */
export async function runVerifyCache(options: VerifyCacheOptions): Promise<VerifyCacheResult> {
  const out = options.out ?? ((line: string) => console.log(line));
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const provider = options.provider;
  const spec = PROVIDER_SPECS[provider];
  if (!spec) {
    out(`compaction gateway verify-cache: unsupported provider '${provider}' (supported: ${Object.keys(PROVIDER_SPECS).join(", ")}).`);
    return { keyGated: false, verified: false, exitCode: 1, provider };
  }
  const upstream = options.upstream ?? spec.defaultUpstream;
  const model = options.model ?? spec.defaultModel;

  // --- KEY GATE: no key → no call, no record, distinct non-zero exit. --------------------------------------
  const key = resolveKey(spec, env);
  if (!key) {
    const lines = keyGateLines(provider, spec, upstream);
    if (options.json) {
      out(JSON.stringify({ provider, keyGated: true, verified: false, requiredEnvVar: spec.keyEnvVars[0], upstream }, null, 2));
    } else {
      for (const l of lines) out(l);
    }
    return { keyGated: true, verified: false, exitCode: VERIFY_CACHE_KEY_GATED_EXIT, provider };
  }

  // --- LIVE: start a local gateway (record mode), issue cold + warm, read receipts, run proof math. --------
  const proofRunId = options.proofRunId ?? `verify-${provider}-${randomUUID()}`;
  const startGateway = options.startGateway ?? runGatewayStart;
  const httpRequest = options.httpRequest ?? defaultHttpRequest;
  const listenPort = options.listen ? parseListen(options.listen).port : 0; // 0 → ephemeral

  let gateway: RunningGateway;
  try {
    gateway = await startGateway({ provider, upstream, mode: "record", host: "127.0.0.1", port: listenPort, cwd, installSignals: false, log: () => {} });
  } catch (err) {
    out(`compaction gateway verify-cache: could not start a local gateway - ${(err as Error).message}`);
    return { keyGated: false, verified: false, exitCode: 1, provider };
  }

  const send = (variant: "baseline" | "compacted"): Promise<{ status: number; body: string }> =>
    httpRequest(
      `${gateway.base}${spec.endpoint}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...spec.authHeaders(key), // the operator key rides through - never logged/printed by us
          "x-compaction-proof-run": proofRunId,
          "x-compaction-proof-variant": variant
        }
      },
      spec.body(model)
    );

  let upstreamError: string | undefined;
  try {
    await send("baseline"); // COLD
    await send("compacted"); // WARM - same static prefix → provider serves part of the input from cache
    // The gateway appends its content-free receipt asynchronously (best-effort, after the upstream response
    // ends) - poll until BOTH paired receipts have landed (bounded) before running the proof math.
    await waitForPairedReceipts(cwd, proofRunId);
  } catch (err) {
    upstreamError = (err as Error).message;
  } finally {
    try {
      await gateway.close();
    } catch {
      /* best-effort */
    }
  }

  // Pair the two content-free receipts by the unique proof-run id and run the existing proof math.
  const paired = receiptsForGatewayProof(readReceipts(cwd), proofRunId);
  const delta = compareGatewayProof({
    proofRunId,
    ...(paired.baseline ? { baseline: proofSummaryFromReceipt(paired.baseline) } : {}),
    ...(paired.compacted ? { compacted: proofSummaryFromReceipt(paired.compacted) } : {})
  });
  const decision = decideVerified(delta);
  const verified = decision.verified;
  const reason = verified
    ? undefined
    : upstreamError
      ? `no provider-reported cache observed - live verification not confirmed: the provider request failed (${upstreamError}).`
      : decision.reason;

  // ROUTE B (api-billing): when BOTH content-free receipts carry provider-reported usage + the model is
  // priced, compute the provider-priced API cost impact (an ESTIMATE basis, NEVER invoice-confirmed) and
  // attach it content-free (numbers + a version string + labels - no key, no content). Never a fabricated
  // zero: when unavailable, `computeApiCostImpact` returns an unavailable result and nothing is attached.
  let costImpact: ProviderPricedCostImpact | undefined;
  if (paired.baseline && paired.compacted) {
    const impact = computeApiCostImpact({ baseline: paired.baseline, warm: paired.compacted, requestModel: model });
    if (
      impact.cost_basis === "provider-usage-and-published-price" &&
      impact.proof_level === "provider-priced-api" &&
      typeof impact.baseline_cost_usd === "number" &&
      typeof impact.warm_cost_usd === "number" &&
      typeof impact.provider_priced_api_cost_impact_usd === "number" &&
      typeof impact.provider_priced_api_cost_impact_pct === "number"
    ) {
      costImpact = {
        baseline_usd: impact.baseline_cost_usd,
        warm_usd: impact.warm_cost_usd,
        delta_usd: impact.provider_priced_api_cost_impact_usd,
        delta_pct: impact.provider_priced_api_cost_impact_pct,
        pricing_version: impact.pricing_version,
        cost_basis: impact.cost_basis,
        proof_level: impact.proof_level
      };
    }
  }

  // Record ONE content-free result (pass OR fail). Never on the key-gate path.
  const record: GatewayCacheVerification = {
    provider,
    proof_run_id: proofRunId,
    verified,
    ...(verified && typeof delta.freshInputReductionPercent === "number"
      ? { fresh_input_reduction_percent: delta.freshInputReductionPercent }
      : {}),
    observed_at: (options.now ?? (() => new Date().toISOString()))(),
    ...(reason ? { reason } : {}),
    ...(costImpact ? { provider_priced_cost_impact: costImpact } : {})
  };
  const recordPath = writeVerification(record, cwd);

  // NET-BILLED calibration: fold this A/B's proof delta (baseline vs compacted provider-reported FRESH-billed
  // input) into the local net-billed store so `compaction savings` can surface a provider-CONFIRMED
  // net-of-cache figure. Only a real, both-arms-provider-reported delta contributes (a non-measured A/B is a
  // no-op inside the fold), and a NEGATIVE/zero net delta (cache-bust) is accumulated with its true sign, not
  // floored. Content-free + best-effort: a local store IO error never fails the verification command. The
  // store writes under COMPACTION_CONFIG_DIR (the operator env) so it is queryable by `compaction savings`.
  try {
    await updateNetBilledCalibrationFromDelta({ proofRunId, delta }, env);
  } catch {
    // Best-effort: the net-billed learning update never breaks the verification result.
  }

  // --- Report (content-free). -----------------------------------------------------------------------------
  const result: VerifyCacheResult = {
    keyGated: false,
    verified,
    exitCode: 0,
    provider,
    proofRunId,
    ...(verified && typeof delta.freshInputReductionPercent === "number"
      ? { freshInputReductionPercent: delta.freshInputReductionPercent }
      : {}),
    ...(reason ? { reason } : {}),
    recordPath
  };

  if (options.json) {
    out(
      JSON.stringify(
        {
          provider,
          proofRunId,
          verified,
          ...(verified && typeof delta.freshInputReductionPercent === "number"
            ? { freshInputReductionPercent: delta.freshInputReductionPercent }
            : {}),
          ...(reason ? { reason } : {}),
          recordPath,
          proof: {
            available: delta.available,
            baselineFound: delta.baselineFound,
            compactedFound: delta.compactedFound,
            ...(delta.beforeFreshInputTokens !== undefined ? { beforeFreshInputTokens: delta.beforeFreshInputTokens } : {}),
            ...(delta.afterFreshInputTokens !== undefined ? { afterFreshInputTokens: delta.afterFreshInputTokens } : {}),
            ...(delta.afterCachedTokens !== undefined ? { afterCachedTokens: delta.afterCachedTokens } : {})
          }
        },
        null,
        2
      )
    );
    return result;
  }

  out("compaction gateway verify-cache - LIVE provider cache verification");
  out(`  provider:            ${provider}`);
  out(`  upstream:            ${upstream}`);
  out(`  proof run:           ${proofRunId}`);
  out("");
  out(formatGatewayProof(delta));
  out("");
  out(`  live-verified:       ${verified ? "yes" : "no"}`);
  if (reason) out(`  reason:              ${reason}`);
  out(`  recorded:            ${recordPath}   (content-free: provider, proof-run id, boolean, percent, timestamp - no key, no content)`);
  if (verified) {
    out(`  → flips liveVerified:true for provider '${provider}' in 'compaction gateway capabilities'.`);
  }
  return result;
}
