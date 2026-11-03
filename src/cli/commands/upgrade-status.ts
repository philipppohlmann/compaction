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
import {
  collectReadinessReport,
  managedLauncherShadowed,
  managedUpdateLabel,
  renderReadinessReport,
  type ReadinessReport
} from "./readiness.js";
import { allowanceNoticeInput, lastReceiptLines } from "./watch.js";
import type { AllowancePauseReason } from "../../core/upgrade-cta.js";
import { upgradeNoticeLines } from "../../core/gateway/receipt-line.js";
import {
  resolveOpenTier,
  readProductMode,
  readConnectedWorkflows,
  type AllowancePauseScope,
  type ProductMode
} from "../../core/onboarding-preferences.js";
import { pendingFullApplyGate } from "./full-apply-gate.js";
import { isShapingStopped } from "../../core/subscription-shaping-state.js";
import { listRoutingSlots } from "../../core/gateway/routing-registry.js";
import { isProcessAlive } from "../../core/gateway/status.js";
import { APPLY_ROUTING_PROVIDER } from "../../core/gateway/apply-routing-activation.js";
import { readStoredCredentials } from "../../core/auth/credentials.js";
import {
  leaseNeedsRenewal,
  readLeaseVerdict,
  type LeaseVerdictLabel
} from "../../core/entitlement/lease-store.js";
import {
  engineAvailability,
  engineInputCompaction,
  resolvedEngineVersion,
  type EngineAvailability,
  type EngineInputCompaction
} from "../../core/engine-availability.js";

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
/** Signed in, lease missing/expired, and silent renew could not restore authorization. */
export const REFRESH_COMMUNITY_REMEDY =
  "Community authorization could not be refreshed automatically. Check the network, then run compaction status again.";
/** Server authoritatively denied Community for this device/account. */
export const COMMUNITY_DENIED_REMEDY =
  "This device is no longer entitled to Community. Sign in again with `compaction login`, or continue on Open.";
export const COMPACTION_ACTIVE_FOOTER = "Compaction is active.";
/**
 * Printed beneath the footer while a plain (`--workflow none`) routing gateway is still alive. The route
 * is fixed when a tool session launches, so a session that started before this device was ready stays
 * on that gateway; the footer describes the DEVICE and must not read as an upgrade of that session.
 * Vocabulary is the running gateway's own one-time log line.
 */
export const RECORD_ONLY_SESSION_NOTE =
  "A tool session started before this was ready stays record-only for input; a new tool session re-evaluates routing.";

/**
 * THE LINE THAT WOULD HAVE SHOWN THE OUTAGE. Printed only when the resolved engine's SIGNED manifest
 * declares a meter unit this client cannot place — a state in which the gateway forwards every
 * request unchanged no matter how much it could have compacted.
 *
 * Both sentences are deliberately narrow. The first states what is off and why, in the engine's own
 * terms, without naming a unit string at a user. The second does NOT promise that a compatible engine
 * exists to install — at the time of writing none had been published — because a remedy that cannot
 * work is worse than none; it says what the command does WHEN one is published, and states the
 * capability the user still has.
 */
export const INPUT_COMPACTION_UNSUPPORTED =
  "Input compaction: unavailable - the installed engine predates this release's metering contract.";
export const INPUT_COMPACTION_UNSUPPORTED_REMEDY =
  "Output shaping continues. Run compaction engine install to pick up a compatible engine once one is published.";

/**
 * The content-free account + entitlement + engine snapshot behind the `Account & access` section.
 *
 * Identity (credentials present), authorization (lease verdict), and engine readiness are separate
 * facts. Status may silently renew a connected device's lease when it is missing/expired/near
 * expiry — that is the same repair `login`/`mode`/`gateway` already run — then re-reads local disk
 * so Plan/Community cannot claim Open while a still-entitled device only needed a refresh.
 *
 * PRIVACY (load-bearing): the account is reduced to a boolean `connected` here — the account id, the
 * email, and the device token are NEVER carried on this snapshot, so no identifier can reach the
 * human render path. The device token is never read for any purpose. Raw identifiers live only on the
 * separate `--json` object, which is the sanctioned diagnostic surface.
 */
