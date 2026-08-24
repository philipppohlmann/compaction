import chalk from "chalk";
import { Command } from "commander";
import {
  ApiTransportError,
  apiStatus,
  healthCheckConfig,
  isLocalDevUrl,
  maskKey,
  resolveTarget,
  urlHost,
  writePersistedConfig,
  type EnvLike,
  type ResolvedTarget
} from "../../core/api-client/index.js";
import { collectReadinessReport, renderReadinessReport } from "./readiness.js";
import { allowanceNoticeInput, lastReceiptLines } from "./watch.js";
import type { AllowancePauseReason } from "../../core/upgrade-cta.js";
import { upgradeNoticeLines } from "../../core/gateway/receipt-line.js";
import {
  resolveOpenTier,
  readProductMode,
  type AllowancePauseScope,
  type ProductMode
} from "../../core/onboarding-preferences.js";
import { readStoredCredentials } from "../../core/auth/credentials.js";
import { readLeaseVerdict, type LeaseVerdictLabel } from "../../core/entitlement/lease-store.js";
import { engineAvailability, type EngineAvailability } from "../../core/engine-availability.js";

/** How many recent per-turn receipt lines `compaction status` shows in its "Last turns" section. */
export const STATUS_LAST_TURNS = 3;

/**
 * `compaction upgrade` + `compaction status`.
 *
 * `status` is the single readiness surface: the local, read-only, content-free readiness report
 * (detected tools + connect status, gateway health, storage, credential PRESENCE, stored
 * authorizations, what routes vs measures, next commands, see `readiness.ts`) followed by the
 * hosted-endpoint section (whether a hosted endpoint is configured + a live reachability check).
 * `status` always exits 0 and creates no file.
 *
 * HONESTY / HARD RAILS:
 *  - The default URL is the PRODUCTION origin. The graceful refusal below is now reached only when
 *    the target is the LOOPBACK dev origin, where there is genuinely nothing to validate against;
 *    it still prints the exact `NO_LIVE_ENDPOINT_MESSAGE` and never pretends any remote is live.
 *    (That message's wording predates a live production endpoint and reads oddly for a loopback
 *    target — a copy decision, deliberately not changed here.)
 *  - The API key is validated against `GET <url>/v0/status` with a short timeout. Config is
 *    persisted (0600) ONLY on a 200. A 401 fails CLOSED and persists nothing. Transport/timeout/
 *    other failures persist nothing.
 *  - The full API key is NEVER printed, logged, or written anywhere except the 0600 config file.
 *    Every user-facing surface shows `maskKey(...)` only.
 */

/**
 * EXACT graceful-failure message for a `--key` with no private endpoint configured. Printed
 * verbatim (no color wrapping) so it is byte-stable regardless of TTY.
 */
export const NO_LIVE_ENDPOINT_MESSAGE =
  "no public hosted Compaction endpoint is live yet; hosted access is private-beta; pass `--api-url <url>` (private-beta/staging/self-hosted) or set `COMPACTION_API_URL`.";

type HealthResult =
  | { kind: "ok" }
  | { kind: "unauthorized" }
  | { kind: "http-error"; status: number }
  | { kind: "unreachable"; reason: string };

/**
 * Live health check via the shared api-client (`GET /v0/status`, Bearer key attached by the client,
 * bounded timeout). Never leaks the key: the returned reason is our own concise string, never the
 * raw request/headers.
 */
async function healthCheck(target: ResolvedTarget): Promise<HealthResult> {
  try {
    const res = await apiStatus(healthCheckConfig(target));
    if (res.ok) return { kind: "ok" };
    if (res.status === 401) return { kind: "unauthorized" };
    return { kind: "http-error", status: res.status };
  } catch (err) {
    // ApiTransportError's message contains the URL (never the key); we still surface only a concise
    // reason so nothing incidental leaks.
    return {
      kind: "unreachable",
      reason: err instanceof ApiTransportError ? "transport error or timeout" : "unexpected error"
    };
  }
}

