/**
 * Onboarding preferences, content-free store for the optimization-mode default and the
 * connect-once workflow choice.
 *
 * A separate, small store from the API `persisted-config.ts` (`~/.compaction/config.json`),
 * with the same env-override + permission rules.
 *
 * Invariants:
 *  - The file lives at `~/.compaction/preferences.json`, written mode 0600 (dir 0700). The env
 *    override `COMPACTION_CONFIG_DIR` redirects it exactly like `persisted-config.ts` (tests point
 *    it at a tmpdir; the real `~/.compaction` is never touched by tests).
 *  - The only keys ever written are `optimization_mode` (enum: `"cache"` / `"cache-plus-context"`),
 *    `connected_workflows` (a deduped array over the routable-workflow enum `"claude-code"` /
 *    `"codex"`, the connect-once choice that lets the Gateway default its `--workflow` identity),
 *    and `product_mode` (enum: `"observe"` / `"basic"` / `"full"`, the open-core product-tier apply
 *    posture — content-free, no account/
 *    entitlement/usage/network call is made to read or write it).
 *    Update settings add only an auto_updates boolean and a stable/preview channel.
 *    No prompt/response/tool-invocation content, no credential, no path, no free-form field -
 *    every value is closed plain JSON. An assertion in the single write path fail-closes if
 *    anything else would ever be written.
 *  - The mode is a content-free runtime default. `cache-plus-context` is effective only for a
 *    routed Claude Code or Codex workflow with a matching narrow stored authorization; the Gateway
 *    still enforces its supported-shape, conflict, retention, and recovery gates before any
 *    model-visible mutation.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvLike } from "./api-client/config.js";
import type { OptimizationModeKey } from "../cli/onboarding/model.js";
import { readLeaseVerdict, type LeaseVerdict } from "./entitlement/lease-store.js";
import { periodEndUtc } from "./entitlement/lease.js";
import { readMeteredAllowance } from "./gateway/metering-seam.js";
import { compactionConfigDir } from "./config-dir.js";

/**
 * The user-facing preference enum. Deliberately distinct from the model's internal
 * `OptimizationModeKey` (`cache-optimize` / `cache-context-optimize`): this is the short
 * CLI/on-disk vocabulary (`--mode cache` / `--mode cache-plus-context`).
 */
export type OptimizationModePreference = "cache" | "cache-plus-context";

/** The recommended default when nothing is persisted. Mirrors the model's `defaultOptimizationMode()`. */
export const DEFAULT_OPTIMIZATION_MODE_PREFERENCE: OptimizationModePreference = "cache";

/** The exhaustive whitelist of legal values, the only strings ever accepted or written. */
export const OPTIMIZATION_MODE_PREFERENCES: readonly OptimizationModePreference[] = [
  "cache",
  "cache-plus-context"
] as const;

/** The optimization-mode on-disk key. */
const PREFERENCE_KEY = "optimization_mode" as const;

/** The connected-routable-workflows on-disk key (enum-array; see `CONNECTED_ROUTABLE_WORKFLOWS`). */
const CONNECTED_KEY = "connected_workflows" as const;

/** The open-core product-mode on-disk key (enum; see `PRODUCT_MODES`). */
const PRODUCT_MODE_KEY = "product_mode" as const;

/** The exhaustive on-disk key whitelist. Nothing else is ever written (enforced in `writeStoredPreferences`). */
const LEGAL_PREFERENCE_KEYS: readonly string[] = [PREFERENCE_KEY, CONNECTED_KEY, PRODUCT_MODE_KEY, "auto_updates", "update_channel"];

/**
 * The open-core product-mode (apply-posture) enum:
 *  - `observe` — no model-visible mutation; per-turn line reads `apply off`.
 *  - `basic`   — the ONE public deterministic output-shaping method (`concise_response`); per-turn line
 *                reads `basic shaping`. No engine, no input compaction, no account/usage/network.
 *  - `full`    — Community private-engine adaptive apply. Effective ONLY with a valid signed entitlement
 *                lease on this device; without one it NEVER claims full apply and the effective posture
 *                clamps to `observe`/`basic`. The onboarding stepper is
 *                what sets up the account and the lease.
 *
 * Persisting `full` records only the user's stated intent; it does NOT enable full apply here and makes
 * no account/entitlement/usage/network call. The effective runtime posture stays `observe`/`basic`
 * until a real Community activation lands. This is content-free, enum-only, local.
 */
