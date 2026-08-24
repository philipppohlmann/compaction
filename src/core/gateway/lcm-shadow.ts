/**
 * Gateway LCM SHADOW hook (public CLI/SDK core, engine-free static graph).
 *
 * OPT-IN, DEFAULT OFF. Shadow evaluation runs ONLY when the operator explicitly enables it
 * (server option `lcmShadow.enabled` or `COMPACTION_LCM_SHADOW=1`). When disabled, the default -
 * the gateway path is byte-identical to a gateway without this module: no shadow code runs, no
 * engine import is attempted, and no receipt or output changes.
 *
 * EXECUTION STRATEGY, post-response, detached, bounded:
 *   The live provider request is forwarded UNCHANGED and the live response returned UNCHANGED,
 *   always. Shadow evaluation starts only AFTER the upstream response has fully arrived, on a
 *   detached (`void`-ed) promise the request/response path never awaits, so it structurally
 *   cannot alter provider routing, the request body, cache controls, model selection, output
 *   budget, the response, or approval state. A bounded timeout (`DEFAULT_LCM_SHADOW_TIMEOUT_MS`)
 *   caps the evaluation itself; on expiry the evaluation is abandoned fail-open.
 *
 * FAIL-OPEN, ALWAYS: timeout, a throwing runner, an invalid/content-shaped summary, or a missing
 * engine build (a build without the shipped hybrid engine slice) each degrade to a content-free
 * reason label (`timeout` / `model-error` / `invalid-candidate` / `engine-unavailable`). Nothing
 * on this path can throw into the proxy.
 *
 * CONTENT-FREE RECORDING ONLY: an `evaluated` summary carries the `ContentFreeLcmEvidence`
 * projection (built by `toContentFreeLcmEvidence` on the engine side, counts/labels/versions/
 * outcomes only) plus local-estimate comparison numbers. Every summary is re-scanned by
 * `scanContentFreeLcmEvidence` before it is emitted, appended (local-only
 * `.compaction/gateway/lcm-shadow.jsonl` sidecar, the receipt schema is untouched), or logged.
 * No prompt/response/candidate/source text ever rides on a summary or a log line.
 *
 * ENGINE BOUNDARY: the engine runner is reached ONLY via a lazy dynamic `import()` inside the
 * enabled branch, the shipped static graph never references `src/engine/**`
 * (`npm run boundary:engine` stays at zero edges). The engine's default model client is the LOCAL
 * hybrid client (on-device, auto-provisioned); this module offers NO way to configure a remote model
 * client. Local inference is slow, so the evaluation budget is raisable via
 * `COMPACTION_LCM_SHADOW_TIMEOUT_MS`, the eval is detached/post-response and never touches the live
 * request, so a larger budget is safe.
 */
import { PRIVATE_ENGINE_TREE, isModuleTreeAbsentError } from "../module-absence.js";
import path from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import { scanContentFreeLcmEvidence, type ContentFreeLcmEvidence } from "../lcm-evidence-contract.js";
import { DEFAULT_GATEWAY_RECEIPTS_DIR } from "./receipt.js";

/** Env gate for the shadow opt-in: `COMPACTION_LCM_SHADOW=1` (or `true`). Anything else = OFF. */
export const GATEWAY_LCM_SHADOW_ENV = "COMPACTION_LCM_SHADOW";

/** Env override for the evaluation budget in ms (for slow local inference). Explicit option wins. */
export const GATEWAY_LCM_SHADOW_TIMEOUT_ENV = "COMPACTION_LCM_SHADOW_TIMEOUT_MS";

/** Local-only sidecar (JSONL) for content-free shadow summaries, beside `receipts.jsonl`. */
export const GATEWAY_LCM_SHADOW_FILE = "lcm-shadow.jsonl";

/** Bounded evaluation budget: an evaluation still running after this is abandoned fail-open. */
export const DEFAULT_LCM_SHADOW_TIMEOUT_MS = 5_000;

export const GATEWAY_LCM_SHADOW_SCHEMA = "gateway-lcm-shadow/1";

/** The only fail-open reasons, content-free class labels, never error text. */
export type LcmShadowFailOpenReason = "timeout" | "model-error" | "invalid-candidate" | "engine-unavailable";