/**
 * Run `compaction upgrade`. Validates a key against a configured private endpoint and persists
 * `{api_url, api_key}` (0600) ONLY on success. Sets a non-zero exit code on every failure path and
 * persists NOTHING on any failure. Never prints/logs the key (masked only).
 */
export async function runUpgrade(opts: { key?: string; apiUrl?: string; env?: EnvLike }): Promise<void> {
  const env = opts.env ?? process.env;
  const target = resolveTarget({ flagUrl: opts.apiUrl, flagKey: opts.key, env });

  console.log(chalk.cyan("compaction upgrade"));

  if (!target.apiKey) {
    console.error(
      chalk.red("hosted upgrade needs an API key: pass --key <key> or set COMPACTION_API_KEY. Nothing was saved.")
    );
    process.exitCode = 1;
    return;
  }

  // Key present, but the target is the LOOPBACK dev origin → no hosted endpoint to validate against.
  // Fail gracefully; persist NOTHING. Printed verbatim (no chalk) for a byte-stable exact message.
  //
  // This tests the LOCAL constant, never `DEFAULT_API_URL`. The default is now the production origin,
  // so a `=== DEFAULT_API_URL` test would refuse exactly the endpoint a fresh install is meant to
  // connect to.
  if (isLocalDevUrl(target.url)) {
    console.error(NO_LIVE_ENDPOINT_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const host = urlHost(target.url);
  console.log(`Validating the API key against ${host} …`); // host only; never the key
  const health = await healthCheck(target);

  switch (health.kind) {
    case "ok": {
      const path = writePersistedConfig({ api_url: target.url, api_key: target.apiKey }, env);
      console.log(chalk.green("Hosted upgrade configured (endpoint reachable, key accepted)."));
      console.log(`  Endpoint: ${host}`);
      console.log(`  API key:  ${maskKey(target.apiKey)} (masked; the full key is saved only to the local 0600 config)`);
      console.log(`  Saved to: ${path} (mode 0600)`);
      console.log("Mode: private beta (hosted). Run `compaction status` to re-check reachability any time.");
      return;
    }
    case "unauthorized":
      console.error(
        chalk.red("hosted upgrade failed: the endpoint rejected this API key (HTTP 401). Nothing was saved.")
      );
      process.exitCode = 1;
      return;
    case "http-error":
      console.error(
        chalk.red(`hosted upgrade failed: the endpoint returned HTTP ${health.status}. Nothing was saved.`)
      );
      process.exitCode = 1;
      return;
    case "unreachable":
      console.error(
        chalk.red(`hosted upgrade failed: could not reach ${host} (${health.reason}). Nothing was saved.`)
      );
      process.exitCode = 1;
      return;
  }
}

/**
 * Render the "Last turns" section: up to the last `STATUS_LAST_TURNS` per-turn receipt lines, each the
 * SAME canonical content-free line `compaction watch` prints (counts/labels/estimate/short id - never
 * content). Fail-open by construction:
 *  - kill switch (`COMPACTION_RECEIPT_LINE=0`) set → the section is OMITTED entirely (the user chose silence);
 *  - no receipts yet (missing/empty store) → the honest "no turns recorded yet" line, never an error.
 */
function renderLastTurnsSection(
  lastTurns: { lines: string[]; killSwitch: boolean },
  notice?: { reason: AllowancePauseReason; resetsOn?: string; scope?: AllowancePauseScope }
): string[] {
  if (lastTurns.killSwitch) return []; // COMPACTION_RECEIPT_LINE=0 → omit the section entirely.
  const out = [`Last turns (most recent ${STATUS_LAST_TURNS}, content-free - same line as \`compaction watch\`)`];
  // Session state, said once above the lines: these lines are HISTORICAL, and a turn recorded before
  // the allowance ran out was not refused for allowance.
  //
  // BOTH REASONS, resolved by `allowanceNoticeInput` (the same resolver `watch` uses, so the two
  // surfaces cannot disagree). This used to read the session-level resolver directly, which fires on
  // `remaining <= 0` alone — so a user being paused at every turn for want of ENOUGH allowance, rather
  // than any, got no statement here at all while the lines below them all read `input paused`.
  if (notice) {
    for (const line of upgradeNoticeLines(notice)) out.push(line === "" ? "" : `  ${line}`);
  }
  if (lastTurns.lines.length === 0) {
    out.push("  no turns recorded yet - route a session through the local Gateway to produce some (compaction watch)");
    return out;
  }
  for (const line of lastTurns.lines) out.push(`  ${line}`);
  return out;
}

/**
 * `Account & access` section copy — fixed wording, verbatim. Kept as named constants so the
 * exact user-facing contract lives in one place, separate from the render logic, and so guard tests
 * reference the same string the surface prints. These are the whole user-facing contract for this
 * section — do not add marketing claims beyond them, and do not paraphrase.
 */
export const ACCOUNT_ACCESS_HEADING = "Account & access";
export const SET_UP_COMMUNITY_REMEDY = "Run compaction to set up Community.";
export const RESTORE_COMMUNITY_REMEDY = "Run compaction to restore Community access.";
export const COMPACTION_ACTIVE_FOOTER = "Compaction is active.";

/**
 * The content-free account + entitlement + engine snapshot behind the `Account & access` section,
 * read from LOCAL disk ONLY (credentials file, signed lease, stored product mode, engine resolution)
 * — no network, reusing the SAME pure readers the gateway/receipt-line use so `status` can never
 * disagree with them (F55). It surfaces the state a set-up device ALREADY holds so `status` can no
 * longer describe an entitled device as unconfigured / "local-only" (F52).
 *
 * PRIVACY (load-bearing): the account is reduced to a boolean `connected` here — the account id, the
 * email, and the device token are NEVER carried on this snapshot, so no identifier can reach the
 * human render path. The device token is never read for any purpose. Raw identifiers live only on the
 * separate `--json` object, which is the sanctioned diagnostic surface.
 */
interface AccountAccessState {
  /** Credentials file present (presence only — never account id / email / token). Drives the Account line. */
  connected: boolean;
  /** A signed entitlement lease verifies as VALID on THIS device (current period, not expired). */
  entitled: boolean;
  /** Valid lease verified against the explicit DEV trust root — surfaced loudly, never omitted. */
  communityDevSigned: boolean;
  /** The clamped effective tier (the SAME clamp the gateway apply gate reads). Drives the Optimization line. */
  tier: "observe" | "basic" | "full";
  /** An engine actually resolves and verifies on this machine. Drives the Engine line. */
  engineReady: boolean;
}

/**
 * Collect the `Account & access` state. `tier` is INJECTED from the one `resolveOpenTier` call
 * `runStatus` already makes, so the rendered posture and the allowance notice can never come from two
 * different clamp evaluations. Engine availability is resolved once here (async — the engine probe is
 * reached through the sanctioned dynamic-import seam) and reused by the human and JSON paths.
 */
async function collectAccountAccess(
  env: EnvLike,
  tier: "observe" | "basic" | "full"
): Promise<AccountAccessState> {
  // Truthiness only: the parsed credentials are never propagated, so no identifier can reach a render path.
  const connected = readStoredCredentials(env) !== undefined;
  const verdict = readLeaseVerdict(env);
  const engine = await engineAvailability(env as NodeJS.ProcessEnv);
  return {
    connected,
    entitled: verdict.label === "lease-valid",
    communityDevSigned: verdict.label === "lease-valid" && verdict.trust === "dev-lease-root",
    tier,
    engineReady: engine === "present"
  };
}

/**
 * Render the `Account & access` section. Every branch below is a decided rule, not a choice:
 *  - Account: presence only, never the id/token; absent → the set-up remedy on the next line.
 *  - Plan: user-facing vocabulary is ONLY `Community` (entitled) or `Open` (not entitled) — never a
 *    raw product_mode string.
 *  - Community: `active` (valid), `active (DEV-SIGNED)` (dev-signed valid), or `needs activation` +
 *    the restore remedy when signed in with no currently-valid access. Omitted when not connected
 *    (a device that is not signed in cannot "need activation").
 *  - Optimization: the posture, shown SEPARATELY from the plan — `Full`/`Basic`, and OMITTED for
 *    observe/none (no posture claim off a bare intent).
 *  - Engine: `ready` only when an engine actually resolves; otherwise omitted.
 *  - Footer: only when fully set up (connected AND Community active AND engine ready).
 */
function renderAccountAccessSection(s: AccountAccessState): string[] {
  const lines: string[] = [ACCOUNT_ACCESS_HEADING];

  if (s.connected) {
    lines.push("Account: connected");
  } else {
    lines.push("Account: not connected");
    lines.push(SET_UP_COMMUNITY_REMEDY);
  }

  lines.push(s.entitled ? "Plan: Community" : "Plan: Open");

  if (s.entitled) {
    lines.push(s.communityDevSigned ? "Community: active (DEV-SIGNED)" : "Community: active");
  } else if (s.connected) {
    lines.push("Community: needs activation");
    lines.push(RESTORE_COMMUNITY_REMEDY);
  }

  if (s.tier === "full") lines.push("Optimization: Full");
  else if (s.tier === "basic") lines.push("Optimization: Basic");

  if (s.engineReady) lines.push("Engine: ready");

  // Footer only when the device is fully set up AND the effective posture is `full` — the healthy
  // state that pairs with `Optimization: Full`. Gating on `full` (not merely
  // entitled) prevents an `observe`/`basic` device — which the gateway deliberately keeps record-only
  // — from claiming `Compaction is active.` (the turn is not being optimized).
  if (s.connected && s.entitled && s.engineReady && s.tier === "full") {
    lines.push("");
    lines.push(COMPACTION_ACTIVE_FOOTER);
  }
  return lines;
}

/**
 * Account/entitlement STATE for the `--json` diagnostic surface. Presence + entitlement state only —
 * NO identifiers. The contract requires presence/state
 * without identifiers, and `--json` is routinely saved or pasted into support reports, so the raw
 * account ID and email are deliberately NOT emitted (nor, ever, the device token). Every field here is
 * an enum/boolean state, not an identity value.
 */
interface AccountAccessJson {
  account: { connected: boolean };
  entitlement: {
    lease: LeaseVerdictLabel;
    trust?: "pinned-lease-root" | "dev-lease-root";
    periodId?: string;
    productMode: ProductMode;
    effectiveTier: "observe" | "basic" | "full";
    engine: EngineAvailability;
  };
}

async function collectAccountAccessJson(
  env: EnvLike,
  tier: "observe" | "basic" | "full"
): Promise<AccountAccessJson> {
  const creds = readStoredCredentials(env);
  const verdict = readLeaseVerdict(env);
  const engine = await engineAvailability(env as NodeJS.ProcessEnv);
  return {
    // Presence only — the account ID, email, and device token are never read into this surface.
    account: { connected: creds !== undefined },
    entitlement: {
      lease: verdict.label,
      ...(verdict.trust ? { trust: verdict.trust } : {}),
      ...(verdict.periodId ? { periodId: verdict.periodId } : {}),
      productMode: readProductMode(env),
      effectiveTier: tier,
      engine
    }
  };
}

/** Content-free hosted-endpoint section of the report - host + reachability only, NEVER a key. */
type HostedSection =
  | { configured: false; mode: "local-only" }
  | { configured: true; host: string; reachable: boolean; reason?: string; mode: "private-beta-hosted" };

function hostedReasonLine(health: HealthResult): string {
  switch (health.kind) {
    case "ok":
      return "reachable";
    case "unauthorized":
      return "unreachable (endpoint returned HTTP 401 - key may be invalid)";
    case "http-error":
      return `unreachable (endpoint returned HTTP ${health.status})`;
    case "unreachable":
      return `unreachable (${health.reason})`;
  }
}

/**
 * Run `compaction status`. Prints the local readiness report (read-only, content-free,
 * presence-only credentials), the last per-turn receipt lines, and the `Account & access` section:
 * the account/plan/entitlement/optimization/engine state this device ALREADY holds, read from local
 * disk only (F52/F55). When a private-beta HOSTED endpoint is deliberately configured, the hosted
 * reachability diagnostic is appended (masked key + host + a LIVE reachability re-check; capabilities
 * shown ONLY when reachable). Never prints the account id, the device token, or the API key on the
 * human path. Always exits 0.
 */
export async function runStatus(
  opts: { env?: EnvLike; version?: string; json?: boolean; projectsDir?: string; checkCodex?: boolean } = {}
): Promise<void> {
  const env = opts.env ?? process.env;
  const version = opts.version ?? "unknown";
  // `checkCodex` is the ONLY thing that lets this command start another program. Default off, because
  // the report's headline promise is read-only/no-network and Codex's app-server is neither
  // (`ReadinessOptions.probeCodexTrust`).
  const report = await collectReadinessReport(process.cwd(), env as NodeJS.ProcessEnv, opts.projectsDir, {
    probeCodexTrust: opts.checkCodex === true
  });
  // The last few per-turn receipt lines, rendered via the SAME canonical formatter `watch` uses (no
  // duplicate formatting). Read-only, content-free, kill-switch-aware, fail-open (empty store → no lines).
  const lastTurns = await lastReceiptLines(STATUS_LAST_TURNS, { cwd: process.cwd(), env: env as NodeJS.ProcessEnv });
  // The ceiling is a STATE fact, not a property of any replayed line (see `renderLastTurnsSection`).
  // `tier` is the ONE clamp the `Account & access` posture and the allowance notice both read.
  const { tier, allowanceResetsOn, allowancePauseScope } = await resolveOpenTier(env);
  const target = resolveTarget({ env });
  const configured = target.apiKey !== undefined && !isLocalDevUrl(target.url);
  const health = configured ? await healthCheck(target) : undefined;

  if (opts.json) {
    const hosted: HostedSection =
      configured && health
        ? {
            configured: true,
            host: urlHost(target.url),
            reachable: health.kind === "ok",
            ...(health.kind === "ok" ? {} : { reason: hostedReasonLine(health) }),
            mode: "private-beta-hosted"
          }
        : { configured: false, mode: "local-only" };
    // Raw account/entitlement facts live ONLY on this diagnostic surface (rule 8); the device token
    // is never serialized (the snapshot never reads it).
    const accountAccess = await collectAccountAccessJson(env, tier);
    console.log(
      JSON.stringify(
        {
          ...report,
          localCoreVersion: version,
          lastTurns: { killSwitch: lastTurns.killSwitch, lines: lastTurns.lines },
          ...accountAccess,
          hosted
        },
        null,
        2
      )
    );
    return;
  }

  console.log(renderReadinessReport(report));
  console.log("");
  for (const line of renderLastTurnsSection(lastTurns, await allowanceNoticeInput(env, process.cwd()))) console.log(line);
  console.log("");
  const accountAccess = await collectAccountAccess(env, tier);
  for (const line of renderAccountAccessSection(accountAccess)) console.log(line);

  // INVARIANT: with no hosted endpoint configured (the common case), the `Account & access` section
  // above is the WHOLE state surface — an entitled device is not "local-only", and endpoint
  // terminology / hosted-connect advice never appear on the normal human path (raw hosted facts live
  // only under `--json`).
  if (!configured || !health) return;

  // A private-beta endpoint IS deliberately configured: the reachability diagnostic below is the one
  // human surface where endpoint terminology is a real, user-requested fact rather than a misdirection.
  console.log("");
  console.log("Hosted endpoint");
  console.log(`  Local core: enabled (compaction v${version})`);
  const host = urlHost(target.url);
  console.log(`  Hosted API: configured - ${host} · key ${maskKey(target.apiKey)}`);
  console.log(`  Reachability: ${hostedReasonLine(health)}`);
  console.log("  Mode: private beta (hosted)");

  if (health.kind === "ok") {
    console.log(
      "  Capabilities (unlocked by the hosted tier): hosted optimize · hosted evaluate · report sync · " +
        "policy-managed auto-apply - unlocked by the hosted tier (not individually confirmed live here)."
    );
  }
}

/**
 * `compaction api connect` — the hosted/private-beta endpoint connection.
 *
 * RENAMED from `compaction upgrade` (2026-08-03). That name was claimed earlier (2026-07-04) when
 * "upgrade" meant "connect to our hosted API with a key", and it predates the commercial-boundary
 * program entirely. Under the tier model that shipped since — Open → Community → Pro, reached by a free
 * account and an entitlement lease — a user typing `compaction upgrade` means "raise my plan", not
 * "save an API key for a private-beta endpoint that is not live". The name now goes to the thing users
 * mean, and this keeps the capability under the `api` namespace where it belongs.
 *
 * The old spelling still works: it forwards here with a deprecation notice rather than breaking a
 * private-beta user mid-flow.
 */
export function registerApiConnectCommand(apiCommand: Command): void {
  apiCommand
    .command("connect")
    .description("Connect the CLI to a private-beta / self-hosted Compaction endpoint (validate + save an API key).")
    .option("--key <key>", "API key for the hosted endpoint (or set COMPACTION_API_KEY)")
    .option("--api-url <url>", "Hosted endpoint base URL - advanced (or set COMPACTION_API_URL)")
    .action(async (options: { key?: string; apiUrl?: string }) => {
      await runUpgrade({ key: options.key, apiUrl: options.apiUrl });
    });
}

/**
 * BACK-COMPAT: `compaction upgrade --key <key>` keeps working and forwards to `api connect`. Without a
 * key it is the CONVERSION surface (`compaction pro`), which is what the word means to a user today.
 * The discriminator is the flag, so no existing scripted invocation changes behavior.
 */
export function registerLegacyUpgradeAlias(program: Command, onPlanUpgrade: () => Promise<void>): void {
  program
    .command("upgrade")
    .description("Raise your plan (same as `compaction pro`). With --key: connect a private-beta endpoint (deprecated, use `compaction api connect`).")
    .option("--key <key>", "API key for a private-beta/self-hosted endpoint (DEPRECATED: use `compaction api connect`)")
    .option("--api-url <url>", "Hosted endpoint base URL - advanced (or set COMPACTION_API_URL)")
    .action(async (options: { key?: string; apiUrl?: string }) => {
      const wantsHostedConnect = options.key !== undefined || options.apiUrl !== undefined;
      if (!wantsHostedConnect) {
        await onPlanUpgrade();
        return;
      }
      console.log(
        chalk.dim("  Note: `compaction upgrade --key` is now `compaction api connect`. Forwarding; the old spelling still works.")
      );
      await runUpgrade({ key: options.key, apiUrl: options.apiUrl });
    });
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description(
      "Readiness report: detected tools + connect status, gateway health, storage, credential " +
        "PRESENCE (set/unset only - never values), stored auto-apply authorizations, what routes vs " +
        "measures-only, the exact next commands, and whether a hosted endpoint is configured + " +
        "reachable. Local, read-only, content-free; always exits 0."
    )
    .option("--json", "Print the content-free report as JSON.")
    .option("--projects-dir <dir>", "Claude Code projects directory to detect against (default: the standard local location)")
    .option(
      "--check-codex",
      "Ask Codex directly whether it will run Compaction's shaping hook (its one-time hook trust). " +
        "OFF by default because, WHEN A CODEX SHAPING HOOK IS CONFIGURED, this STARTS CODEX briefly, " +
        "and Codex writes to its own home and refreshes its model catalogue over the network - which " +
        "the rest of this command never does. With no such hook configured nothing is started."
    )
    .action(async (options: { json?: boolean; projectsDir?: string; checkCodex?: boolean }) => {
      await runStatus({
        version: program.version() ?? "unknown",
        json: options.json,
        projectsDir: options.projectsDir,
        checkCodex: options.checkCodex
      });
    });
}