export type ProductMode = "observe" | "basic" | "full";

/** The recommended default when nothing is persisted: `observe` (no model-visible mutation). */
export const DEFAULT_PRODUCT_MODE: ProductMode = "observe";

/** The exhaustive whitelist of legal product-mode values, the only strings ever accepted or written. */
export const PRODUCT_MODES: readonly ProductMode[] = ["observe", "basic", "full"] as const;

/** Type guard: is `v` one of the three legal product-mode strings? */
export function isProductMode(v: unknown): v is ProductMode {
  return typeof v === "string" && (PRODUCT_MODES as readonly string[]).includes(v);
}

/**
 * The workflows a connect-once choice may persist: exactly the two that route through the local Gateway
 * (Codex → OpenAI, Claude Code → Anthropic). Cursor is structurally excluded, it has no Gateway route
 * (vendor gap), so persisting it could only ever mislead the `--workflow` default.
 */
export type ConnectedRoutableWorkflow = "claude-code" | "codex";

/** Canonical order for the persisted enum-array (dedupe + stable serialization). */
export const CONNECTED_ROUTABLE_WORKFLOWS: readonly ConnectedRoutableWorkflow[] = ["claude-code", "codex"] as const;

/** Type guard: is `v` one of the two routable-workflow enum strings? */
export function isConnectedRoutableWorkflow(v: unknown): v is ConnectedRoutableWorkflow {
  return typeof v === "string" && (CONNECTED_ROUTABLE_WORKFLOWS as readonly string[]).includes(v);
}

/** Human labels for honest CLI copy (no savings/optimization claim; pure noun). */
export const OPTIMIZATION_MODE_PREFERENCE_LABELS: Record<OptimizationModePreference, string> = {
  cache: "Output only",
  "cache-plus-context": "Full optimization"
};

/** The content-free on-disk shape. ONLY these enum-valued keys may exist; each is optional on disk. */
export interface OnboardingPreferences {
  optimization_mode?: OptimizationModePreference;
  connected_workflows?: ConnectedRoutableWorkflow[];
  product_mode?: ProductMode;
  auto_updates?: boolean;
  update_channel?: "stable" | "preview";
}

/** Type guard: is `v` one of the two legal enum strings? */
export function isOptimizationModePreference(v: unknown): v is OptimizationModePreference {
  return typeof v === "string" && (OPTIMIZATION_MODE_PREFERENCES as readonly string[]).includes(v);
}

/** Map a CLI/on-disk preference to the shared model's internal optimization-mode key. Pure. */
export function toModelOptimizationModeKey(mode: OptimizationModePreference): OptimizationModeKey {
  return mode === "cache-plus-context" ? "cache-context-optimize" : "cache-optimize";
}

/** Map a shared-model optimization-mode key back to the CLI/on-disk preference. Pure. */
export function fromModelOptimizationModeKey(key: OptimizationModeKey): OptimizationModePreference {
  return key === "cache-context-optimize" ? "cache-plus-context" : "cache";
}

/**
 * Resolve the preferences directory. `COMPACTION_CONFIG_DIR` overrides `~/.compaction` (tests use this) -
 * IDENTICAL semantics to `persisted-config.ts` so both stores live in the same content-free dir.
 */
export function preferencesDir(env: EnvLike = process.env): string {
  return compactionConfigDir(env);
}

/** Absolute path to the preferences file. */
export function preferencesPath(env: EnvLike = process.env): string {
  return join(preferencesDir(env), "preferences.json");
}

/**
 * Read + validate the stored preferences. Never throws: a missing/corrupt/partial file yields only the
 * fields that validate exactly against the enum rails; everything else is dropped (fail-closed per field).
 */