export interface AccountAccessState {
  /** Credentials file present (presence only — never account id / email / token). Drives the Account line. */
  connected: boolean;
  /** A signed entitlement lease verifies as VALID on THIS device (current period, not expired). */
  entitled: boolean;
  /** Valid lease verified against the explicit DEV trust root — surfaced loudly, never omitted. */
  communityDevSigned: boolean;
  /** Content-free lease verdict label — distinguishes never-activated from expired/denied. */
  leaseLabel: LeaseVerdictLabel;
  /**
   * Why Community is not active when connected but not entitled, after any silent renew attempt.
   * `needs-activation` = never had usable authorization; `refresh-failed` = transient renew miss;
   * `denied` = authoritative server refusal; `none` when entitled or not connected.
   */
  communityGap: "none" | "needs-activation" | "refresh-failed" | "denied";
  /** The clamped effective tier (the SAME clamp the gateway apply gate reads). Drives the Optimization line. */
  tier: "observe" | "basic" | "full";
  /** An engine actually resolves and verifies on this machine. Drives the Engine line. */
  engineReady: boolean;
  /**
   * The resolved engine's signed manifest declares a meter unit this client cannot place, so input
   * compaction cannot run on this pair. Distinct from `engineReady`: this device HAS a working engine
   * and still gets no input compaction from it. Drives the input-compaction line.
   */
  inputCompactionUnsupported: boolean;
  /**
   * The remaining LOCAL gate between this device and a routed turn that actually compacts input, or
   * `undefined` when none is unmet.
   *
   * WHY THE TIER WAS NOT ENOUGH. `tier` answers product mode + lease. The gateway additionally requires
   * the input-optimization mode AND a stored per-tool apply authorization, and it was possible for all
   * of: credentials, a valid lease, a verified engine and `tier === "full"` to hold while the
   * optimization mode was plain `cache` — so this screen printed `Optimization: Full` and
   * `Compaction is active.` on a device the gateway declined on every single turn. Asked through the
   * SAME predicate the gateway answers with, so the two cannot diverge.
   */
  fullApplyPendingReason?: string;
  /**
   * `compaction stop` is in effect. The gateway declines every request while stopped (the unified
   * switch), so the healthy footer must not render. Same predicate the guard and the server read.
   */
  stopped: boolean;
  /** The local-gate read itself failed. Fail closed: an unreadable gate never yields the healthy footer. */
  localGateUnreadable: boolean;
  /** A live plain (`--workflow none`) Claude Code routing gateway exists: some session is pinned record-only. */
  liveRecordOnlyRoutingGateway: boolean;
}

/**
 * Whether a live routing gateway WITHOUT a workflow identity exists for the apply-routing provider.
 * Reads the same routing registry `gateway ensure` reads; liveness is the pid check, no socket, no
 * network. Any failure answers false (the note is an aid, never a reason the surface breaks).
 */
function hasLiveRecordOnlyRoutingGateway(env: EnvLike): boolean {
  try {
    return listRoutingSlots(env as NodeJS.ProcessEnv).some(
      (slot) =>
        slot.record.provider === APPLY_ROUTING_PROVIDER &&
        slot.record.workflow === undefined &&
        slot.record.quarantine === undefined &&
        isProcessAlive(slot.record.pid)
    );
  } catch {
    return false;
  }
}

/**
 * Attempt silent Community lease renew when this device is signed in and the lease needs it.
 * Never throws. Open devices (no credentials) are a no-op with no network call.
 */
async function maybeRenewCommunityAuthorization(env: EnvLike): Promise<string | undefined> {
  if (readStoredCredentials(env) === undefined) return undefined;
  if (!leaseNeedsRenewal(env)) return undefined;
  try {
    const { ensureCommunityRuntime } = await import("../../core/entitlement/community-runtime.js");
    const outcome = await ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
    return outcome.reason;
  } catch {
    return "lease-unavailable";
  }
}