/** Local-estimate comparison numbers (chars/4 over the safe fields), never provider-reported. */
export interface LcmShadowComparison {
  baselineChanged: boolean;
  shadowChanged: boolean;
  baselineEstReductionPercent: number | null;
  shadowEstReductionPercent: number | null;
  /** shadow minus baseline, percentage points (null unless both sides proposed a change). */
  deltaPercentPoints: number | null;
  tokenBasis: "local-estimate-chars-per-4-safe-fields";
}

/** Honest single-line label on every summary (kept label-length; the scanner enforces it). */
export const GATEWAY_LCM_SHADOW_LABEL =
  "shadow-only: never applied; live request/response bytes unchanged; counts and labels only; " +
  "reductions are local estimates (chars/4), not provider-reported";

/**
 * One content-free shadow summary. `evaluated` wraps the `toContentFreeLcmEvidence` projection;
 * `fail-open` carries only the reason class. Both are re-scanned before leaving this module.
 */
export type GatewayLcmShadowSummary =
  | {
      schema: typeof GATEWAY_LCM_SHADOW_SCHEMA;
      status: "evaluated";
      endpoint: string;
      evidence: ContentFreeLcmEvidence;
      comparison: LcmShadowComparison;
      applied: false;
      modelVisibleBytesChanged: false;
      label: string;
    }
  | {
      schema: typeof GATEWAY_LCM_SHADOW_SCHEMA;
      status: "fail-open";
      endpoint: string;
      reason: LcmShadowFailOpenReason;
      applied: false;
      modelVisibleBytesChanged: false;
      label: string;
    };

/**
 * The runner seam: evaluates ONE request in shadow and returns a content-free summary. The default
 * (when none is injected) is the engine's fixture-safe runner, loaded lazily; tests inject
 * deterministic runners here (a hanging one for the timeout path, a throwing one for model-error).
 */
export type GatewayLcmShadowRunner = (endpoint: string, bodyText: string) => Promise<GatewayLcmShadowSummary>;

/** Server-level shadow options. Everything is optional; omitted = OFF. */
export interface GatewayLcmShadowOptions {
  /** Explicit opt-in. When omitted, the `COMPACTION_LCM_SHADOW` env gate decides (default OFF). */
  enabled?: boolean;
  /** Evaluation budget in ms (default `DEFAULT_LCM_SHADOW_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Runner override (tests / advanced embedding). Default: lazy engine import, null model client. */
  runner?: GatewayLcmShadowRunner;
  /** Observability hook fired with every summary (after the content scan, before the file append). */
  onSummary?: (summary: GatewayLcmShadowSummary) => void;
}

export interface ResolvedLcmShadowConfig {
  enabled: boolean;
  timeoutMs: number;
  runner?: GatewayLcmShadowRunner;
  onSummary?: (summary: GatewayLcmShadowSummary) => void;
}

/**
 * Resolve the shadow config once at server creation. DEFAULT OFF: enabled only by the explicit
 * option or `COMPACTION_LCM_SHADOW=1|true`; an explicit `enabled: false` beats the env gate.
 */
export function resolveLcmShadowConfig(
  options?: GatewayLcmShadowOptions,
  env: NodeJS.ProcessEnv = process.env
): ResolvedLcmShadowConfig {
  const raw = env[GATEWAY_LCM_SHADOW_ENV];
  const envEnabled = raw === "1" || (typeof raw === "string" && raw.toLowerCase() === "true");
  // Budget precedence: explicit option > env override (slow local inference) > default.
  const envTimeout = Number(env[GATEWAY_LCM_SHADOW_TIMEOUT_ENV]);
  const timeoutMs = options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      : DEFAULT_LCM_SHADOW_TIMEOUT_MS;
  return {
    enabled: options?.enabled ?? envEnabled,
    timeoutMs,
    ...(options?.runner ? { runner: options.runner } : {}),
    ...(options?.onSummary ? { onSummary: options.onSummary } : {})
  };
}

/** Build a fail-open summary, a reason class label only, never error/content text. */
export function lcmShadowFailOpenSummary(endpoint: string, reason: LcmShadowFailOpenReason): GatewayLcmShadowSummary {
  return {
    schema: GATEWAY_LCM_SHADOW_SCHEMA,
    status: "fail-open",
    endpoint,
    reason,
    applied: false,
    modelVisibleBytesChanged: false,
    label: GATEWAY_LCM_SHADOW_LABEL
  };
}