function readStoredPreferences(env: EnvLike = process.env): OnboardingPreferences {
  const path = preferencesPath(env);
  if (!existsSync(path)) return {};
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: OnboardingPreferences = {};
  if (isOptimizationModePreference(raw[PREFERENCE_KEY])) {
    result.optimization_mode = raw[PREFERENCE_KEY] as OptimizationModePreference;
  }
  const connectedRaw = raw[CONNECTED_KEY];
  if (Array.isArray(connectedRaw)) {
    // Honor ONLY exact enum members, deduped into canonical order; anything else is dropped.
    const connected = CONNECTED_ROUTABLE_WORKFLOWS.filter((w) => connectedRaw.includes(w));
    if (connected.length > 0) result.connected_workflows = connected;
  }
  if (isProductMode(raw[PRODUCT_MODE_KEY])) {
    result.product_mode = raw[PRODUCT_MODE_KEY] as ProductMode;
  }
  if (raw.auto_updates !== undefined) result.auto_updates = raw.auto_updates === true;
  if (raw.update_channel === "stable" || raw.update_channel === "preview") result.update_channel = raw.update_channel;
  return result;
}

/**
 * The single write path for the preferences file (dir 0700, file 0600). Returns the absolute path
 * written. The body carries only whitelisted keys with exact-enum values, an assertion fail-closes
 * on any other key, an illegal mode, or a non-enum/duplicate workflow entry. No content is ever
 * stored. `chmod` is applied after the write because `writeFileSync`'s `mode` only takes effect on
 * creation.
 */