function communityGapFrom(
  connected: boolean,
  entitled: boolean,
  leaseLabel: LeaseVerdictLabel,
  renewReason: string | undefined
): AccountAccessState["communityGap"] {
  if (!connected || entitled) return "none";
  if (renewReason === "not_entitled" || renewReason === "unauthorized" || renewReason === "device_inactive") {
    return "denied";
  }
  // Expired / wrong-period / absent after a renew attempt that was not an authoritative denial:
  // this device was previously in the Community lifecycle (or still is server-side) — do not send
  // the user through "needs activation" browser copy.
  if (
    leaseLabel === "lease-expired" ||
    leaseLabel === "lease-wrong-period" ||
    renewReason !== undefined
  ) {
    return "refresh-failed";
  }
  return "needs-activation";
}

/**
 * Collect the `Account & access` state. `tier` is INJECTED from the one `resolveOpenTier` call
 * `runStatus` already makes, so the rendered posture and the allowance notice can never come from two
 * different clamp evaluations. Engine availability is resolved once here (async — the engine probe is
 * reached through the sanctioned dynamic-import seam) and reused by the human and JSON paths.
 */
async function collectAccountAccess(
  env: EnvLike,
  tier: "observe" | "basic" | "full",
  renewReason?: string
): Promise<AccountAccessState> {
  // Truthiness only: the parsed credentials are never propagated, so no identifier can reach a render path.
  const connected = readStoredCredentials(env) !== undefined;
  const verdict = readLeaseVerdict(env);
  const entitled = verdict.label === "lease-valid";
  const engine = await engineAvailability(env as NodeJS.ProcessEnv);
  const inputCompaction = await engineInputCompaction(env as NodeJS.ProcessEnv);
  // Never let a diagnostic read fail the status command.
  let pendingReason: string | undefined;
  let localGateUnreadable = false;
  let stopped = false;
  try {
    pendingReason = await pendingFullApplyGate(readConnectedWorkflows(env as NodeJS.ProcessEnv), env as NodeJS.ProcessEnv);
    stopped = isShapingStopped(env);
  } catch {
    pendingReason = undefined;
    localGateUnreadable = true;
  }
  return {
    connected,
    entitled,
    communityDevSigned: entitled && verdict.trust === "dev-lease-root",
    leaseLabel: verdict.label,
    communityGap: communityGapFrom(connected, entitled, verdict.label, renewReason),
    tier,
    engineReady: engine === "present",
    inputCompactionUnsupported: inputCompaction === "unsupported",
    ...(pendingReason === undefined ? {} : { fullApplyPendingReason: pendingReason }),
    stopped,
    localGateUnreadable,
    liveRecordOnlyRoutingGateway: hasLiveRecordOnlyRoutingGateway(env)
  };
}

/**
 * Render the `Account & access` section. Every branch below is a decided rule, not a choice:
 *  - Account: presence only, never the id/token; absent → the set-up remedy on the next line.
 *  - Plan: user-facing vocabulary is ONLY `Community` (entitled) or `Open` (not entitled) — never a
 *    raw product_mode string. Entitled means a verified lease AFTER any silent renew.
 *  - Community: `active` / `active (DEV-SIGNED)`, or a gap that distinguishes never-activated from
 *    refresh failure / denial (never "needs activation" for a signed-in device that only needs renew).
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
    if (s.communityGap === "denied") {
      lines.push("Community: not entitled");
      lines.push(COMMUNITY_DENIED_REMEDY);
    } else if (s.communityGap === "refresh-failed") {
      lines.push("Community: authorization needs refresh");
      lines.push(REFRESH_COMMUNITY_REMEDY);
    } else {
      lines.push("Community: needs activation");
      lines.push(RESTORE_COMMUNITY_REMEDY);
    }
  }

  if (s.tier === "full") lines.push("Optimization: Full");
  else if (s.tier === "basic") lines.push("Optimization: Basic");

  if (s.engineReady) lines.push("Engine: ready");

  // Immediately after the Engine line, because it is the qualification of that line: an engine can be
  // ready and still be unable to compact input. Shown whenever the pair declares it, independent of
  // plan/tier — an Open device's engine is equally incapable, and hiding the reason behind an
  // entitlement check is how this stayed invisible.
  if (s.inputCompactionUnsupported) {
    lines.push(INPUT_COMPACTION_UNSUPPORTED);
    lines.push(INPUT_COMPACTION_UNSUPPORTED_REMEDY);
  }

  // Footer only when the device is fully set up AND the effective posture is `full` — the healthy
  // state that pairs with `Optimization: Full`. Gating on `full` (not merely
  // entitled) prevents an `observe`/`basic` device — which the gateway deliberately keeps record-only
  // — from claiming `Compaction is active.` (the turn is not being optimized).
  // ...AND no local gate is still unmet. `tier === "full"` alone was not the same question the gateway
  // answers, so this footer could claim the device was active while every turn was declined.
  const footer = accountFooterLines(s);
  if (footer.length > 0) lines.push("", ...footer);
  return lines;
}

/** Full input optimization is reachable for a routed, authorized tool: the healthy-footer condition. */
function fullApplyActive(s: AccountAccessState): boolean {
  return s.connected && s.entitled && s.engineReady && s.tier === "full" && s.fullApplyPendingReason === undefined
    && !s.stopped && !s.inputCompactionUnsupported && !s.localGateUnreadable;
}