/**
 * Classify a shadow-path error into its fail-open reason class (exported for the shipped-package test).
 * Only the absence of an ENGINE-TREE module is `engine-unavailable`; a real error raised inside a
 * PRESENT engine — including a module-not-found for a dependency outside the engine tree, which is a
 * packaging defect — is a model-error and must never read as "the engine is not installed".
 */
export function lcmShadowFailOpenReasonForError(error: unknown): LcmShadowFailOpenReason {
  return isModuleTreeAbsentError(error, PRIVATE_ENGINE_TREE) ? "engine-unavailable" : "model-error";
}

/**
 * Lazily load the engine's default shadow runner. Dynamic `import()` ONLY, this call is the single
 * place the shadow path touches the engine, and it is unreachable unless shadow is enabled.
 */
const ENGINE_SHADOW_RUNNER_MODULE = "../../engine/lcm/gateway-shadow-runner.js";

async function loadDefaultEngineRunner(): Promise<GatewayLcmShadowRunner> {
  const mod = (await import(ENGINE_SHADOW_RUNNER_MODULE)) as {
    defaultGatewayLcmShadowRunner: GatewayLcmShadowRunner;
  };
  return mod.defaultGatewayLcmShadowRunner;
}

/** Race `work` against the bounded budget; a late settle (either way) is detached, never unhandled. */
async function withTimeout(
  work: Promise<GatewayLcmShadowSummary>,
  timeoutMs: number
): Promise<{ timedOut: false; summary: GatewayLcmShadowSummary } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([work.then((summary) => ({ timedOut: false as const, summary })), expiry]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {}); // a rejection after the race settled must never become an unhandled rejection
  }
}

/** Append one summary line to the local-only sidecar. Best-effort; the caller already fire-and-forgets. */
async function appendLcmShadowSummary(summary: GatewayLcmShadowSummary, cwd: string): Promise<void> {
  const dir = path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR);
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, GATEWAY_LCM_SHADOW_FILE), `${JSON.stringify(summary)}\n`, "utf8");
}

/**
 * Run ONE detached shadow evaluation. NEVER throws (the proxy `void`s this promise; any escape
 * would surface as an unhandled rejection, so every path is caught). Emits exactly one summary:
 * to the `onSummary` hook, the local sidecar, and one content-free log line.
 */
export async function runGatewayLcmShadowEvaluation(params: {
  endpoint: string;
  /** The ORIGINAL request body text. Read locally by the engine only; never logged, never stored here. */
  requestBodyText: string;
  config: ResolvedLcmShadowConfig;
  cwd: string;
  log: (line: string) => void;
}): Promise<void> {
  let summary: GatewayLcmShadowSummary;
  try {
    const runner = params.config.runner ?? (await loadDefaultEngineRunner());
    const result = await withTimeout(runner(params.endpoint, params.requestBodyText), params.config.timeoutMs);
    summary = result.timedOut ? lcmShadowFailOpenSummary(params.endpoint, "timeout") : result.summary;
  } catch (error) {
    summary = lcmShadowFailOpenSummary(params.endpoint, lcmShadowFailOpenReasonForError(error));
  }

  // Fail-closed content tripwire: nothing content-shaped leaves this module. The engine projection
  // already scanned the evidence document; this re-scan covers the whole summary (and any injected
  // runner's output). A violating summary is REPLACED by a fail-open record - never emitted.
  try {
    const scan = scanContentFreeLcmEvidence(summary);
    if (!scan.ok) summary = lcmShadowFailOpenSummary(params.endpoint, "invalid-candidate");
  } catch {
    summary = lcmShadowFailOpenSummary(params.endpoint, "invalid-candidate");
  }

  try {
    params.config.onSummary?.(summary);
  } catch {
    // an observer error never breaks the shadow path (and can never reach the proxy)
  }
  try {
    await appendLcmShadowSummary(summary, params.cwd);
  } catch {
    // best-effort sidecar; a write failure is not a proxy failure
  }
  try {
    const detail =
      summary.status === "fail-open"
        ? `fail-open (${summary.reason})`
        : `evaluated outcome=${summary.evidence.candidateKind} delta=${
            summary.comparison.deltaPercentPoints === null ? "n/a" : `${summary.comparison.deltaPercentPoints}pp`
          } (local estimate)`;
    params.log(`compaction gateway: lcm shadow ${detail} - shadow-only; live bytes unchanged; content-free.`);
  } catch {
    // logging is best-effort too
  }
}