function writeStoredPreferences(preferences: OnboardingPreferences, env: EnvLike = process.env): string {
  for (const key of Object.keys(preferences)) {
    if (!LEGAL_PREFERENCE_KEYS.includes(key)) {
      throw new Error(`preferences store rail violated: unexpected key ${JSON.stringify(key)}`);
    }
  }
  if (preferences.optimization_mode !== undefined && !isOptimizationModePreference(preferences.optimization_mode)) {
    throw new Error(`refusing to persist illegal optimization_mode: ${JSON.stringify(preferences.optimization_mode)}`);
  }
  if (preferences.product_mode !== undefined && !isProductMode(preferences.product_mode)) {
    throw new Error(`refusing to persist illegal product_mode: ${JSON.stringify(preferences.product_mode)}`);
  }
  if (preferences.auto_updates !== undefined && typeof preferences.auto_updates !== "boolean") throw new Error("Invalid automatic-update preference");
  if (preferences.update_channel !== undefined && !["stable", "preview"].includes(preferences.update_channel)) throw new Error("Invalid update channel");
  if (preferences.connected_workflows !== undefined) {
    const list = preferences.connected_workflows;
    const canonical = CONNECTED_ROUTABLE_WORKFLOWS.filter((w) => list.includes(w));
    const isCanonical =
      Array.isArray(list) &&
      list.length === canonical.length &&
      list.every((w, i) => isConnectedRoutableWorkflow(w) && w === canonical[i]);
    if (!isCanonical || list.length === 0) {
      throw new Error(`refusing to persist illegal connected_workflows: ${JSON.stringify(list)}`);
    }
  }

  const dir = preferencesDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "preferences.json");
  const body = `${JSON.stringify(preferences, null, 2)}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/**
 * Read the persisted optimization mode, or the DEFAULT (`"cache"`) when absent/empty/malformed/illegal.
 * Never throws: a corrupt/partial/unknown-value file fails closed to the default rather than crashing a
 * command. Only an exact-enum `optimization_mode` value is honored.
 */
export function readOptimizationMode(env: EnvLike = process.env): OptimizationModePreference {
  return readStoredPreferences(env).optimization_mode ?? DEFAULT_OPTIMIZATION_MODE_PREFERENCE;
}

/**
 * Persist the optimization-mode DEFAULT at `~/.compaction/preferences.json`, preserving any persisted
 * `connected_workflows`. Returns the absolute path written. Illegal values fail-closed (rail assertion).
 */
export function writeOptimizationMode(mode: OptimizationModePreference, env: EnvLike = process.env): string {
  if (!isOptimizationModePreference(mode)) {
    throw new Error(`refusing to persist illegal optimization_mode: ${JSON.stringify(mode)}`);
  }
  const existing = readStoredPreferences(env);
  return writeStoredPreferences(
    {
      ...existing,
      optimization_mode: mode
    },
    env
  );
}

/**
 * Read the persisted open-core product mode, or the DEFAULT (`"observe"`) when absent/empty/malformed/
 * illegal. Never throws: a corrupt/partial/unknown-value file fails closed to `observe` (the no-mutation
 * posture) rather than crashing. Reads local disk ONLY — no account/entitlement/usage/network call.
 */
export function readProductMode(env: EnvLike = process.env): ProductMode {
  return readStoredPreferences(env).product_mode ?? DEFAULT_PRODUCT_MODE;
}

/**
 * Persist the open-core product mode at `~/.compaction/preferences.json`, preserving any persisted
 * `optimization_mode` and `connected_workflows`. Returns the absolute path written. Illegal values
 * fail-closed (rail assertion). Writes local disk ONLY — no account/entitlement/usage/network call.
 *
 * Persisting `"full"` records the user's stated intent only; it does NOT enable full apply and makes no
 * account/entitlement/usage/network call. The effective runtime posture stays `observe`/`basic` until a
 * real Community activation (engine + auth) exists.
 */
export function writeProductMode(mode: ProductMode, env: EnvLike = process.env): string {
  if (!isProductMode(mode)) {
    throw new Error(`refusing to persist illegal product_mode: ${JSON.stringify(mode)}`);
  }
  const existing = readStoredPreferences(env);
  return writeStoredPreferences(
    {
      ...existing,
      product_mode: mode
    },
    env
  );
}

/**
 * THE TIER CLAMP — the ONE decision the gateway gate and every rendered label share.
 *
 * `full` is REAL ONLY when the persisted product mode is `full` AND the pure entitlement lease-store
 * verifies a VALID signed lease for THIS device + the current period (Ed25519-verified against the
 * pinned/dev lease root, device-bound, in-period, not expired). A persisted `full` intent with NO
 * valid lease clamps to `observe` — the safe no-mutation posture — so the tier can never claim `full`
 * off a bare intent.
 *
 * DELIBERATELY INDEPENDENT OF THE METERED ALLOWANCE BALANCE (load-bearing): a spent
 * optimized-input allowance stops metered INPUT compaction — on every route, since the allowance pays
 * for the Hybrid Engine and not for the billing route. It does NOT stop OUTPUT SHAPING, which the
 * allowance never bought, so clamping the tier on a spent balance would switch off a capability that
 * owes the allowance nothing. This holds for BOTH ways a balance goes to zero — the
 * local journal having spent it, and the ISSUER having signed a lease with none left — because the
 * lease-store now reports the second as `meteredBalanceExhausted` on a VALID verdict rather than as
 * a terminal entitlement label. The ceiling therefore rides `resolveOpenTier` as a SCOPED reason
 * beside an unchanged tier — never as a tier downgrade.
 *
 * PURITY: reads local disk ONLY (the lease file + the credentials file, both by `fs`) — NO account/
 * entitlement service, usage, or network call. The lease-store imports nothing from the account/api
 * client, keeping this function (and its Open-path callers) engine-free and network-free.
 */
function clampTier(env: EnvLike): { tier: "observe" | "basic" | "full"; verdict?: LeaseVerdict } {
  const mode = readProductMode(env);
  if (mode !== "full") return { tier: mode === "basic" ? "basic" : "observe" };
  const verdict = readLeaseVerdict(env);
  return { tier: verdict.label === "lease-valid" ? "full" : "observe", verdict };
}

/**
 * The effective per-turn tier — `observe`, `basic`, or `full`. The SYNCHRONOUS half of
 * `resolveOpenTier`: identical `tier`, by construction (both call `clampTier` and neither re-derives
 * the rule), with none of the ceiling I/O. The gateway's apply gate uses this because it needs the
 * posture and nothing else, and it performs its own authoritative allowance check under the journal
 * append lock immediately afterwards.
 */
export function effectiveOpenTier(env: EnvLike = process.env): "observe" | "basic" | "full" {
  return clampTier(env).tier;
}

/**
 * The effective tier PLUS the one reason a surface must be able to explain: the period allowance is
 * spent — and, since it is not the same fact on every route, WHICH traffic that pause covers.
 *
 * `clampTier` answers "what posture is this turn?" and is what the gate and the label both use, so
 * the two can never disagree about the tier. But the clamp is deliberately SILENT about the balance:
 * a spent allowance correctly leaves the tier at `full`, because output shaping owes the allowance
 * nothing and keeps running — and nothing on the line would then ever mention that metered INPUT
 * compaction has stopped. This function adds that missing fact, scoped to the traffic it covers, and
 * changes no tier.
 *
 * The ceiling is reported ONLY when the user actually asked for `full` — an `observe`/`basic` user was
 * promised nothing about full apply, so telling them their allowance is spent would be noise.
 *
 * PURITY unchanged: local disk only (lease file, credentials file, and the usage journal behind the
 * metering seam, all by `fs`), no account/entitlement/usage-service or network call, nothing from
 * `src/core/auth/**` or `src/core/api-client/**`.
 */