function accountFooterLines(s: AccountAccessState): string[] {
  if (!(s.connected && s.entitled && s.engineReady && s.tier === "full")) return [];
  // The honest alternative, from the SAME reason string `mode`/`init` already print, so one unmet
  // gate is not described three different ways.
  if (s.fullApplyPendingReason !== undefined) return [s.fullApplyPendingReason];
  // The remaining declines the gateway applies on EVERY request: `compaction stop`, an engine whose
  // metering contract this client cannot place (explained by the input-compaction line), and an
  // unreadable local gate (fail closed). None of them may yield the healthy footer.
  if (!fullApplyActive(s)) return [];
  return s.liveRecordOnlyRoutingGateway ? [COMPACTION_ACTIVE_FOOTER, RECORD_ONLY_SESSION_NOTE] : [COMPACTION_ACTIVE_FOOTER];
}

export const STATUS_VERBOSE_HINT = "Details: compaction status --verbose";

type ConciseTool = "claude-code" | "codex" | "cursor";

/**
 * One tool's capability as the default status states it. Input reduction is claimed only where the
 * gateway would actually compact a routed turn (healthy Full posture + a routable, authorized tool);
 * output only where the shaping hook is verified active. Codex shaping that was not probed is said to
 * be unchecked rather than assumed.
 */
function conciseToolLine(key: ConciseTool, r: ReadinessReport, s: AccountAccessState, allowance?: ConciseAllowance): { text: string; input: boolean } {
  const connected = key === "claude-code" ? r.tools.claudeCode.connected
    : key === "codex" ? r.tools.codex.shim === "active" : r.tools.cursor.shim === "active";
  // Each capability axis is read on its own: a shaping hook or routing shim can stay active while
  // another connect artifact is missing (a hook-only install, a partial disconnect), and such a tool
  // must not be reported as disconnected while it still changes what the model sees.
  // Claude Code's input path is its routing shim; the Stop hook alone (what `connected` means) never
  // carries a request to the Gateway. A spent allowance pauses input on the routes it names.
  const routed = key === "claude-code" ? r.tools.claudeCode.routingShim === "active"
    : key === "codex" ? r.tools.codex.shim === "active" : false;
  let output: "yes" | "no" | "unchecked" | "needs-approval" | "disabled" = "no";
  if (key === "claude-code") output = r.tools.claudeCode.shapingActive ? "yes" : "no";
  else if (key === "cursor") output = r.tools.cursor.shapingActive ? "yes" : "no";
  else {
    const state = r.tools.codex.shapingState;
    output = state === "active" ? "yes" : state === "approval-required" ? "needs-approval" : state === "disabled" ? "disabled"
      : r.tools.codex.shapingConfigured ? "unchecked" : "no";
  }
  // Only an ACTIVE axis (a routing shim, or verified shaping) keeps a tool from reading as disconnected;
  // leftover hook configuration that Codex has not approved or checked is not an active capability.
  if (!connected && !routed && output !== "yes") {
    const sessions = r.tools.claudeCode.sessionsFound;
    const found = key === "claude-code" ? sessions === "unknown" || sessions > 0
      : key === "codex" ? r.tools.codex.binaryFound : r.tools.cursor.binaryFound;
    return { text: found ? "not connected" : "not found", input: false };
  }
  const state = connected ? "connected" : "partly connected";
  if (s.stopped) return { text: `${state} · paused (compaction stop)`, input: false };
  const allPaused = allowance !== undefined && allowance.scope !== "api-key-route";
  const eligible = key !== "cursor" && routed && fullApplyActive(s) && r.routes[key] === "routable" && r.authorizations[key].authorized;
  const input = eligible && !allPaused;
  const pausedNote = eligible && allPaused ? " · input paused (allowance)"
    : input && allowance?.scope === "api-key-route" ? " · API-key route paused (allowance)" : "";
  if (output === "yes") return { text: `${state} · ${input ? "input + output" : "output only"}${pausedNote}`, input };
  // Unprobed Codex trust is not counted as output: only `--check-codex` can establish it.
  const outputNote = output === "unchecked" ? " · output not checked (compaction status --check-codex)"
    : output === "needs-approval" ? " · output needs Codex hook approval"
    : output === "disabled" ? " · output hook disabled in Codex" : "";
  return { text: `${state} · ${input ? "input only" : "not optimizing"}${outputNote}${pausedNote}`, input };
}