/**
 * WHICH TRAFFIC a spent allowance actually pauses.
 *
 *  - `all-routes` — what a spent allowance means TODAY, and what `resolveOpenTier` reports. The
 *    Compaction allowance pays for use of the Hybrid Engine, not for the provider billing route, so a
 *    confirmed input apply debits it on the API-key route and on a Claude Code subscription session
 *    alike. When it is spent, INPUT OPTIMIZATION pauses everywhere; output shaping is the Open/base
 *    capability and keeps running on every route.
 *  - `api-key-route` — HISTORICAL. Metering was api-key-only until route-independent metering landed,
 *    and receipts persisted before that carry this narrower label. The renderers still accept it and
 *    still qualify it, so an old receipt replays as the statement that was true when it was written.
 *    NOTHING PRODUCES IT ANYMORE.
 */
export type AllowancePauseScope = "api-key-route" | "all-routes";

export interface OpenTierResolution {
  tier: "observe" | "basic" | "full";
  /**
   * Present ONLY when the persisted mode is `full` and this period's optimized-input allowance is
   * spent — either because the signed lease carries none, or because the local integrity-checked
   * journal has consumed it. The UTC calendar date (`YYYY-MM-DD`) the allowance resets, derived from
   * the lease's PERIOD (never from `expires_at`, which is renewed within a period and would name a
   * date that is too early). Absent when the lease carries no usable period.
   */
  allowanceResetsOn?: string;
  /** Always present alongside `allowanceResetsOn`; names the traffic that pause applies to. */
  allowancePauseScope?: AllowancePauseScope;
}

/**
 * Whether THIS DEVICE has locally spent the period's optimized-input allowance, as a reset date.
 *
 * WHY THIS EXISTS (the window the ceiling surface used to miss entirely): after a positive lease is
 * issued, every metered debit lands in the local usage journal and nowhere else until reconciliation.
 * The lease's own `allowanceTokens` stays positive for that whole interval, while the gateway is
 * already refusing metered full apply on `remaining <= 0`. Reading only the lease therefore declared
 * the allowance unspent for exactly as long as the local ceiling was the one doing the refusing.
 *
 * ONLY the local half: an issuer-signed zero is read straight off the verdict by the caller and needs
 * no journal, which also keeps that fact readable when the journal does not verify.
 *
 * NETWORK-FREE: the tally comes through the metering seam, whose lazy target is the local
 * hash-chained journal (`fs` + `node:crypto`). No account, entitlement, or usage service is called.
 *
 * INTEGRITY REUSED, NOT REIMPLEMENTED: `readMeteredAllowance` is the SAME integrity-gated read the
 * gateway uses, so a skipped/malformed line or a chain that does not verify still refuses to be
 * summed over (fail-closed) rather than silently replenishing the allowance here.
 *
 * FAIL-OPEN AND TOTAL: this runs in `statusline`, inside Claude Code's per-turn render loop. Any
 * throw, any unreadable ceiling, and any absent-metering build resolves to "name no reason" — the
 * surface then renders exactly what it rendered before. An unverifiable journal must never be
 * reported as a SPENT allowance: that would be a fabricated reason, which is the defect class this
 * whole surface exists to remove. The gate's own fail-closed decline is unaffected either way.
 *
 * COST: paid ONLY on the `full` tier with a valid lease (an `observe`/`basic`/no-lease turn does no
 * extra I/O at all). One sequential read of a file that grows by one line per metered apply, plus one
 * SHA-256 per line for the chain check — no signature verification, no directory scan.
 */