/**
 * The DEFAULT `compaction status`: a short product-level summary. Every line is derived from the same
 * report and account state the detailed `--verbose` readiness report prints, never a separate guess.
 */
type ConciseAllowance = { reason: AllowancePauseReason; resetsOn?: string; scope?: AllowancePauseScope };

export function renderConciseStatus(
  r: ReadinessReport,
  s: AccountAccessState,
  engineVersion: string | undefined,
  allowanceNotice?: ConciseAllowance
): string[] {
  const row = (label: string, value: string) => `${label.padEnd(16)}${value}`;
  const lines: string[] = [];
  const install = r.runtime.managed ? `managed (${managedUpdateLabel(r.runtime.autoUpdates, r.runtime.autoUpdatesEffective)})` : "not managed";
  lines.push(`Compaction ${r.runtime.reportingVersion} · ${install}`);
  if (managedLauncherShadowed(r)) lines.push("Warning: `compaction` on PATH is not the managed launcher.");
  if (!r.runtime.resolvedBinary) lines.push("Warning: `compaction` is not on PATH.");
  lines.push("");
  if (!s.connected) {
    lines.push(row("Plan", "Open"), `  ${SET_UP_COMMUNITY_REMEDY}`);
  } else if (s.entitled) {
    lines.push(row("Community", s.communityDevSigned ? "active (DEV-SIGNED)" : "active"));
  } else if (s.communityGap === "denied") {
    lines.push(row("Community", "not entitled"), `  ${COMMUNITY_DENIED_REMEDY}`);
  } else if (s.communityGap === "refresh-failed") {
    lines.push(row("Community", "authorization needs refresh"), `  ${REFRESH_COMMUNITY_REMEDY}`);
  } else {
    lines.push(row("Community", "needs activation"), `  ${RESTORE_COMMUNITY_REMEDY}`);
  }
  // Full is a Community posture: never print it beside an Open plan line (e.g. a lease left behind
  // after `compaction logout`), whatever the tier clamp says.
  if (s.tier === "full" && s.connected && s.entitled) lines.push(row("Optimization", "Full"));
  else if (s.tier === "basic") lines.push(row("Optimization", "Basic"));
  if (s.engineReady) lines.push(row("Engine", engineVersion ? `${engineVersion} · ready` : "ready"));
  if (s.inputCompactionUnsupported) lines.push(`  ${INPUT_COMPACTION_UNSUPPORTED}`, `  ${INPUT_COMPACTION_UNSUPPORTED_REMEDY}`);
  // A paused allowance changes what every turn does, so it is state, not a diagnostic.
  if (allowanceNotice) for (const line of upgradeNoticeLines(allowanceNotice)) lines.push(line === "" ? "" : `  ${line}`);
  lines.push("");
  const tools = (["claude-code", "codex", "cursor"] as const).map((key) => ({ key, ...conciseToolLine(key, r, s, allowanceNotice) }));
  for (const tool of tools) lines.push(row(tool.key === "claude-code" ? "Claude Code" : tool.key === "codex" ? "Codex" : "Cursor", tool.text));
  lines.push("");
  lines.push(row("Gateway", r.gateway.running ? "running" : "starts on demand"));
  // The healthy footer claims optimization is running, so it needs a tool row that actually gets input
  // optimization: none does under an all-routes allowance pause, or when every integration is gone.
  const footer = tools.some((tool) => tool.input)
    ? accountFooterLines(s)
    : accountFooterLines(s).filter((line) => line !== COMPACTION_ACTIVE_FOOTER && line !== RECORD_ONLY_SESSION_NOTE);
  if (footer.length > 0) lines.push("", ...footer);
  lines.push("", STATUS_VERBOSE_HINT);
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
    /** What the resolved pair declares about input compaction — the state a support report needs. */
    engineInputCompaction: EngineInputCompaction;
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
      engine,
      engineInputCompaction: await engineInputCompaction(env as NodeJS.ProcessEnv)
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
 * the account/plan/entitlement/optimization/engine state this device holds after any silent Community
 * lease renew for a signed-in device whose lease is missing/expired/near expiry. When a private-beta
 * HOSTED endpoint is deliberately configured, the hosted reachability diagnostic is appended (masked
 * key + host + a LIVE reachability re-check; capabilities shown ONLY when reachable). Never prints
 * the account id, the device token, or the API key on the human path. Always exits 0.
 */
export async function runStatus(
  opts: { env?: EnvLike; version?: string; json?: boolean; verbose?: boolean; projectsDir?: string; checkCodex?: boolean } = {}
): Promise<void> {
  const env = opts.env ?? process.env;
  const version = opts.version ?? "unknown";
  // Silent renew FIRST for a signed-in device whose lease needs it, so Plan/Community and the tier
  // clamp below describe post-renew authorization rather than a stale expired lease. Open devices
  // make no network call.
  const renewReason = await maybeRenewCommunityAuthorization(env);
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
  // `tier` is the ONE clamp the `Account & access` posture and the allowance notice both read —
  // evaluated AFTER silent renew so Full is visible when the lease was restored.
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

  const accountAccess = await collectAccountAccess(env, tier, renewReason);
  const allowanceNotice = await allowanceNoticeInput(env, process.cwd());
  if (opts.verbose) {
    console.log(renderReadinessReport(report));
    console.log("");
    for (const line of renderLastTurnsSection(lastTurns, allowanceNotice)) console.log(line);
    console.log("");
    for (const line of renderAccountAccessSection(accountAccess)) console.log(line);
  } else {
    const engineVersion = await resolvedEngineVersion(env as NodeJS.ProcessEnv);
    for (const line of renderConciseStatus(report, accountAccess, engineVersion, allowanceNotice)) console.log(line);
  }

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
      "Concise summary: plan, optimization, engine, connected tools, and gateway. --verbose prints the " +
        "full readiness report: detected tools + connect status, gateway health, storage, credential " +
        "PRESENCE (set/unset only - never values), stored auto-apply authorizations, what routes vs " +
        "measures-only, the exact next commands, and whether a hosted endpoint is configured + " +
        "reachable. Local, read-only, content-free; always exits 0."
    )
    .option("--json", "Print the content-free report as JSON.")
    .option("-v, --verbose", "Print the full readiness report (diagnostics, routes, next commands).")
    .option("--projects-dir <dir>", "Claude Code projects directory to detect against (default: the standard local location)")
    .option(
      "--check-codex",
      "Ask Codex directly whether it will run Compaction's shaping hook (its one-time hook trust). " +
        "OFF by default because, WHEN A CODEX SHAPING HOOK IS CONFIGURED, this STARTS CODEX briefly, " +
        "and Codex writes to its own home and refreshes its model catalogue over the network - which " +
        "the rest of this command never does. With no such hook configured nothing is started."
    )
    .action(async (options: { json?: boolean; verbose?: boolean; projectsDir?: string; checkCodex?: boolean }) => {
      await runStatus({
        version: program.version() ?? "unknown",
        json: options.json,
        verbose: options.verbose,
        projectsDir: options.projectsDir,
        checkCodex: options.checkCodex
      });
    });
}