async function localAllowanceSpentResetDate(verdict: LeaseVerdict, env: EnvLike): Promise<string | undefined> {
  const periodId = verdict.periodId;
  if (periodId === undefined) return undefined;
  const resetsOn = periodEndUtc(periodId);
  if (resetsOn === undefined) return undefined; // no honest date ⇒ no claim (never a bare "paused")
  try {
    const consumption = await readMeteredAllowance(verdict.allowanceTokens ?? 0, periodId, env as NodeJS.ProcessEnv);
    if (!consumption.ok) return undefined;
    return consumption.remaining <= 0 ? resetsOn : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveOpenTier(env: EnvLike = process.env): Promise<OpenTierResolution> {
  const { tier, verdict } = clampTier(env);
  if (verdict === undefined || verdict.label !== "lease-valid") return { tier };

  // The balance can be spent in two places and the user-visible fact is the same one either way:
  //  - the ISSUER signed this lease with none left — server-authoritative, needs no journal read, and
  //    still readable when the journal does not verify;
  //  - THIS DEVICE's local journal has consumed an otherwise-positive allowance since issue.
  // Whichever it is, EVERY route spends the allowance, so the pause covers every route and the tier
  // does not move: output shaping keeps running (see `clampTier`, which the gateway's gate reads too).
  const resetsOn = verdict.meteredBalanceExhausted
    ? verdict.periodId
      ? periodEndUtc(verdict.periodId)
      : undefined
    : await localAllowanceSpentResetDate(verdict, env);
  return { tier, ...(resetsOn ? { allowanceResetsOn: resetsOn, allowancePauseScope: "all-routes" as const } : {}) };
}

/**
 * Read the persisted connect-once ROUTABLE workflows (enum-only, canonical order). Never throws; a
 * missing/corrupt file or non-enum entries read as "none persisted" (fail-closed per entry).
 */
export function readConnectedWorkflows(env: EnvLike = process.env): ConnectedRoutableWorkflow[] {
  return readStoredPreferences(env).connected_workflows ?? [];
}

/**
 * Record routable workflows as connected (set-union with what is already persisted; canonical order;
 * enum-only). Preserves any persisted optimization mode. Returns the absolute path written.
 * Non-routable values fail-closed - Cursor can never be persisted as a routable workflow.
 */
export function addConnectedWorkflows(workflows: readonly ConnectedRoutableWorkflow[], env: EnvLike = process.env): string {
  for (const workflow of workflows) {
    if (!isConnectedRoutableWorkflow(workflow)) {
      throw new Error(`refusing to persist illegal connected workflow: ${JSON.stringify(workflow)}`);
    }
  }
  const existing = readStoredPreferences(env);
  const merged = CONNECTED_ROUTABLE_WORKFLOWS.filter(
    (w) => (existing.connected_workflows ?? []).includes(w) || workflows.includes(w)
  );
  return writeStoredPreferences(
    {
      ...existing,
      connected_workflows: merged.length > 0 ? merged : undefined
    },
    env
  );
}

/**
 * Remove one workflow from the persisted connect-once choice (e.g. on `init --disconnect`). Preserves the
 * persisted optimization mode; removing the last workflow drops the key entirely. Idempotent.
 */
export function removeConnectedWorkflow(workflow: ConnectedRoutableWorkflow, env: EnvLike = process.env): string {
  const existing = readStoredPreferences(env);
  const remaining = (existing.connected_workflows ?? []).filter((w) => w !== workflow);
  return writeStoredPreferences(
    {
      ...existing,
      connected_workflows: remaining.length > 0 ? remaining : undefined
    },
    env
  );
}

export function readUpdatePreferences(env: EnvLike = process.env): { autoUpdates: boolean; channel: "stable" | "preview" } {
  try {
    if (existsSync(preferencesPath(env))) {
      const value: unknown = JSON.parse(readFileSync(preferencesPath(env), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return { autoUpdates: false, channel: "stable" };
    }
  } catch { return { autoUpdates: false, channel: "stable" }; }
  const preferences = readStoredPreferences(env);
  return { autoUpdates: preferences.auto_updates !== false, channel: preferences.update_channel ?? "stable" };
}

export function writeUpdatePreferences(update: { autoUpdates?: boolean; channel?: "stable" | "preview" }, env: EnvLike = process.env): string {
  return writeStoredPreferences({
    ...readStoredPreferences(env),
    ...(update.autoUpdates !== undefined ? { auto_updates: update.autoUpdates } : {}),
    ...(update.channel !== undefined ? { update_channel: update.channel } : {})
  }, env);
}
