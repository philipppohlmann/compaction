/**
 * Compaction Gateway server (public CLI/SDK core; engine-free).
 *
 * A local, byte-safe, OpenAI-compatible reverse proxy: the client points its base URL at this gateway; the
 * gateway forwards the request to the real provider byte-for-byte, streams the response back byte-for-byte,
 * and records one content-free receipt (`receipt.ts`) with the provider's reported token/cache usage. It
 * NEVER mutates the request or response in record mode (model-visible bytes unchanged), NEVER stores
 * content, and NEVER persists the client's API key.
 *
 * Default `record` mode only (no cache-optimization, no LCM); `apply`/`dry-run` require explicit opt-in.
 * STORED-AUTHORIZATION auto-apply exists but is DEFAULT OFF twice over: the server must be started with a
 * declared `workflow` identity AND a stored, enabled, narrow-scoped `auto-when-gates-pass` preference must
 * pass every fail-closed eligibility gate (`apply-eligibility.ts`), otherwise every request is plain
 * record. The RESPONSE is never mutated on any path.
 *
 * PRIVATE-ENGINE BOUNDARY: for the stored-authorization path this file decides WHETHER apply is
 * allowed (the public auth/scope/endpoint gates), retains the byte-exact original, and forwards the
 * result — but it no longer runs the optimization ALGORITHM in-process. The deterministic-dedupe input
 * compaction, the LCM hybrid candidate, and the adaptive output shaping run inside the supervised
 * private native engine (`engine-ipc/supervisor.ts` → the sidecar's `plan_and_apply`); this file
 * reaches them ONLY over that spawned IPC (never by importing the algorithm modules). Any engine
 * degrade / refusal / no-op / error → forward the ORIGINAL unchanged (fail-open).
 *
 * LCM SHADOW evaluation is likewise explicit opt-in and DEFAULT OFF (`lcmShadow` option or
 * `COMPACTION_LCM_SHADOW=1`): when off, this file behaves byte-identically to a build without the hook;
 * when on, evaluation runs post-response on a detached promise (`lcm-shadow.ts`) and can never touch
 * the forwarded request, the response, routing, or approval state. Built on `node:http`; zero new dependency.
 */
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream";
import { URL } from "node:url";
import type { GatewayReceipt } from "./receipt.js";
import { buildGatewayReceipt, appendGatewayReceipt } from "./receipt.js";
import {
  communityFullApplyReceiptLine,
  receiptCeiling,
  isRealApply,
  isReceiptLineEnabled,
  outputShapingActiveForTurn,
  receiptLineFromGatewayReceipt,
  receiptProvenOpenLabel
} from "./receipt-line.js";
// The per-turn output arrow's calibrated rate (local, content-free; absent ⇒ a plain output count).
import {
  estimatePerTurnOutputSaved,
  loadCalibrationReduction,
  type PerTurnEstimatedSaved
} from "../output-shaping-savings.js";
import { outputCalibrationQuery } from "../output-shaping-calibration-store.js";
import { adapterForUpstream, openAiBreakdownFromNormalizedUsage, type ProviderAdapter } from "./provider-adapter.js";
import type { OpenAiUsageBreakdown } from "./openai-usage.js";
import { resolveApplyActivation, type ApplyActivation } from "./apply-activation.js";
import { DEDUPE_POLICY, type DedupePlan } from "./request-shape.js";
import { planInputCompaction } from "./input-compaction-seam.js";
import { planBestSafeOptimization } from "./optimization-planner.js";
import type { OptimizationPlan as OptimizationPlanType } from "./optimization-planner.js";
import {
  evaluateStoredApplyGates,
  findStoredAuthorization,
  type ApplyRequestScope
} from "./apply-eligibility.js";
import { LCM_APPLY_POLICY } from "./lcm-qualified-classes.js";
import { EngineSupervisor } from "./engine-ipc/supervisor.js";
import { decideEngineApply, type EngineApplyDecision } from "./engine-ipc/engine-apply-seam.js";
import { appendAutoApplyActivityEvent } from "./auto-apply-activity.js";
import { saveOriginalForRecovery, discardRecoveryRecord, GATEWAY_RECOVERY_DIR } from "./recovery.js";
// `OPEN_BASIC_OUTPUT_POLICY` is imported rather than re-spelled: the recovery record and the receipt
// must name the SAME policy, and two literals is how they drift apart.
import { buildApplyReceipt, OPEN_BASIC_OUTPUT_POLICY } from "./apply-receipt.js";
import {
  gatewaySessionCorrelation
} from "./session-correlation.js";
// OPEN `basic` gateway shaping: the engine-free public planner, its
// double-shaping guard, and the SAME activation switch the tool-hook path reads.
import {
  planPublicBasicOutputShaping,
  bodyAlreadyCarriesOutputShaping,
  outputShapingActiveOnRequest,
  outputShapingPolicyVersionOnRequest
} from "./output-shaping-policy.js";
import { isShapingHooksActivated } from "../output-shaping-hook-activation.js";
import { effectiveOpenTier, readOptimizationMode, resolveOpenTier } from "../onboarding-preferences.js";
import type { OptimizationModePreference } from "../onboarding-preferences.js";
import { readLeaseVerdict } from "../entitlement/lease-store.js";
import { periodEndUtc } from "../entitlement/lease.js";
import type { AllowancePauseScope } from "../onboarding-preferences.js";
import type { AllowancePauseReason } from "../upgrade-cta.js";
import { commitApplyDebit, meteringDeclineExplanation, readMeteredAllowance } from "./metering-seam.js";
import {
  ACTIVE_USAGE_METER_VERSION,
  API_KEY_ROUTE_TYPE,
  SUBSCRIPTION_ROUTE_TYPE,
  resolveMeteredOptimizedInput
} from "../usage/usage-event.js";
import { isShapingStopped } from "../subscription-shaping-state.js";
import type { OptimizationPlan } from "./optimization-planner.js";
import {
  resolveLcmShadowConfig,
  runGatewayLcmShadowEvaluation,
  type GatewayLcmShadowOptions,
  type ResolvedLcmShadowConfig
} from "./lcm-shadow.js";
import {
  CLAUDE_SUBSCRIPTION_UPSTREAM,
  classifyClaudeSubscriptionTarget,
  forwardedRawRequestHeaders,
  safeClaudeSubscriptionResponseHeaders,
  type ClaudeSubscriptionEnvelope
} from "./claude-subscription-route.js";
import { assembleHeadTail, createUsageTee } from "./usage-response-tee.js";
import { attachBookkeepingDrain, PendingBookkeeping } from "./pending-bookkeeping.js";
/** The engine decision narrowed to the applied branch (the only branch this path carries forward). */
type AppliedEngineDecision = Extract<EngineApplyDecision, { decision: "apply" }>;


/**
 * How much of the RESPONSE tail to keep for usage parsing (bounded, never the whole body). The
 * provider's terminal usage rides in the final chunk: OpenAI's final SSE chunk / Anthropic's
 * `message_delta` (output_tokens) / a non-streaming JSON body's `usage`.
 */
export const USAGE_TAIL_BYTES = 64 * 1024;
/**
 * How much of the RESPONSE head to keep for usage parsing (bounded, never the whole body). Anthropic
 * STREAMING (what Claude Code uses) puts `input_tokens` (+ cache fields) in the FIRST SSE event
 * (`message_start`), which the tail alone never sees — so a head window is captured too. 16 KiB is far
 * larger than any `message_start` event yet stays strictly bounded. Head + tail are fed together to the
 * adapter, whose SSE scanner reads usage from every `data:` event, so it gets the input event (head) and
 * the output event (tail) while the large content deltas in the middle are dropped.
 */
export const USAGE_HEAD_BYTES = 16 * 1024;
/** Cap the buffered REQUEST body (forwarded verbatim). Large enough for any normal chat request. */
const MAX_REQUEST_BYTES = 25 * 1024 * 1024;

/** Hop-by-hop headers that must NOT be blindly forwarded (node manages the connection). */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/**
 * Client-facing keep-alive: node's 5s default drops a pooled CLIENT socket that idles between turns,
 * which a client reusing its connection sees as a mid-session disconnect. Raised comfortably above a
 * typical inter-turn idle; `headersTimeout` MUST exceed `keepAliveTimeout` or node races the two and
 * can kill a socket that just started a new request.
 */
const CLIENT_KEEP_ALIVE_TIMEOUT_MS = 61_000;
const CLIENT_HEADERS_TIMEOUT_MS = 65_000;

/**
 * Connect + time-to-first-byte guard: an upstream that never sends response headers must not hang the
 * client forever. Released the moment the response starts, so a legitimately long or quiet stream is
 * never killed mid-flight. (Upstream connection pooling is left to node's default agent, unchanged.)
 */
const UPSTREAM_STALL_TIMEOUT_MS = 30_000;

/** A request-body overflow, distinguished from a client abort/read failure (which is NOT a 413). */
class RequestBodyLimitError extends Error {
  constructor() {
    super("request body exceeds gateway limit");
    this.name = "RequestBodyLimitError";
  }
}

/** The server's configured gateway mode. Default `record`; `apply`/`dry-run` require explicit opt-in. */
export type GatewayServerMode = "record" | "apply" | "dry-run";

export interface GatewayServerOptions {
  provider: string;
  /** The upstream provider base (only its ORIGIN is used; the client's request path is authoritative). */
  upstream: string;
  /**
   * Optional per-endpoint upstream routing so ONE gateway serves multiple providers. A request whose
   * path ends with a route's `endpointSuffixes` is forwarded to that route's `upstream` and labeled
   * with its `provider` (the usage adapter follows the upstream automatically). No match → the default
   * `upstream`/`provider`. Example: `[{ endpointSuffixes: ["/messages"], provider: "anthropic",
   * upstream: "https://api.anthropic.com" }]` alongside a default OpenAI upstream. Ignored when
   * `claudeSubscription` is set (that transport is pinned).
   */
  providerRoutes?: ReadonlyArray<{ endpointSuffixes: readonly string[]; provider: string; upstream: string }>;
  /** `record` (default, byte-safe), or the explicit `apply`/`dry-run` deterministic modes. */
  mode: GatewayServerMode;
  /** Deterministic apply policy. Only `deterministic-dedupe` is implemented. */
  policy?: string;
  /** Where receipts are written (defaults to process.cwd()). */
  cwd?: string;
  /**
   * The workflow/tool identity of THIS gateway connection (content-free id, e.g. "claude-code" /
   * "codex"). Required for STORED-AUTHORIZATION auto-apply: without it the stored preference file
   * is never consulted and the gateway behaves exactly as before (record / explicit apply only).
   * The gateway never guesses a workflow from traffic, identity is declared at start, or absent.
   */
  workflow?: string;
  /** The repo identity of this connection, where detectable (content-free id; used for scope match only). */
  repo?: string;
  /** Test/embedding override; when absent the enum-only onboarding preference is read fresh. */
  optimizationMode?: OptimizationModePreference;
  /**
   * Test/embedding override for the config-dir env used to resolve this DEVICE's local state
   * (`COMPACTION_CONFIG_DIR`). When absent, `process.env` is used. Only ever consulted to read local
   * FILES — the signed lease + credentials for the community-full-apply entitlement check, the metering
   * journal, and the stored auto-apply authorization — never for a network/account call. The
   * authorization joined this set when the store moved off the working directory: a device's lease and
   * its authorization must be read from one environment, or a test (or an embedder) can end up proving
   * a request against two different devices.
   */
  entitlementEnv?: NodeJS.ProcessEnv;
  /** Test/observability hook fired after each receipt is built (before/independent of the file append). */
  onReceipt?: (receipt: GatewayReceipt) => void;
  /** Best-effort logger for content-free operational lines (defaults to no-op). */
  log?: (line: string) => void;
  /**
   * LCM SHADOW evaluation, explicit opt-in, DEFAULT OFF (see `lcm-shadow.ts`). Off (unset) means:
   * no shadow code runs, no engine import is attempted, no receipt/output change. On means: a
   * detached post-response evaluation the request/response path never awaits.
   */
  lcmShadow?: GatewayLcmShadowOptions;
  /** Internal, default-off Claude Code saved-subscription transport envelope. */
  claudeSubscription?: ClaudeSubscriptionEnvelope;
  /**
   * Idle auto-shutdown TTL in milliseconds, DEFAULT OFF (absent or 0 = the server never self-stops).
   * When > 0, the started server tracks the time of its last handled request and, once it has been
   * idle longer than the TTL with NO request in flight, stops accepting connections, closes the
   * listener, and fires `onIdleShutdown`. It NEVER interrupts an in-flight request. This is a pure
   * OPT-IN: the transparent-routing gateway (`gateway ensure`) is PERSISTENT by default and spawns
   * `gateway start` WITHOUT `--idle-ttl`, so it never self-stops under a live session; a TTL is
   * passed only when a user opts in (env/option). An explicit `gateway start` likewise stays
   * long-lived unless the flag is given.
   */
  idleTtlMs?: number;
  /** Fired once when the idle TTL triggers shutdown (as the listener closes). The CLI removes the pidfile here. */
  onIdleShutdown?: () => void;
  /**
   * Test/embedding override for the upstream stall guard (ms). When absent the default
   * `UPSTREAM_STALL_TIMEOUT_MS` applies to the CONNECT + time-to-first-byte phase only: an upstream
   * that never responds is destroyed and surfaced as an honest gateway error instead of hanging the
   * client forever. The guard is released the moment the response begins, so a legitimately long or
   * quiet stream is never killed mid-flight.
   */
  upstreamTimeoutMs?: number;
}

/**
 * Assemble the bounded HEAD + TAIL windows of a streamed response into the text fed to the usage adapter,
 * WITHOUT double-feeding or corrupting an overlapping / small / medium body.
 *
 * `totalBytes` is the full length of the streamed body (bytes seen, never buffered whole). Three cases:
 *  - `totalBytes ≤ USAGE_TAIL_BYTES`: the TAIL captured the ENTIRE body verbatim → feed the tail alone. This
 *    keeps a non-streaming JSON body (or any body ≤ tail) intact and parseable exactly as before this change
 *    (no head/tail concatenation is spliced into it), so the head+tail addition can never regress a body the
 *    tail already fully held.
 *  - otherwise the body exceeded the tail window, so the disjoint HEAD (first `message_start` for Anthropic
 *    streaming) and TAIL (final `message_delta` / usage chunk) are fed together as `head + "\n" + tail`. They
 *    do not overlap (total > tail ≥ head implies the head's byte range ends before the tail's begins), so no
 *    line is duplicated; the newline keeps the seam a clean SSE/line boundary; the dropped middle is the
 *    large content deltas we intend to lose. The head cap may split its final partial `data:` line — the
 *    adapter's JSON-per-line parse simply skips an unparseable partial, and `message_start` is far smaller
 *    than the head window, so the input-usage event survives intact.
 *
 * READ-ONLY copy of already-forwarded bytes; it never touches what the client received.
 */
export function headAndTailForUsage(head: Buffer[], tail: Buffer[], totalBytes: number): string {
  return assembleHeadTail(head, tail, totalBytes, USAGE_TAIL_BYTES);
}

/**
 * When the usage-parsing copy could NOT be decompressed, the adapter (fed an empty body) already returns
 * an absent breakdown — this replaces its generic "empty body" reason with the honest decompression reason
 * so the receipt says WHY usage is unavailable. It never fabricates present usage; if the adapter did read
 * real usage (identity/uncompressed), the breakdown is returned unchanged.
 */
function usageWithReason(breakdown: OpenAiUsageBreakdown, decompressionReason?: string): OpenAiUsageBreakdown {
  if (!decompressionReason || breakdown.present) return breakdown;
  return { ...breakdown, present: false, unavailableReason: decompressionReason };
}

/** Best-effort, content-free extraction of the `model` field from a request body (metadata, not content). */
function requestModel(body: Buffer): string | undefined {
  const text = body.toString("utf8").trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    return typeof obj.model === "string" ? obj.model : undefined;
  } catch {
    return undefined;
  }
}

/** Read the full request body into a Buffer (byte-exact, for verbatim forwarding). */
function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new RequestBodyLimitError());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Create (but do not start) the gateway record-mode server. `createGatewayServer` is exported so tests
 * can bind an ephemeral port. Every request is forwarded byte-for-byte; the receipt append is
 * best-effort and NEVER alters or delays the client's response bytes.
 */
export function createGatewayServer(options: GatewayServerOptions): http.Server {
  if (options.mode !== "record" && options.mode !== "apply" && options.mode !== "dry-run") {
    // The server refuses to pretend to support a mode it does not implement.
    throw new Error(`gateway mode '${options.mode}' is not implemented (record | apply | dry-run)`);
  }
  const log = options.log ?? (() => {});
  if (options.claudeSubscription && (options.provider !== "anthropic" || options.workflow !== "claude-code")) {
    throw new Error("Claude subscription transport requires the anthropic provider and claude-code workflow");
  }
  // Subscription traffic is unconditionally pinned. Tests may replace only the request transport;
  // the request options presented to that seam still name api.anthropic.com.
  const upstreamOrigin = options.claudeSubscription ? CLAUDE_SUBSCRIPTION_UPSTREAM : new URL(options.upstream).origin;
  // Resolved ONCE at server creation; when disabled (the default) handleProxy's shadow branch is dead.
  const lcmShadow = resolveLcmShadowConfig(options.lcmShadow);
  // The supervised private native engine. Created once per server; it spawns the engine child
  // lazily on the FIRST stored-authorization apply attempt and reuses it (the whole point of the
  // supervisor). When the engine is absent (the default dev/npm state until `engine install` delivers the signed
  // artifact) every request degrades fail-open and the gateway forwards the original unchanged.
  const engineSupervisor = new EngineSupervisor();
  // The detached bookkeeping writes (receipt append, auto-apply activity append) still in flight.
  // The REQUEST path never awaits them; `close()` does, so stopping the gateway does not discard the
  // last turn's receipt (`pending-bookkeeping.ts`).
  const pendingBookkeeping = new PendingBookkeeping();
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_STALL_TIMEOUT_MS;
  const server = http.createServer((req, res) => {
    if (options.claudeSubscription) {
      const classified = classifyClaudeSubscriptionTarget(req.url, req.method, options.claudeSubscription.capability);
      if (!classified) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "compaction gateway: route unavailable", type: "gateway_error" } }));
        return;
      }
      // Strip the bearer-like local route capability before any upstream construction or logging.
      req.url = classified.upstreamTarget;
      if (classified.route !== "messages") {
        void handleClaudeSupportRequest(
          req,
          res,
          upstreamOrigin,
          classified.upstreamTarget,
          classified.route === "count-tokens",
          upstreamTimeoutMs
        );
        return;
      }
      // Subscription 'messages' uses the pinned upstream, multi-provider routing does not apply.
      void handleProxy(req, res, options, upstreamOrigin, log, lcmShadow, engineSupervisor, pendingBookkeeping);
      return;
    }
    // Multi-provider routing: pick the upstream + provider for THIS request's endpoint. Default
    // single-upstream behavior when no `providerRoutes` match.
    const route = resolveProviderRoute(req.url ?? "/", options, upstreamOrigin);
    const effectiveOptions = route.provider === options.provider ? options : { ...options, provider: route.provider };
    void handleProxy(req, res, effectiveOptions, route.upstreamOrigin, log, lcmShadow, engineSupervisor, pendingBookkeeping);
  });
  // Client-facing connection lifecycle: keep pooled client sockets alive across inter-turn idle
  // (node's 5s default silently drops them mid-session); headersTimeout must stay >= keepAliveTimeout.
  server.keepAliveTimeout = CLIENT_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = CLIENT_HEADERS_TIMEOUT_MS;
  // Terminate the supervised engine child when the gateway closes (idle-shutdown or explicit stop),
  // so no orphaned engine process outlives the server. Idempotent + never throws.
  server.on("close", () => engineSupervisor.dispose());
  // ...and hold `close()` open until the detached bookkeeping writes have landed (bounded), so a
  // stopped gateway does not silently drop the receipt for the turn that just completed.
  attachBookkeepingDrain(server, pendingBookkeeping);
  return server;
}

/**
 * Resolve the upstream ORIGIN + provider label for one request. A path ending with a configured
 * route's suffix wins; otherwise the default upstream/provider. The usage adapter is derived from the
 * returned origin downstream, so routing to Anthropic vs OpenAI is enough, no per-route adapter wiring.
 */
function resolveProviderRoute(
  url: string,
  options: GatewayServerOptions,
  defaultUpstreamOrigin: string
): { upstreamOrigin: string; provider: string } {
  const path = (url.split("?")[0] ?? "/") || "/";
  const route = options.providerRoutes?.find((r) => r.endpointSuffixes.some((suffix) => path.endsWith(suffix)));
  if (route) {
    try {
      return { upstreamOrigin: new URL(route.upstream).origin, provider: route.provider };
    } catch {
      // A malformed route upstream is ignored (fail-safe to the default) rather than breaking the proxy.
    }
  }
  return { upstreamOrigin: defaultUpstreamOrigin, provider: options.provider };
}

/** HEAD startup and count_tokens are allowlisted byte-transparent support routes: no receipt or apply. */
async function handleClaudeSupportRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamOrigin: string,
  upstreamTarget: string,
  hasBody: boolean,
  upstreamTimeoutMs: number
): Promise<void> {
  let body: Buffer = Buffer.alloc(0);
  if (hasBody) {
    try {
      body = await readOpaqueBoundedBody(req);
    } catch (error) {
      writeRequestBodyFailure(res, error);
      return;
    }
  } else {
    req.resume();
  }
  await passThroughClaudeSupportRequest(req, res, upstreamOrigin, upstreamTarget, body, upstreamTimeoutMs);
}

/**
 * Answer a failed request-body read honestly: only a genuine size overflow is 413; a client abort or
 * connection error mid-body is a 400 (best-effort — the client is usually already gone).
 */
function writeRequestBodyFailure(res: http.ServerResponse, error: unknown): void {
  const tooLarge = error instanceof RequestBodyLimitError;
  if (!res.headersSent) {
    res.writeHead(tooLarge ? 413 : 400, { "content-type": "application/json" });
  }
  res.end(
    JSON.stringify({
      error: {
        message: tooLarge
          ? "compaction gateway: request body too large"
          : "compaction gateway: request body could not be read (client aborted or connection failed)",
        type: "gateway_error"
      }
    })
  );
}

function readOpaqueBoundedBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = req.headers["content-length"];
    if (typeof declared === "string" && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BYTES) {
      req.resume();
      reject(new RequestBodyLimitError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        exceeded = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => exceeded ? reject(new RequestBodyLimitError()) : resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function passThroughClaudeSupportRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamOrigin: string,
  upstreamTarget: string,
  body: Buffer,
  upstreamTimeoutMs: number
): Promise<void> {
  return new Promise((resolve) => {
    const target = new URL(upstreamTarget, upstreamOrigin);
    const client = target.protocol === "http:" ? http : https;
    const requestOptions: http.RequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers: forwardedRawRequestHeaders(req, target.host, body.length)
    };
    const upstreamReq = client.request(
      requestOptions,
      (upstreamRes) => {
        // Response started: release the connect/first-byte guard so a long or quiet stream is never
        // killed mid-flight (the streaming phase stays unbounded, as before).
        upstreamReq.setTimeout(0);
        const status = upstreamRes.statusCode ?? 502;
        const headers = safeClaudeSubscriptionResponseHeaders(status, upstreamRes.rawHeaders, upstreamOrigin);
        if (!headers) {
          upstreamRes.resume();
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "compaction gateway: upstream redirect rejected", type: "gateway_error" } }));
          resolve();
          return;
        }
        res.writeHead(status, headers);
        // `pipeline` (not raw pipe) so a mid-stream upstream error is CAUGHT: the client stream is
        // aborted cleanly instead of the error crashing the process or bytes being spliced.
        pipeline(upstreamRes, res, (err) => {
          if (err) res.destroy();
          resolve();
        });
      }
    );
    // Connect + time-to-first-byte guard only (released in the response callback once bytes flow).
    upstreamReq.setTimeout(upstreamTimeoutMs, () => upstreamReq.destroy(new Error("upstream timeout")));
    upstreamReq.on("error", () => {
      // Never splice an error JSON into an already-streaming body: after headers, just end.
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "compaction gateway: upstream request failed", type: "gateway_error" } }));
      } else {
        res.end();
      }
      resolve();
    });
    if (body.length > 0) upstreamReq.write(body);
    upstreamReq.end();
  });
}

async function handleProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: GatewayServerOptions,
  upstreamOrigin: string,
  log: (line: string) => void,
  lcmShadow: ResolvedLcmShadowConfig,
  supervisor: EngineSupervisor,
  pendingBookkeeping: PendingBookkeeping
): Promise<void> {
  const endpoint = (req.url ?? "/").split("?")[0];
  // WHEN THE REQUEST ARRIVED, stamped before anything is read or forwarded. The receipt's own
  // `captured_at` is assigned only after the response has fully streamed and the usage window has been
  // assembled (on a compressed response, after an asynchronous decompressor flush) — by which time the
  // client has the response and its `Stop` hook may already have closed the run. Run membership keys on
  // THIS instant, which is provably before any response and therefore before any `Stop` it triggers.
  const requestStartedAt = new Date().toISOString();
  // THE UPSTREAM BILLING ROUTE for this request, evidenced by what this request presented (see
  // `upstreamRouteTypeFor`). Resolved once here and handed to both records that need it — the signed
  // usage debit and the apply receipt — so the two can never be derived differently.
  const upstreamRouteType = upstreamRouteTypeFor(options, req);
  // Route usage extraction through the provider adapter (default = OpenAI, so OpenAI behavior is
  // byte-identical). Content-free: the adapter only ever reads token counts + labels from the response.
  const adapter = adapterForUpstream(upstreamOrigin);
  // Optional CLIENT-SET proof-run grouping id, READ ONLY (an opaque label, not content). The gateway
  // never injects/mutates the request; this header (when the client sends it) is forwarded to the
  // upstream unchanged AND recorded on the receipt so a manual proof run can pair its receipts.
  const proofHeader = req.headers["x-compaction-proof-run"];
  const proofRunId = typeof proofHeader === "string" && proofHeader.trim() !== "" ? proofHeader : undefined;
  const proofVariantHeader = req.headers["x-compaction-proof-variant"];
  const proofVariantRaw = typeof proofVariantHeader === "string" ? proofVariantHeader.trim() : undefined;
  const proofVariant: "baseline" | "compacted" | undefined =
    proofVariantRaw === "baseline" || proofVariantRaw === "compacted" ? proofVariantRaw : undefined;
  let requestBody: Buffer;
  try {
    requestBody = await readRequestBody(req);
  } catch (error) {
    if (!(error instanceof RequestBodyLimitError)) {
      // Content-free: the class only. A client abort mid-body is routine, not a size overflow.
      const errorClass = error instanceof Error ? error.name : typeof error;
      log(`compaction gateway: request body read failed for ${endpoint} (${errorClass}) - not a size overflow.`);
    }
    writeRequestBodyFailure(res, error);
    return;
  }

  // Resolve EXPLICIT apply activation (default record → byte-safe passthrough, exactly as before). Apply
  // requires the server's `--mode apply --policy …` OR the request's x-compaction-mode/-policy headers;
  // a conflict fails closed (record). The ORIGINAL request bytes are the default forwarded body.
  const activation = resolveApplyActivation({
    serverMode: options.mode,
    ...(options.policy ? { serverPolicy: options.policy } : {}),
    ...(headerValue(req.headers["x-compaction-mode"]) ? { headerMode: headerValue(req.headers["x-compaction-mode"]) } : {}),
    ...(headerValue(req.headers["x-compaction-policy"]) ? { headerPolicy: headerValue(req.headers["x-compaction-policy"]) } : {})
  });

  // STORED-AUTHORIZATION auto-apply: consulted ONLY when NO explicit per-call intent exists
  // (explicit `--mode apply` / headers keep their exact behavior; an explicit per-call
  // `x-compaction-mode` header, including the `record` opt-out, always wins and suppresses the
  // stored path), the request is a POST, and this gateway connection declared a workflow identity.
  // The preference file is read FRESH each request (disable/restart honored on the very next run);
  // every eligibility gate must pass fail-closed; ANY failure (lookup, evaluation, retention) →
  // plain record, original forwarded unchanged (fail-open, never blocks the workflow).
  let effectiveActivation = activation;
  let apply = await resolveApplyOutcomeFailOpen(activation, endpoint, req.method, requestBody, options, log);
  // WHY LCM DID OR DID NOT CONTRIBUTE when the engine ran and applied NOTHING. The turn stays a plain
  // record (original forwarded unchanged), but the outcome is a fact about it and rides the record
  // receipt — the did-not-contribute turns are the ones the outcome exists to explain.
  let declinedLcmOutcome: { kind: string; reason: string } | undefined;
  let declinedOutputShapingState: "attached-this-pass" | "already-active" | "absent" | undefined;
  let declinedOutputShapingPolicyVersion: string | undefined;
  const explicitPerCallMode = headerValue(req.headers["x-compaction-mode"]) !== undefined;
  if (!activation.requested && !explicitPerCallMode && req.method === "POST" && options.workflow) {
    const stored = await resolveStoredAuthorizationApply(endpoint, requestBody, options, log, supervisor, upstreamRouteType);
    if (stored && "outcome" in stored) {
      effectiveActivation = stored.activation;
      apply = stored.outcome;
    } else if (stored) {
      declinedLcmOutcome = stored.lcmOutcome;
      declinedOutputShapingState = stored.outputShapingState;
      declinedOutputShapingPolicyVersion = stored.outputShapingPolicyVersion;
    }
  }
  // OPEN `basic` output shaping — the THIRD and last apply path.
  // Consulted only when nothing above applied: explicit per-call intent keeps its exact behaviour, and
  // a stored-authorization full apply already includes output shaping, so running after it would
  // attach the block twice. Unlike the stored path this does NOT require a declared workflow identity:
  // Open basic is account-free, engine-free and tool-agnostic — the mode preference is the whole
  // authorization. Synchronous and local: a plan, a file write, no engine and no network.
  if (!activation.requested && !explicitPerCallMode && req.method === "POST" && !apply?.applied) {
    const openBasic = resolveOpenBasicOutputShaping(endpoint, requestBody, options, log);
    if (openBasic) {
      effectiveActivation = openBasic.activation;
      apply = openBasic.outcome;
    }
  }

  let bodyToForward = requestBody;
  if (apply?.applied && apply.mutatedBody) bodyToForward = apply.mutatedBody;

  // EXPLICIT-APPLY OUTPUT-SHAPING PROVENANCE. This route compacts input only; it does not attach
  // output shaping itself. The policy may nevertheless already be active on the request because a
  // tool hook attached it before the gateway saw the body. Measure that fact only after the FINAL
  // forwarded bytes have been selected, because the deterministic mutation may reserialize them.
  //
  // This is intentionally positive-only and strict: the exact current policy must survive inside an
  // instruction-level carrier. A marker in arbitrary body/user text proves nothing, and a miss leaves
  // both fields unset rather than synthesizing `absent`. Dry-run, stored/full, Open-basic and record
  // routes retain their existing provenance owners.
  if (
    apply &&
    activation.mode === "apply" &&
    (activation.activation === "explicit-mode" || activation.activation === "explicit-header")
  ) {
    const detectedPolicyVersion = outputShapingPolicyVersionOnRequest(bodyToForward.toString("utf8"));
    if (detectedPolicyVersion) {
      apply.outputShapingState = "already-active";
      apply.outputShapingPolicyVersion = detectedPolicyVersion;
    }
  }

  const target = new URL((req.url ?? "/"), upstreamOrigin);
  const client = target.protocol === "http:" ? http : https;

  // Forward headers verbatim EXCEPT host (must be the upstream host), content-length (recomputed from the
  // forwarded body), hop-by-hop headers, and Compaction's own control headers (mode/policy are local-only
  // and are NEVER sent upstream). The client's Authorization rides through untouched and is NEVER read,
  // stored, or logged by the gateway.
  const headers: http.OutgoingHttpHeaders | string[] = options.claudeSubscription
    ? forwardedRawRequestHeaders(req, target.host, bodyToForward.length)
    : ordinaryForwardedHeaders(req, target.host, bodyToForward.length);

  const requestOptions: http.RequestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.pathname + target.search,
    method: req.method,
    headers
  };
  const upstreamReq = client.request(
      requestOptions,
      (upstreamRes) => {
        // Response started: release the connect/first-byte guard so a long or quiet stream is never
        // killed mid-flight (an LLM turn can go quiet for extended thinking / a slow tool call). The
        // streaming phase stays unbounded, as before, while a never-responding upstream is still bounded.
        upstreamReq.setTimeout(0);
        // Forward status + headers VERBATIM, then stream the body byte-for-byte to the client.
        const status = upstreamRes.statusCode ?? 502;
        const subscriptionHeaders = options.claudeSubscription
          ? safeClaudeSubscriptionResponseHeaders(status, upstreamRes.rawHeaders, upstreamOrigin)
          : undefined;
        if (options.claudeSubscription && !subscriptionHeaders) {
          upstreamRes.resume();
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "compaction gateway: upstream redirect rejected", type: "gateway_error" } }));
          return;
        }
        res.writeHead(
          status,
          options.claudeSubscription ? subscriptionHeaders! : upstreamRes.headers
        );
        // Byte-safe: the client sees the exact upstream bytes (streaming or not). `pipeline` (not raw
        // pipe) so a mid-stream upstream error is CAUGHT instead of becoming an uncaught 'error' that
        // crashes the process: on failure the client stream is aborted cleanly (truncation stays
        // visible to the client - nothing is ever spliced into a partially streamed body).
        pipeline(upstreamRes, res, (err) => {
          if (err) {
            log(`compaction gateway: response stream ended abnormally for ${endpoint}: ${(err as Error).message}`);
            res.destroy();
          }
        });

        // Tee a bounded HEAD *and* a bounded TAIL of the response for usage parsing. Anthropic streaming
        // splits usage: `input_tokens` (+ cache) rides the FIRST SSE event (`message_start`, captured by the
        // head) and `output_tokens` rides the LAST (`message_delta`, captured by the tail); OpenAI / a
        // non-streaming body carry usage in the final chunk (tail). The window is a READ-ONLY copy — it never
        // touches the bytes the client receives — and stays strictly bounded (the middle content deltas of a
        // large stream are dropped, never buffered).
        //
        // The gateway forwards the client's `Accept-Encoding`, so the upstream body may be gzip/br/deflate
        // COMPRESSED. The tee decompresses THIS COPY ONLY (never the client bytes) so the adapter reads real
        // token counts; a decompression failure fails open to `unavailable` with an honest reason. The whole
        // decompressed body is never buffered (streaming, bounded head+tail).
        const usageTee = createUsageTee(upstreamRes.headers["content-encoding"], USAGE_HEAD_BYTES, USAGE_TAIL_BYTES);
        const runEnd = async (): Promise<void> => {
          const window = await usageTee.finish();
          // A supported-but-corrupt/unsupported compressed stream fails open: feed the adapter nothing so the
          // receipt is honestly `unavailable`, carrying the decompression reason instead of a fabricated zero.
          const responseTail = window.ok ? window.windowText : "";
          const usageUnavailableReason = window.ok ? undefined : window.reason;
          // Computed ONCE per request: it reads the salt file and runs an HMAC, and this is the
          // per-call hot path.
          const correlationEnv = options.entitlementEnv ?? process.env;
          const sessionCorrelation = gatewaySessionCorrelation({
            workflow: options.workflow,
            rawHeaders: req.rawHeaders,
            bodyText: requestBody.toString("utf8"),
            env: correlationEnv
          });
          const shared = {
            adapter,
            endpoint,
            upstreamStatus: upstreamRes.statusCode ?? 0,
            responseTail,
            ...(usageUnavailableReason ? { usageUnavailableReason } : {}),
            requestModel: requestModel(requestBody), // content-free model label from the ORIGINAL body
            // WHICH TOOL SESSION this call came from, read from the ORIGINAL body exactly as the model
            // label is: one metadata field, no message content. Persisted as a device-local KEYED HASH,
            // never the session id (see `session-correlation.ts`).
            //
            // IT MUST BE CAPTURED HERE, for BOTH modes. Only apply receipts retain a body; record
            // receipts retain nothing, and record-mode is the large majority of traffic (measured in
            // `session-correlation.ts`) — including the interleaved auxiliary calls a run aggregate
            // has to account for. Recovered later, it would be unavailable for exactly the calls that
            // matter.
            ...(sessionCorrelation ? { sessionCorrelationId: sessionCorrelation } : {}),
            // Stamped at the top of `handleProxy`, before anything was read or forwarded: the instant
            // run membership keys on. `captured_at` below is assigned here, after the response has
            // streamed and `usageTee.finish()` has resolved — too late for a `Stop` the client already
            // fired.
            requestStartedAt,
            ...(declinedLcmOutcome ? { lcmOutcome: declinedLcmOutcome } : {}),
            ...(proofRunId ? { proofRunId } : {}),
            ...(proofVariant ? { proofVariant } : {})
          };
          // `track` is the same fire-and-forget these three lines always were: synchronous,
          // `void`-returning, rejection-swallowing. It changes nothing about WHEN the write starts or
          // whether anything here waits for it — it only records the promise so `close()` can.
          if (effectiveActivation.requested && apply) {
            pendingBookkeeping.track(recordApplyReceiptFor({ options, activation: effectiveActivation, apply, log, upstreamRouteType, ...shared }));
            // Every AUTOMATIC application is additionally recorded content-free in the local activity
            // store with the user-inspectable facts (authorizing preference, gates, recovery pointer,
            // recover/disable commands). Best-effort + detached: never touches request/response bytes.
            // `plan` OR an output component: the shaping-only fallback (Community at its ceiling on an
            // engine that cannot degrade itself) carries no input plan, and requiring one silently
            // dropped exactly those turns from the activity store — the turns whose recovery record
            // exists and whose recover/disable commands the user has nowhere else to read.
            if (apply.applied && apply.authorization && apply.recoveryId && options.workflow &&
                (apply.plan !== undefined || apply.appliedComponents?.includes("output-shaping") === true)) {
              pendingBookkeeping.track(recordAutoApplyActivity({
                options,
                workflow: options.workflow,
                apply,
                log,
                ...(shared.requestModel ? { requestModel: shared.requestModel } : {})
              }));
            }
          } else {
            // RECORD-MODE OUTPUT-SHAPING PROVENANCE. A record turn mutates nothing, and until now it
            // therefore recorded nothing about output shaping — so the single most common real
            // configuration (Claude Code with the prompt hook installed, routed through the gateway)
            // wrote a receipt with NO shaping state on EVERY call. The hook had attached the policy
            // upstream, `resolveOpenBasicOutputShaping` correctly skipped to avoid a duplicate block,
            // and the run aggregate then failed closed on every one of them: `shapedCallCount === 0`
            // on a run that was shaped end to end, rendering as unoptimized.
            //
            // MEASURED ON THE BYTES ACTUALLY FORWARDED (`bodyToForward`), with the STRICT
            // instruction-level predicate — NOT the broad `bodyAlreadyCarriesOutputShaping` guard that
            // drove the skip. The guard's bias is to skip attaching (a false positive costs one
            // unshaped turn); this field's bias must be to withhold evidence (a false positive puts a
            // savings arrow on a turn nothing shaped). They are deliberately different questions.
            //
            // ADDITIVE ONLY: proven-active is recorded, and anything else is left UNSET rather than
            // written as `absent`. The gateway performed no shaping measurement of its own here, and an
            // explicit `absent` would strip `watch`'s legacy live fallback
            // (`outputShapingActiveForTurn`) from turns whose hook shaped the USER message — the
            // documented instruction-level false negative, which this change preserves rather than
            // papers over. The engine path states `absent` positively because it did inspect the bytes.
            const detectedPolicyVersion = outputShapingPolicyVersionOnRequest(bodyToForward.toString("utf8"));
            const recordShapingState = declinedOutputShapingState ??
              (detectedPolicyVersion ? ("already-active" as const) : undefined);
            pendingBookkeeping.track(recordReceipt({
              options,
              log,
              ...shared,
              ...(recordShapingState ? { outputShapingState: recordShapingState } : {}),
              ...(declinedOutputShapingPolicyVersion || detectedPolicyVersion
                ? { outputShapingPolicyVersion: declinedOutputShapingPolicyVersion ?? detectedPolicyVersion }
                : {})
            }));
          }
          // LCM SHADOW (explicit opt-in, default OFF): starts only AFTER the upstream response has
          // fully arrived, on a DETACHED promise this handler never awaits, it cannot touch the
          // forwarded request (already sent, unchanged) or the response (already streamed, unchanged).
          // Record-mode POST requests only: the deterministic apply/dry-run path (explicit OR
          // stored-authorization) is never shadowed. `runGatewayLcmShadowEvaluation` never throws.
          if (lcmShadow.enabled && req.method === "POST" && !effectiveActivation.requested) {
            void runGatewayLcmShadowEvaluation({
              endpoint,
              requestBodyText: requestBody.toString("utf8"),
              config: lcmShadow,
              cwd: options.cwd ?? process.cwd(),
              log
            });
          }
        };
        upstreamRes.on("data", (c: Buffer) => usageTee.push(c));
        upstreamRes.on("end", () => {
          // Detached: the client response is already fully streamed (pipeline above). Assembling the usage
          // window (which may flush a streaming decompressor) never touches the forwarded bytes; a failure
          // there is swallowed so the receipt path can never disturb the client response.
          //
          // `track` is the same fire-and-forget this line always was — synchronous, `void`-returning, and
          // rejection-swallowing (so the former `.catch` is now redundant, not dropped). It only records
          // the promise so `close()` can wait for it.
          //
          // `runEnd` is tracked IN ADDITION TO the individual appends inside it, and both are needed.
          // `runEnd` first awaits `usageTee.finish()` and only then starts (and tracks) the appends, so
          // tracking the appends alone leaves a window in which a drain would find nothing pending and
          // shut down over the very write it exists to wait for; tracking `runEnd` alone is not enough
          // either, because it `track`s the appends rather than awaiting them and so resolves while they
          // are still in flight. Together they chain: the drain holds for `runEnd`, which registers the
          // appends before it resolves, and the drain then holds for those.
          //
          // Registering HERE — in the same synchronous emit that ends the client response, because this
          // listener is attached after the `pipeline(upstreamRes, res, …)` call above — is what makes a
          // request that is still in flight when `close()` is called covered too.
          //
          // The LCM shadow evaluation started inside `runEnd` stays detached and untracked on purpose:
          // it is opt-in and can run arbitrarily long, and shutdown latency is user-facing.
          pendingBookkeeping.track(runEnd());
        });
      }
    );

    // Connect + time-to-first-byte guard: an upstream that never responds must not hang the client
    // forever. Released in the response callback above the moment bytes start (a live stream is never
    // killed); before then a fire surfaces as an honest 502 gateway error.
    upstreamReq.setTimeout(options.upstreamTimeoutMs ?? UPSTREAM_STALL_TIMEOUT_MS, () => upstreamReq.destroy(new Error("upstream timeout")));

    upstreamReq.on("error", (err) => {
      // The gateway itself failed to reach upstream, an honest gateway error (never a faked success).
      log(`compaction gateway: upstream error for ${endpoint}: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `compaction gateway: upstream request failed (${(err as Error).message})`, type: "gateway_error" } }));
      } else {
        // Mid-stream failure after headers went out: abort the client stream (never splice JSON into it).
        res.destroy();
      }
    });

  if (bodyToForward.length > 0) upstreamReq.write(bodyToForward);
  upstreamReq.end();
}

function ordinaryForwardedHeaders(req: http.IncomingMessage, host: string, contentLength: number): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "x-compaction-mode" || lower === "x-compaction-policy" || HOP_BY_HOP.has(lower)) continue;
    headers[name] = value;
  }
  headers.host = host;
  if (contentLength > 0) headers["content-length"] = String(contentLength);
  return headers;
}

/** First string value of a (possibly array) header, trimmed to non-empty, else undefined. */
function headerValue(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() !== "" ? s : undefined;
}

/** The outcome of resolving apply for one request (null when apply/dry-run was not requested). */
/**
 * THE ONE PLACE the upstream billing route is derived. Two independent records need it — the signed
 * usage debit (`route_type`, which the debit records and which decides nothing) and the apply receipt
 * (`upstream_route_type`, which gates the per-turn line's list-price cost clause). Deriving it twice
 * is how those two silently disagree, so both read this.
 *
 * DERIVED FROM WHAT THE CLIENT ACTUALLY PRESENTED, never from key contents and never from a default:
 *
 *  1. An explicit `--subscription` transport (`options.claudeSubscription`) already IS the declaration.
 *  2. Otherwise, on the Claude Code route only, the request itself is the evidence. An Anthropic
 *     API-key call authenticates with `x-api-key`; a saved-login / Claude Max session has no API key
 *     to put there and authenticates with its own credential instead. So the PRESENCE of a non-empty
 *     `x-api-key` header — the header NAME only, the value is never read, compared, hashed, logged or
 *     retained — is direct evidence of the API-key route, and its absence is evidence against it.
 *  3. Every other route (`codex`/`cursor`/OpenAI, an explicitly started gateway with no workflow
 *     identity) keeps `api-key` exactly as before. Those transports have no subscription form here,
 *     so there is nothing for this to decide and their behaviour is untouched.
 *
 * WHY THIS SHAPE. Before, the absence of a `--subscription` transport was read as proof of an API key,
 * which is not something the gateway knew: `gateway ensure` — the path the `claude` PATH shim takes on
 * every normal `claude` run — has no `--subscription` form at all, so a Claude Max session was recorded
 * as `api-key` and priced with a per-token list price it is not billed at. The rule can only ever move
 * a turn from `api-key` to `subscription`, and only when no API key was presented; it can never newly
 * assert a billed route, so it can never fabricate a dollar claim. A per-token BEARER token
 * (`ANTHROPIC_AUTH_TOKEN`) lands on `subscription` and simply loses the cost clause — a claim withheld,
 * which is the safe direction, not a claim invented.
 */
function upstreamRouteTypeFor(
  options: GatewayServerOptions,
  req: Pick<http.IncomingMessage, "headers">
): "api-key" | "subscription" {
  if (options.claudeSubscription) return SUBSCRIPTION_ROUTE_TYPE;
  if (options.provider !== "anthropic" || options.workflow !== "claude-code") return API_KEY_ROUTE_TYPE;
  return headerValue(req.headers["x-api-key"]) !== undefined ? API_KEY_ROUTE_TYPE : SUBSCRIPTION_ROUTE_TYPE;
}

interface ApplyOutcome {
  plan?: DedupePlan;
  optimizationPlan?: OptimizationPlan;
  applied: boolean;
  mutatedBody?: Buffer;
  recoveryId?: string;
  appliedComponents?: Array<"lcm-compaction" | "deterministic-compaction" | "output-shaping">;
  /** Output-shaping provenance for the final forwarded request (see `GatewayReceipt.output_shaping_state`). */
  outputShapingState?: "attached-this-pass" | "already-active" | "absent";
  outputShapingPolicyVersion?: string;
  outputShapingRegime?: "default-shapeable";
  /** Fixed-vocabulary LCM outcome (content-free). See `lcm-outcome.ts`. */
  lcmOutcome?: { kind: string; reason: string };
  composedInputEstimate?: { before: number; after: number };
  /** Present ONLY on a stored-authorization application: the authorizing preference + passed gates. */
  authorization?: { id: string; scopeLine: string; gatesPassed: string[] };
  failClosedReason?: string;
  /**
   * Set when the Community optimized-input ALLOWANCE is the reason input optimization did not run on
   * this turn — either nothing was left (`exhausted`) or what was left did not cover this particular
   * turn (`insufficient`). Rides onto the receipt so the per-turn line can say so and offer the ONE
   * conversion path; absent on a healthy turn, which is what keeps the CTA off every Community line.
   */
  allowancePause?: GatewayReceipt["allowance_pause"];
  /**
   * Set ONLY when this turn actually DEBITED the allowance and the lease carried a signed period
   * total: what was left afterwards, out of that total. Rides onto the receipt so the per-turn line
   * can show the countdown without reading device state at render time. Absent on a paused turn (the
   * pause clause owns that line) and on a shaping-only turn (nothing was debited to count down).
   */
  allowanceSnapshot?: GatewayReceipt["allowance_snapshot"];
}



/**
 * Render the per-turn line for a gateway receipt — with the tier label derived from the RECEIPT,
 * never from the device's current preference.
 *
 * This is the fix for a defect the Open-basic wiring would otherwise have inherited. `watch` and
 * `status` stamp the label from whatever `compaction mode` says *right now*, so the same replayed
 * receipt rendered `basic shaping` or `apply off` depending on a setting changed days later. The
 * gateway's own inline line sidestepped that by passing no tier at all — and therefore said nothing
 * even when it had something true to say.
 *
 * The receipt knows. A turn on which output shaping was ACTIVE carries `output_shaping_state` of
 * `attached-this-pass` or `already-active` — the engine's measurement of the bytes it forwarded — so
 * `basic shaping` is a statement about THAT turn. A turn with an explicit `absent`, and a legacy turn
 * with no state at all, get NO label: silence is the honest rendering, because the tool's own prompt
 * hook may have shaped the turn where this measurement cannot see it (it inspects instruction-level
 * carriers only), and stamping `apply off` would assert "no model-visible mutation" without knowing
 * it. That rule is `receiptProvenOpenLabel`, shared with the surfaces that replay receipts (`watch`,
 * `status`) so the same receipt cannot be labelled two ways by two renderers.
 *
 * A REAL full apply takes the COMMUNITY BUILDER, exactly as `watch`, `statusline` and the Claude Code
 * Stop hook do. This path used to fall through to the unlabelled Open rendering instead, so one
 * full-apply receipt rendered `input B→A (−PP%) · output N · id …` here and
 * `input B→A (−PP%) · output B→A (−PP%, est. …) · −$X (list price) · full apply · id …` on the other
 * three — the same receipt, described two ways by two renderers, which is the defect
 * `receiptProvenOpenLabel` exists to prevent one level up. The gateway had the strongest evidence of
 * all (it performed the apply) and said the least about it.
 *
 * The dispatch is deliberately the SAME SHAPE as the other three surfaces (`full` tier → community
 * builder, with the Open line as the fallback for a non-apply turn on a full-tier device), so a future
 * change to the rule has one obvious set of call sites rather than three-plus-an-exception. The builder
 * itself still refuses to synthesize: it returns undefined unless the receipt carries a REAL apply
 * before→after, so a record or Open receipt can never acquire a `full apply` label here.
 *
 * The output arrow rides the calibrated rate applied to THIS turn's own output, on BOTH branches. It is
 * requested only when `outputShapingActiveForTurn` proves the final request was shaped; a real input
 * apply alone is not output evidence. Without applicable calibration, proven shaping
 * renders `output N/A→N (N/A%, est.)`: no fabricated before, while preserving the proven shaping fact.
 * Best-effort: a calibration read failure loses the numeric arrow, never the axis or the line.
 *
 * EXPORTED FOR TESTS. Reaching a real full-apply receipt through `createGatewayServer` needs the private
 * engine and a valid lease, so an end-to-end test could only ever exercise the Open branch — the one
 * that already worked. Exporting the renderer lets the branch that was BROKEN be driven with a real
 * apply receipt and a real environment. Not part of the public API surface; nothing outside tests and
 * this file calls it.
 */
export async function perTurnLineFromReceipt(
  receipt: GatewayReceipt,
  options: GatewayServerOptions
): Promise<string | undefined> {
  const env = options.entitlementEnv ?? process.env;
  const realApply = isRealApply(receipt);
  const shapingActive = outputShapingActiveForTurn(receipt, false);
  const openLabel = receiptProvenOpenLabel(receipt);
  // Neither a full apply nor a turn we shaped: nothing this renderer can label truthfully.
  // THE CEILING THE GATEWAY ITSELF RECORDED. This renderer used to pass `undefined` for both allowance
  // parameters on every branch, so the one surface with FIRST-HAND knowledge of the refusal — the
  // process that made it — rendered a silently degraded line with no reason and no way forward. The
  // pause is read off the receipt (the turn's own record), never from current device state, so a
  // replayed receipt cannot acquire today's ceiling and today's turn cannot lose its own.
  const ceiling = receiptCeiling(receipt, env);
  if (!realApply && !shapingActive) return receiptLineFromGatewayReceipt(receipt, undefined, undefined, undefined, ceiling);

  // THE ESTIMATOR'S OWN TYPE, not a re-declared subset. This was annotated
  // `{ calibrated: boolean; tokensSaved?: number }`, which silently dropped `basis` — the field that
  // decides whether a reconstructed before→after may be drawn at all. The value carried it at runtime,
  // so the arrow was suppressed correctly, but the STATIC type said the provenance did not exist:
  // rebuilding this literal by hand would have compiled clean and put the shipped prior back on the
  // live gateway line. The provenance travels with the estimate or the guard downstream is decorative.
  let estimatedSaved: PerTurnEstimatedSaved | undefined;
  if (shapingActive) {
    try {
      const reduction = await loadCalibrationReduction(
        env,
        outputCalibrationQuery({
          policyVersion: receipt.output_shaping_policy_version,
          provider: receipt.provider,
          model: receipt.model,
          regime: receipt.output_shaping_regime
        })
      );
      estimatedSaved = estimatePerTurnOutputSaved(reduction, receipt.tokens?.output);
    } catch {
      // Shaping was proven above. A failed calibration read cannot erase that fact; keep the axis and
      // leave only its unavailable counterfactual slots unknown.
      estimatedSaved = { calibrated: false, state: "unseeded" };
    }
  }

  if (realApply) {
    // The tier is asked of the DEVICE here, not of the receipt, because `full apply` is an
    // entitlement statement and the receipt does not carry one. `communityFullApplyReceiptLine`
    // independently re-checks that the receipt is a real apply, so a mis-resolved tier can widen
    // nothing: a non-apply receipt still returns undefined and falls through.
    try {
      const { tier } = await resolveOpenTier(env);
      if (tier === "full") {
        // A real apply and an allowance pause are mutually exclusive by construction — a paused turn
        // compacts no input, so `isRealApply` is false and it never reaches here — but the ceiling is
        // passed through rather than dropped, so the two can never silently disagree if that changes.
        const full = communityFullApplyReceiptLine(receipt, estimatedSaved, ceiling);
        if (full !== undefined) return full;
      }
    } catch {
      /* fall through to the Open rendering: a tier read failure must not cost the line entirely */
    }
    if (!shapingActive) return receiptLineFromGatewayReceipt(receipt, undefined, undefined, undefined, ceiling);
  }
  return receiptLineFromGatewayReceipt(receipt, openLabel, undefined, estimatedSaved, ceiling);
}

/**
 * OPEN `basic` OUTPUT SHAPING AT THE GATEWAY. The engine-free, account-free, unmetered public apply path.
 *
 * WHY THIS EXISTS. The gateway already shaped output on the Community `full` path — but that runs in
 * the private engine (`apply-pipeline.ts`), and `dist/engine/**` is excluded from the npm package. So
 * the published artifact shipped `planPublicBasicOutputShaping` — the engine-free planner built for
 * exactly this route — with no caller, and its gateway route mutated nothing. This is that call site.
 *
 * PRECEDENCE. Third and last. Explicit per-call activation wins, then stored-authorization full
 * apply (which already includes output shaping, so this must never run after it and double-attach).
 * Only when neither applied does this path get a turn.
 *
 * GATES, all required, each alone sufficient to decline:
 *  1. `effectiveOpenTier === "basic"`. The user's persisted mode IS the authorization on this path —
 *     there is no account and no lease to consult. `observe` never shapes: it is defined as "no
 *     model-visible mutation" in three binding places, and a shaping instruction is model-visible text.
 *
 *     KNOWN, DELIBERATE GAP. `clampTier` sends a
 *     `full` mode with NO valid lease to `observe`, not `basic`, so a lease-less Community device gets
 *     no shaping here — even though the degradation order ("1. Open basic shaping if enabled + safe
 *     → else 2. forward the original unchanged") says a `full` request that cannot be honoured should
 *     land on step 1. Widening the gate to the raw persisted mode WOULD close that hole; it would also
 *     turn 27 currently-green tests red, because they encode a `full`-mode device receiving an
 *     unmutated request under `optimization_mode: cache` and with no stored authorization. Silently
 *     changing what Community devices send upstream is a bigger change than the one authorized here
 *     (wiring the PUBLISHED Open-basic path), so the narrow gate ships and the gap is recorded here.
 *
 *     BE PRECISE ABOUT WHAT THIS GATE DOES AND DOES NOT PROTECT. For a `basic`-mode device
 *     it consults NEITHER `optimization_mode` NOR any stored authorization — it mutates without either.
 *     `compaction mode basic` leaves `optimization_mode` at its default `cache`, so "cache + basic" is
 *     the ORDINARY state after opting in, and on that device the onboarding "Cache optimize" card's
 *     "Compaction changes nothing the model sees" is no longer true of the gateway route. That copy was
 *     already untrue for anyone with shaping hooks installed (the hook path ignores `product_mode` —
 *     the open D2 defect), so this widens a pre-existing overclaim rather than creating one; the copy
 *     belongs with D2, not here.
 *  2. `isShapingHooksActivated` — DELIBERATELY the same switch the hook path reads, so `compaction
 *     stop` and `COMPACTION_SHAPING_HOOKS=0` turn off gateway and hook shaping together. Two
 *     mechanisms for one user-visible idea must not need two off switches.
 *  3. The body is not ALREADY shaped (`bodyAlreadyCarriesOutputShaping`) — the hook may have injected
 *     the same block before the gateway saw the request.
 *  4. The planner reports a real change on a supported request shape. Unsupported/uncertain shapes
 *     fail closed inside the planner, exactly as input compaction does.
 *  5. The byte-exact original is retained. Retention failing DECLINES the mutation (fail-closed for
 *     the mutation) and forwards the original (fail-open for the workflow) — the "original
 *     retained" guarantee is not aspirational on this path, it gates it.
 *
 * NO INPUT MUTATION, so the outcome carries no `composedInputEstimate` and the receipt gets no
 * `estimated_input_tokens_*`. The per-turn line therefore shows `observed input N` (a plain count)
 * and never an input reduction arrow — Open does not compact input.
 *
 * ANY error → null (fail-open: plain record, original forwarded unchanged, workflow never blocked).
 */
function resolveOpenBasicOutputShaping(
  endpoint: string,
  originalBody: Buffer,
  options: GatewayServerOptions,
  log: (line: string) => void
): { activation: ApplyActivation; outcome: ApplyOutcome } | null {
  try {
    const env = options.entitlementEnv ?? process.env;
    if (effectiveOpenTier(env) !== "basic") return null;
    if (!isShapingHooksActivated(env)) return null;

    const originalText = originalBody.toString("utf8");
    if (bodyAlreadyCarriesOutputShaping(originalText)) {
      log(
        "compaction gateway: open basic shaping skipped - the request already carries the shaping policy (your tool's prompt hook attached it); forwarding unchanged to avoid a duplicate block."
      );
      return null;
    }

    const plan = planPublicBasicOutputShaping(endpoint, originalText);
    if (!plan.supported || !plan.changed || !plan.mutatedBody) return null;

    let recoveryId: string;
    try {
      recoveryId = saveOriginalForRecovery(options.cwd ?? process.cwd(), {
        endpoint,
        policy: OPEN_BASIC_OUTPUT_POLICY,
        originalBody: originalText
      });
    } catch (e) {
      // The error CLASS only, never `.message`. Node fs errors interpolate
      // absolute paths — `ENOENT: ... mkdir '/Users/<name>/<their-repo>/.compaction/...'` — and this log
      // line is a content-free surface. Same rule and same phrasing as the explicit-apply retention
      // catch below, which documents it; this path had copied the looser precedent instead.
      const errorClass = e instanceof Error ? e.name : typeof e;
      log(
        `compaction gateway: open basic shaping declined - the original could not be retained (${errorClass}); fail-closed, original forwarded unchanged.`
      );
      return null;
    }

    return {
      activation: { mode: "apply", requested: true, activation: "open-basic-mode" },
      outcome: {
        applied: true,
        mutatedBody: Buffer.from(plan.mutatedBody, "utf8"),
        recoveryId,
        appliedComponents: ["output-shaping"],
        // This path ATTACHED the policy itself, so provenance is settled without re-deriving it.
        outputShapingState: "attached-this-pass",
        ...(plan.policyVersion ? { outputShapingPolicyVersion: plan.policyVersion } : {}),
        ...(plan.taskSignal === "default-shapeable" ? { outputShapingRegime: "default-shapeable" as const } : {})
      }
    };
  } catch {
    return null;
  }
}

/**
 * What the stored-authorization path resolved to. `null` is the plain decline (nothing ran, or an
 * early gate refused). `declined` is the engine having run the pipeline and applied nothing: the
 * turn is still a plain record, but the engine's LCM outcome is a fact about it that the record
 * receipt must carry.
 */
type StoredAuthorizationResolution =
  | { activation: ApplyActivation; outcome: ApplyOutcome }
  | {
      declined: true;
      lcmOutcome?: { kind: string; reason: string };
      outputShapingState?: "attached-this-pass" | "already-active" | "absent";
      outputShapingPolicyVersion?: string;
    };

/**
 * Resolve a STORED-AUTHORIZATION automatic apply for one request, or null (= stay record). Called
 * only when no explicit per-call apply intent exists.
 *
 * OPEN-CORE BOUNDARY: the optimization ALGORITHM (deterministic-dedupe input compaction, the
 * LCM hybrid candidate, adaptive output shaping) no longer runs in this public process — it runs in
 * the private native engine over the supervised local IPC. This function keeps the PUBLIC MECHANISM:
 * it decides WHETHER apply is allowed (the auth/scope/endpoint gates), retains the byte-exact
 * original for recovery BEFORE forwarding any mutation, builds the content-free receipt/activity
 * record from the engine's returned artifacts, and degrades fail-open (engine down/refuse/no-op/error
 * → plain record, original forwarded unchanged). The stored preference file is read fresh each call.
 * ANY error anywhere → null (fail-open: plain record, original forwarded unchanged).
 */
async function resolveStoredAuthorizationApply(
  endpoint: string,
  originalBody: Buffer,
  options: GatewayServerOptions,
  log: (line: string) => void,
  supervisor: EngineSupervisor,
  upstreamRouteType: "api-key" | "subscription"
): Promise<StoredAuthorizationResolution | null> {
  try {
    // Apply is enabled for the tools that route recognized request shapes through the gateway.
    // Cursor participates via its OpenAI-compatible traffic (custom base URL); its reduction is shown
    // as a LOCAL estimate. Only these narrow tool identities are ever model-visible-applied.
    if (options.workflow !== "codex" && options.workflow !== "claude-code" && options.workflow !== "cursor") return null;
    // UNIFIED STOP (defense-in-depth): `compaction stop` disables the WHOLE optimization - output shaping
    // AND apply routing. The transparent-routing ensure already declines to spawn a workflow-scoped gateway
    // while stopped, but an already-running workflow gateway must ALSO honor a stop taken mid-session: a
    // stopped session applies nothing (record-only, original forwarded unchanged). Fail-open by construction.
    if (isShapingStopped()) {
      log("compaction gateway: compaction is stopped (`compaction stop`) - stored-authorization apply held; record mode, original forwarded unchanged.");
      return null;
    }
    const cwd = options.cwd ?? process.cwd();
    // The stored authorization is necessary but not sufficient: automatic composition is active
    // only while the user's persisted onboarding mode is Cache + context optimize. Switching back
    // to Cache optimize takes effect on the next request and leaves model-visible bytes unchanged.
    if ((options.optimizationMode ?? readOptimizationMode()) !== "cache-plus-context") return null;
    const scope: ApplyRequestScope = { tool: options.workflow as string, ...(options.repo ? { repo: options.repo } : {}) };
    // DEVICE store only, resolved from the SAME env as the lease and the metering journal — one device
    // environment, one answer. `cwd` still scopes this connection's retention/receipt paths below, but
    // it must never decide whether an authorization EXISTS: a repository that ships a
    // `.compaction/policy-preferences.json` would otherwise arm mutation for anyone who cloned it.
    const authorization = await findStoredAuthorization({ scope, env: options.entitlementEnv ?? process.env });
    if (!authorization) return null; // no matching stored authorization → NO auto-apply, ever

    // PUBLIC GATE: decide WHETHER apply is allowed (auth/scope/endpoint). No algorithm runs here.
    // A failed gate is a fail-closed decline (plain record). The passing gates seed the receipt's
    // gate list; the engine's shape/change gates and this function's retention gate complete it.
    const gates = evaluateStoredApplyGates({ endpoint, requestScope: scope, storedAuthorization: authorization });
    if (!gates.eligible) {
      log(`compaction gateway: stored authorization ${authorization.id} did not apply - ${gates.reason}`);
      return null;
    }

    // ENTITLEMENT — a SEPARATE check from the user-authorization gates above (two independent
    // conditions, each sufficient to decline). Community full apply requires a VALID signed
    // entitlement lease for THIS device + period. The lease is verified
    // by the pure, engine-free, network-free lease-store (Ed25519 against the pinned/dev lease root,
    // device-bound, in-period, not expired). Any anomaly → fail-closed decline (record mode, original
    // forwarded unchanged) with a content-free reason label. This is deliberately NOT added to the
    // stored-apply eligibility gate list (that array is a stored-pref contract with non-empty
    // invariants); it is a distinct decline reason kept beside it.
    //
    // ENTITLEMENT ONLY. Whether the device is entitled is one question; whether this period's
    // allowance can pay for THIS turn's input compaction is another, asked below and answered against
    // the journal rather than against the lease. The reader used to fold a spent balance into this
    // verdict, which made this gate withdraw the whole capability — including the output shaping the
    // allowance never bought and which must keep running on a spent period.
    const leaseVerdict = readLeaseVerdict(options.entitlementEnv ?? process.env);
    if (leaseVerdict.label !== "lease-valid") {
      log(
        `compaction gateway: stored authorization ${authorization.id} did not apply - entitlement ${leaseVerdict.label} (record mode, original forwarded unchanged).`
      );
      return null;
    }

    // PRODUCT MODE — the THIRD independent condition (each alone sufficient to decline). The user's
    // persisted open-core mode must effectively be `full`. In `observe` or `basic` the user has NOT
    // asked for model-visible private-engine mutation, and the per-turn receipt line labels the turn
    // `apply off` / `basic shaping` — applying anyway would be both a correctness defect and a
    // claims-honesty defect (the surface would describe the turn as something it was not). The tier
    // read is the same pure, network-free `effectiveOpenTier` the receipt line uses, so the gate and
    // the label can never disagree.
    const effectiveTier = effectiveOpenTier(options.entitlementEnv ?? process.env);
    if (effectiveTier !== "full") {
      log(
        `compaction gateway: stored authorization ${authorization.id} did not apply - product mode ${effectiveTier} (full apply not enabled; record mode, original forwarded unchanged).`
      );
      return null;
    }

    const originalText = originalBody.toString("utf8");

    // ROUTE: resolved once per request from what the client presented, NEVER from key contents (see
    // `upstreamRouteTypeFor`). It is RECORDED on the debit and stamped on the engine frame; it does NOT
    // decide whether this turn is metered. The Compaction allowance pays for USE OF THE HYBRID ENGINE,
    // so a confirmed input apply consumes optimized-input allowance on the API-key route and on a
    // Claude Code subscription session alike.
    const routeType = upstreamRouteType;
    const meteringEnv = options.entitlementEnv ?? process.env;
    const allowanceTokens = leaseVerdict.allowanceTokens ?? 0;
    const periodId = leaseVerdict.periodId ?? "";
    // The countdown's DENOMINATOR, straight off the signed lease. Undefined on a v1 lease (one signed
    // before the total was part of the wire contract), and a device holds its last lease for up to a
    // full TTL after upgrading — so the snapshot below is simply omitted rather than substituting
    // `allowanceTokens`, which is already net of server-recorded consumption and would draw a full
    // tank on a half-spent period.
    const periodAllowanceTokens = leaseVerdict.periodAllowanceTokens;
    // What this turn's debit left, out of the period total. Set at the ONE place a debit commits.
    let allowanceSnapshot: GatewayReceipt["allowance_snapshot"];

    // WHY input optimization did not run, when the reason was the allowance. Set at each of the three
    // places an allowance can refuse this turn (pre-dispatch exhausted, pre-dispatch overshoot, and the
    // under-lock concurrent ceiling), and carried to the receipt so the per-turn line can state the
    // pause and offer the conversion path. The reset date comes from the lease's PERIOD, never from
    // `expires_at` (which is renewed within a period and would name a date that is too early).
    let allowancePause: GatewayReceipt["allowance_pause"];
    const pauseFor = (reason: "exhausted" | "insufficient"): GatewayReceipt["allowance_pause"] => {
      const resetsOn = periodEndUtc(periodId);
      return {
        reason,
        // STAMPED WITH THE PERIOD IT BELONGS TO. The reset date alone cannot tell a later reader
        // whether this pause is still true; the period can, and it is the field the readers bind to.
        ...(periodId !== "" ? { period_id: periodId } : {}),
        ...(resetsOn !== undefined ? { resets_on: resetsOn } : {}),
        // EVERY ROUTE. The allowance governs Hybrid input optimization wherever the turn is
        // forwarded, so no route is "unaffected" and the narrower `api-key-route` scope would now
        // promise a subscription user an apply that will be paused. Persisted receipts written
        // before this change may still carry the narrower label; the renderers still accept it.
        scope: "all-routes" as const
      };
    };
    // CEILING SNAPSHOT (client-authoritative until the usage service reconciles): the local
    // hash-chained usage journal is the consumed-so-far tally. Compute remaining = allowance minus
    // the committed debits for this period. At/over the ceiling, PAUSE INPUT OPTIMIZATION
    // (content-free degrade to the output-shaping-only treatment) - never auto-purchase, never meter
    // past the allowance.
    //
    // ROUTE-BLIND, LIKE THE ENTITLEMENT GATE ABOVE. This used to run for the api-key route only,
    // which let a subscription-routed Hybrid apply consume the engine and debit nothing. An
    // ISSUER-exhausted lease (`allowance_tokens: 0`) arrives here as a VALID entitlement carrying a
    // zero snapshot, and this is what turns that zero into a paused input plan - on every route.
    //
    // NOT THE AUTHORITY FOR THE COMMIT (load-bearing): this value is a cheap EARLY-OUT and the
    // number the engine receives as `locally_allocated_tokens_remaining`. It is read before an
    // awaited engine dispatch, so every concurrent apply in flight observes the SAME remainder and
    // none of them can see the others' debits. The binding test lives with the debit, inside the
    // journal append lock (`appendUsageEvent`'s `ceiling`), where the tally is re-read fresh.
    //
    // INTEGRITY-GATED + FAIL-CLOSED: the tally is only trustworthy if the journal it sums verifies.
    // A malformed line or a broken hash chain (e.g. a hand-edited token count) would otherwise LOWER
    // the tally and silently replenish the allowance, so an unverifiable journal DECLINES the apply
    // rather than being summed over its surviving lines.

    const consumption = await readMeteredAllowance(allowanceTokens, periodId, meteringEnv);
    if (!consumption.ok) {
      log(
        `compaction gateway: stored authorization ${authorization.id} did not apply - ${consumption.reason} (${meteringDeclineExplanation(consumption.reason)}; fail-closed, original forwarded unchanged).`
      );
      return null;
    }
    const localRemainingTokens = consumption.remaining;
    if (localRemainingTokens <= 0) {
      // EXHAUSTED IS AN INPUT CEILING, NOT AN OFF SWITCH. This used to return null, which forwarded
      // a bare original and took OUTPUT SHAPING away along with the input compaction — dropping a
      // Community user at their ceiling below the Open/base baseline that never cost allowance.
      // Dispatch anyway with a zero remainder: the engine's own ceiling refuses the INPUT plan and
      // emits the output-shaping-only treatment, metered at zero. No auto-purchase, no partial
      // metering, and `compactedInput` below keeps the debit at zero.
      log(
        `compaction gateway: stored authorization ${authorization.id} - optimized-input allowance exhausted for this period; input optimization paused, output shaping continues (no auto-purchase).`
      );
      allowancePause = pauseFor("exhausted");
    }

    // PRIVATE ENGINE (over the supervised local IPC): the optimization algorithm runs in the engine
    // sidecar, not in this process. The gateway sends only request bytes + content-free metadata (no
    // credential, no network endpoint). Any engine degrade/refusal/no-op → forward the original.
    // Dispatched through a closure because the overshoot ceiling below re-dispatches the SAME request
    // with a zero remainder to obtain the output-shaping-only degradation, rather than refusing it.
    const dispatchEngine = (remainingTokens: number) => decideEngineApply(supervisor, {
      operation: "plan_and_apply",
      workflow: scope.tool,
      provider: options.provider,
      route_type: routeType,
      endpoint,
      output_shaping_enabled: true,
      // HYBRID/LCM INPUT COMPACTION, activated by ENTITLEMENT, not by environment. Reaching this
      // line already means the lease verified (`leaseVerdict`) and the route/scope gates passed —
      // i.e. this is a Community-or-better request — which is exactly the product boundary: output
      // shaping is the base capability on every plan, hybrid input reduction starts at Community.
      //
      // Passed in the frame so the engine's activation is auditable and bound to THIS request. The
      // supervisor's env allowlist stays two keys, so there is no ambient way to switch it on.
      input_compaction_enabled: true,
      request_body: originalText,
      authorization: { policy_id: authorization.id, scope_hash: authorization.scope.tool },
      // ENTITLEMENT: a content-free opaque proof-of-entitlement (the verified lease's period; never
      // the lease id / account / signature — those never cross the IPC). The engine treats it opaque.
      entitlement: { token: `community-full-apply:${leaseVerdict.periodId ?? ""}` },
      // QUOTA snapshot: the journal-adjusted remainder (allowance minus the committed debits for this
      // period), sent on EVERY route now that every route debits. The engine ENFORCES it as defense
      // in depth behind this client-side check - it refuses when the pre-mutation metered count would
      // exceed the remainder. Sending the real window on the subscription route is what makes the
      // engine's independent ceiling agree with this one instead of applying without a bound.
      quota: { period_id: periodId, locally_allocated_tokens_remaining: Math.max(0, remainingTokens) }
    });

    // SHAPING-ONLY FALLBACK (PUBLIC, ENGINE-FREE, NO IPC). Each of the three allowance refusals below
    // asks the ENGINE for an output-shaping-only treatment by re-dispatching with a zero remainder.
    // That only works when the INSTALLED engine enforces the quota frame on THIS route, and an engine
    // built before the ceiling became route-independent does not: its `exceedsQuota` returns false for
    // every non-api-key route, so on a subscription route it hands back an input-compacted body
    // whatever remainder it is sent. The `compactsInput` guard then correctly refuses that body — and
    // the turn would be forwarded bare, taking OUTPUT SHAPING away at the ceiling. That is precisely
    // the regression the exhausted path above exists to prevent, and it is reachable today: the CLI
    // upgrades on its own, an already-verified engine is treated as present rather than replaced, and
    // the IPC protocol version is unchanged between them, so the old engine accepts the new frame.
    //
    // So do not make the degraded treatment depend on the engine at all. `planPublicBasicOutputShaping`
    // is the same public planner the Open baseline uses: in-process, engine-free, and it carries the
    // task-aware gate, so a planning/reasoning turn still HOLDS rather than being shaped. It compacts
    // no input, so `compactedInput` stays false and nothing is debited, on any route. A Community user
    // at their ceiling therefore lands exactly ON the Open baseline instead of below it, whatever
    // engine version happens to be installed.
    const planShapingOnlyFallback = (): { body: string; policyVersion?: string; regime?: "default-shapeable" } | undefined => {
      // The user's own shaping off-switch (`compaction stop` / `COMPACTION_SHAPING_HOOKS=0`) wins here,
      // exactly as it does on the Open-basic path. The primary engine dispatch above still sends
      // `output_shaping_enabled: true` unconditionally, which is a separate defect on a different path;
      // it is tracked rather than folded into this change, and the asymmetry only ever shapes LESS.
      if (!isShapingHooksActivated(options.entitlementEnv ?? process.env)) return undefined;
      // The tool's own prompt hook may already have attached the identical block upstream.
      if (bodyAlreadyCarriesOutputShaping(originalText)) return undefined;
      const plan = planPublicBasicOutputShaping(endpoint, originalText);
      if (!plan.supported || !plan.changed || !plan.mutatedBody) return undefined;
      return {
        body: plan.mutatedBody,
        ...(plan.policyVersion ? { policyVersion: plan.policyVersion } : {}),
        ...(plan.taskSignal === "default-shapeable" ? { regime: "default-shapeable" as const } : {})
      };
    };

    // The applied outcome for that fallback. Retains its OWN byte-exact original first (fail-closed for
    // the mutation, fail-open for the workflow) and names `open-basic-output-apply` on both the recovery
    // record and — via `activation.policy` — the receipt, so one turn cannot be described by two
    // different policies. It carries the allowance pause, so the per-turn line still says input
    // optimization is paused and still offers the one conversion path.
    const shapingOnlyFallbackOutcome = (
      fallback: { body: string; policyVersion?: string; regime?: "default-shapeable" },
      pause: GatewayReceipt["allowance_pause"],
      lcmOutcome?: { kind: string; reason: string }
    ): { activation: ApplyActivation; outcome: ApplyOutcome } | null => {
      let fallbackRecoveryId: string;
      try {
        fallbackRecoveryId = saveOriginalForRecovery(cwd, {
          endpoint,
          policy: OPEN_BASIC_OUTPUT_POLICY,
          originalBody: originalText
        });
      } catch (error) {
        // The error CLASS only - Node fs errors interpolate absolute paths and this log is content-free.
        const errorClass = error instanceof Error ? error.name : typeof error;
        log(
          `compaction gateway: stored authorization ${authorization.id} shaping-only fallback declined - the original could not be retained (${errorClass}); fail-closed, original forwarded unchanged.`
        );
        return null;
      }
      return {
        activation: {
          mode: "apply",
          requested: true,
          policy: OPEN_BASIC_OUTPUT_POLICY,
          activation: "stored-authorization"
        },
        outcome: {
          applied: true,
          mutatedBody: Buffer.from(fallback.body, "utf8"),
          recoveryId: fallbackRecoveryId,
          appliedComponents: ["output-shaping"],
          // Same as the Open-basic path above: this fallback attached the policy itself.
          outputShapingState: "attached-this-pass",
          ...(fallback.policyVersion ? { outputShapingPolicyVersion: fallback.policyVersion } : {}),
          ...(fallback.regime ? { outputShapingRegime: fallback.regime } : {}),
          ...(lcmOutcome ? { lcmOutcome } : {}),
          authorization: {
            id: authorization.id,
            scopeLine: authorization.scope.repo
              ? `${authorization.scope.tool} repo ${authorization.scope.repo}`
              : authorization.scope.tool,
            // No engine ran, so there are no engine shape gates to report: the public gates this path
            // already passed, plus the retention that just succeeded.
            gatesPassed: [
              ...Object.entries(gates.gateResults).filter(([, r]) => r === "pass").map(([gate]) => gate),
              "original-retainable"
            ]
          },
          ...(pause ? { allowancePause: pause } : {})
        }
      };
    };

    const first = await dispatchEngine(localRemainingTokens);

    if (first.decision !== "apply") {
      // EXHAUSTED, AND THE ENGINE REFUSED OUTRIGHT rather than degrading. An `allowancePause` here can
      // only have come from the pre-dispatch exhausted branch above, so this is the ceiling case again:
      // shape in-process so the baseline survives an engine that answers a zero remainder with a refusal
      // instead of a shaping-only plan. Every other refusal reason stays a plain fail-open.
      const fallbackBody = allowancePause !== undefined ? planShapingOnlyFallback() : undefined;
      if (fallbackBody !== undefined) {
        log(
          `compaction gateway: stored authorization ${authorization.id} - the engine refused at the exhausted allowance (${first.reason}); applying the public baseline shaping instead (nothing debited).`
        );
        return shapingOnlyFallbackOutcome(fallbackBody, allowancePause, first.lcmOutcome);
      }
      log(`compaction gateway: stored authorization ${authorization.id} did not apply - ${first.reason} (fail-open, original forwarded unchanged).`);
      // A no-op the engine PRODUCED still says why LCM did not contribute; a bare `null` would drop
      // that from the receipt on exactly the did-not-contribute turns.
      return first.lcmOutcome !== undefined || first.outputShapingState !== undefined
        ? {
            declined: true,
            ...(first.lcmOutcome !== undefined ? { lcmOutcome: first.lcmOutcome } : {}),
            ...(first.outputShapingState !== undefined ? { outputShapingState: first.outputShapingState } : {}),
            ...(first.outputShapingPolicyVersion !== undefined
              ? { outputShapingPolicyVersion: first.outputShapingPolicyVersion }
              : {})
          }
        : null;
    }

    let decision: AppliedEngineDecision = first;
    let artifacts = first.receiptArtifacts;
    if (!artifacts || first.mutatedRequestBody === originalText) {
      // An apply decision without the content-free receipt artifacts (or a no-op body) cannot build
      // an honest receipt → fail-closed decline (original forwarded unchanged).
      log(`compaction gateway: stored authorization ${authorization.id} engine apply returned no usable receipt artifacts - record mode, original forwarded.`);
      return null;
    }

    // OVERSHOOT CEILING (post-dispatch, PRE-COMMIT): the pre-dispatch check only proved SOME allowance
    // remained; this proves THIS request fits inside the SNAPSHOT. When the engine's metered
    // pre-mutation count exceeds the remainder, the WHOLE request is refused (never partially
    // metered) and the original is forwarded unchanged — so "never meter past the allowance" holds
    // for a single oversized request too. The count comes from the SAME resolver the journal commit
    // uses, so the number refused on cannot drift from the number that would have been recorded.
    //
    // This is the SINGLE-REQUEST guard and it is still evaluated against the pre-dispatch snapshot,
    // so it does NOT bound concurrent applies on its own — the binding CONCURRENT guarantee is the
    // re-validation carried into the debit and evaluated under the journal append lock (below).
    // Keeping this one here means an oversized single request is refused BEFORE anything is retained.
    // WHAT THE ALLOWANCE ACTUALLY BUYS. `optimized-input-v2` meters INPUT compaction, so both the
    // ceiling below and the debit further down apply to an apply that compacted input — and to no
    // other. An output-shaping-only apply (the ceiling's own degradation, and any turn where dedupe
    // found nothing but the shaper did) compacts no input: it must not be refused for want of input
    // allowance, and it must not write an optimized-input debit for having run. Output shaping is the
    // Open/base capability; charging it to the Community input allowance, or withholding it once that
    // allowance is spent, would put a Community user at their ceiling BELOW the Open baseline.
    const compactsInput = (components: unknown[]): boolean =>
      components.some((component) => component === "lcm-compaction" || component === "deterministic-compaction");
    let compactedInput = compactsInput(artifacts.applied_components as unknown[]);

    if (compactedInput) {
      const { tokens: wouldMeter, meterVersion: wouldMeterVersion } = resolveMeteredOptimizedInput({
        ...(decision.meterVersion !== undefined ? { meterVersion: decision.meterVersion } : {}),
        ...(decision.meteredOptimizedInputTokens !== undefined
          ? { meteredOptimizedInputTokens: decision.meteredOptimizedInputTokens }
          : {}),
        preMutationBody: originalText
      });

      // A DEBIT THIS CLIENT CANNOT PLACE IS NOT A DEBIT OF ZERO. The engine is installed separately
      // and versioned on its own cadence, so a client on `optimized-input-v2` can meet an engine that
      // reports the v1 THROUGHPUT count — everything it inspected, ~19x the removal on measured data —
      // or the documented `chars/4` fallback, which is the same throughput basis. Charging either
      // against a balance denominated in tokens REMOVED overstates the cost by that factor and writes
      // a permanent misreading into the audit history; charging it at zero makes input compaction free
      // and unbounded. Both are wrong, so the apply is DECLINED and the original forwarded unchanged.
      //
      // Checked HERE, at the same resolution the debit uses, so nothing is retained or forwarded on a
      // debit that the journal is going to refuse anyway. `appendUsageEvent` refuses it again under
      // the lock — this is the early, diagnosable half of one fail-closed rule, not a second rule.
      //
      // This is NOT an allowance decision, so it does not degrade to output shaping and does not
      // claim a pause: nothing about the user's allowance is known here.
      if (wouldMeterVersion !== ACTIVE_USAGE_METER_VERSION) {
        log(
          `compaction gateway: stored authorization ${authorization.id} did not apply - the engine reported an optimized-input count in an unrecognized meter unit (${wouldMeterVersion}); nothing debited, original forwarded unchanged. Update the engine to restore input optimization.`
        );
        return null;
      }

      if (wouldMeter > localRemainingTokens) {
        // OVERSHOOT: this single request's optimized input does not fit inside the snapshot, so the
        // INPUT plan is refused whole (never partially metered, never auto-purchased). Re-dispatch with
        // a zero remainder so the engine emits its output-shaping-only treatment instead: the same
        // degradation the exhausted case takes, for the same reason — the refusal is about input
        // allowance, and output shaping is not bought with it. If the re-plan yields nothing usable
        // (e.g. the task-aware gate holds shaping on a planning turn), decline as before.
        log(
          `compaction gateway: stored authorization ${authorization.id} - this request's optimized input exceeds the remaining allowance for this period; input optimization paused, output shaping continues (no auto-purchase).`
        );
        const degraded = await dispatchEngine(0);
        const degradedArtifacts = degraded.decision === "apply" ? degraded.receiptArtifacts : undefined;
        if (
          degraded.decision !== "apply" ||
          degradedArtifacts === undefined ||
          degraded.mutatedRequestBody === originalText ||
          compactsInput(degradedArtifacts.applied_components as unknown[])
        ) {
          // The engine could not produce it (refused, no-op, or - on a pre-route-independent engine -
          // still compacted input). Shape in-process instead so the ceiling never costs the baseline.
          const fallbackBody = planShapingOnlyFallback();
          if (fallbackBody === undefined) {
            log(`compaction gateway: stored authorization ${authorization.id} did not apply - no output-shaping-only treatment available for this request (original forwarded unchanged).`);
            return null;
          }
          log(`compaction gateway: stored authorization ${authorization.id} - the engine returned no output-shaping-only treatment; applying the public baseline shaping instead (nothing debited).`);
          return shapingOnlyFallbackOutcome(fallbackBody, pauseFor("insufficient"));
        }
        decision = degraded;
        artifacts = degradedArtifacts;
        compactedInput = false;
        // INSUFFICIENT, NOT SPENT. Tokens remain; this turn is simply larger than they cover. Saying
        // "allowance spent" here would be false, and it is the surface asking the user to convert.
        allowancePause = pauseFor("insufficient");
      }
    }

    // THE ENGINE GOT THERE FIRST. The branch above only runs when the FIRST dispatch came back having
    // compacted input — but that dispatch carries the real remainder, so the engine's own ceiling
    // (defense in depth) degrades to output-shaping-only before the body ever reaches here. In every
    // overshoot the branch above may therefore be bypassed, and a turn that was refused for want of
    // allowance would otherwise look exactly like a healthy shaping turn: no pause on the receipt,
    // no ceiling clause on the per-turn line, and no conversion path.
    //
    // So honor the engine's own signal as the authoritative one. `exceedsQuota` fires only for a
    // metered route inside a real allowance window, and `pauseFor` is not overwritten: a pre-dispatch
    // EXHAUSTED pause is already the truer statement of the same turn (nothing remains, rather than
    // not enough), and it was set from this side's own reading of the journal.
    if (allowancePause === undefined && decision.quotaDegraded === true) {
      log(
        `compaction gateway: stored authorization ${authorization.id} - this request's optimized input exceeds the remaining allowance for this period; input optimization paused, output shaping continues (no auto-purchase).`
      );
      allowancePause = pauseFor("insufficient");
    }

    // RETENTION (PUBLIC, before forwarding any mutation): retain the byte-exact original for recovery
    // FIRST. If retention fails, nothing is applied (fail-closed) - a mutation without a recoverable
    // original never happens.
    let recoveryId: string;
    try {
      recoveryId = saveOriginalForRecovery(cwd, { endpoint, policy: DEDUPE_POLICY, originalBody: originalText });
    } catch (error) {
      log(`compaction gateway: stored authorization ${authorization.id} changed the body but the original was not retained (${(error as Error).message}) - fail-closed, original forwarded.`);
      return null;
    }

    // ABANDONMENT WINDOW (content-on-disk hygiene). From the successful retention above until the
    // applied outcome is returned, the retained original belongs to THIS request and NOTHING else
    // references it: the receipt, the activity record, and the usage entry that publish a
    // `recovery_id` are all written only for an outcome this function returns as applied. So every
    // exit that is NOT that return - a metering refusal for ANY reason (credentials/lease/signing
    // unavailable, journal unreadable or integrity-failed under the lock, lock unavailable, the
    // under-lock allowance-ceiling refusal) or an unexpected throw caught by the fail-open handler
    // below - abandons the record, leaving an original request body on disk that no surface can ever
    // name and no normal path can ever clean up. The `finally` deletes exactly those, which is why it
    // is structural rather than a delete beside each `return null`: a future decline added here is
    // covered without remembering to add anything. An APPLIED mutation keeps its record - that is the
    // byte-exact recovery guarantee and it is never touched. Deletion is best-effort and changes
    // nothing about the request: the original is forwarded unchanged either way.
    let recoveryCommitted = false;
    try {
      // Rebuild the exact public DedupePlan + OptimizationPlan the receipt records from the engine's
      // content-free artifacts (counts/labels only). These are transport data, not request content.
      // Done BEFORE the debit commits: a malformed engine artifact must fail the apply while nothing has
      // been debited yet (closing the debit-without-mutation window).
      // Read off whichever artifacts actually produced the forwarded body — so the degraded re-plan
      // below cannot leave the receipt describing the composed plan it replaced.
      const receiptFacts = (from: NonNullable<typeof artifacts>) => ({
        plan: from.deterministic_plan as unknown as DedupePlan,
        optimizationPlan: from.optimization_plan as OptimizationPlanType,
        appliedComponents: from.applied_components as Array<"lcm-compaction" | "deterministic-compaction" | "output-shaping">,
        // Engine-computed on the FINAL forwarded body; absent from an older engine ⇒ undefined ⇒ unknown.
        outputShapingState: from.output_shaping_state as "attached-this-pass" | "already-active" | "absent" | undefined,
        outputShapingPolicyVersion: from.output_shaping_policy_version as string | undefined,
        outputShapingRegime: from.output_shaping_regime as "default-shapeable" | undefined,
        lcmOutcome: from.lcm_outcome as { kind: string; reason: string } | undefined,
        // Gate list, in the exact order the previous in-process eligibility produced it: the public
        // deterministic-policy/scope-match gates, then the engine's supported-shape/change-produced,
        // then this function's original-retainable (retention just succeeded).
        gatesPassed: [
          ...Object.entries(gates.gateResults).filter(([, r]) => r === "pass").map(([gate]) => gate),
          ...Object.entries(from.shape_gate_results).filter(([, r]) => r === "pass").map(([gate]) => gate),
          "original-retainable"
        ]
      });
      let { plan, optimizationPlan, appliedComponents, outputShapingState, outputShapingPolicyVersion, outputShapingRegime, lcmOutcome, gatesPassed } = receiptFacts(artifacts);

      // METER — the SINGLE metering hook, at the one confirmed-apply site: engine returned a
      // usable, changed, recoverable mutation, the byte-exact original was retained, this request fits
      // under the ceiling, and the receipt artifacts rebuilt cleanly. Committed BEFORE the outcome
      // returns (committed-before-complete). ROUTE-INDEPENDENT, AND GATED ON `compactedInput`: what
      // buys a debit is that INPUT was compacted, never which transport carried the turn — the
      // allowance pays for the Hybrid Engine, not for the provider billing route. `routeType` is
      // RECORDED on the entry, not consulted to skip this hook. A shaping-only turn leaves
      // `compactedInput` false and writes nothing, on every route. The debit is content-free +
      // device-signed + hash-chained. Fail-CLOSED for the mutation: if metering does not commit (missing
      // credentials/lease, signing/append/lock failure, or the under-lock ceiling re-check refusing),
      // DECLINE the apply so a mutation is never forwarded without its debit recorded (a debit and a
      // mutation are atomic-or-neither) and total usage never passes the period ceiling.
      if (compactedInput) {
        const meterResult = await commitApplyDebit(
          {
            routeType,
            workflow: scope.tool,
            provider: options.provider,
            periodId,
            // The lease's allowance travels with the debit so the AUTHORITATIVE remaining-allowance
            // test can be re-evaluated against a fresh tally inside the journal append lock.
            allowanceTokens,
            recoveryId,
            ...(decision.meterVersion !== undefined ? { meterVersion: decision.meterVersion } : {}),
            ...(decision.meteredOptimizedInputTokens !== undefined
              ? { meteredOptimizedInputTokens: decision.meteredOptimizedInputTokens }
              : {}),
            ...(decision.estimatedInputTokensBefore !== undefined
              ? { estimatedInputTokensBefore: decision.estimatedInputTokensBefore }
              : {}),
            ...(decision.estimatedInputTokensAfter !== undefined
              ? { estimatedInputTokensAfter: decision.estimatedInputTokensAfter }
              : {}),
            ...(decision.usageDebit?.event_id ? { engineEventId: decision.usageDebit.event_id } : {}),
            preMutationBody: originalText
          },
          meteringEnv
        );
        if (!meterResult.metered) {
          // THE UNDER-LOCK CEILING is the third and last place an INPUT allowance can refuse this
          // request — it is the binding guarantee for CONCURRENT applies, where several in-flight
          // requests each passed the same pre-dispatch snapshot. A ceiling refusal here means the same
          // thing as the two above: no allowance for input compaction. It says nothing about output
          // shaping, so degrade to the shaping-only treatment rather than dropping both. Retention
          // already holds the byte-exact original, which is what the degraded body recovers to as well.
          //
          // EVERY OTHER REASON STAYS FAIL-CLOSED (missing credentials/lease, signing failure, journal
          // unreadable or unappendable): those are integrity failures, not allowance decisions, and a
          // mutation must never be forwarded on the strength of a debit that could not be recorded.
          const ceilingRefusal = meterResult.reason.includes("allowance-ceiling-exceeded");
          const degraded = ceilingRefusal ? await dispatchEngine(0) : undefined;
          const degradedArtifacts =
            degraded !== undefined && degraded.decision === "apply" ? degraded.receiptArtifacts : undefined;
          if (
            degraded === undefined ||
            degraded.decision !== "apply" ||
            degradedArtifacts === undefined ||
            degraded.mutatedRequestBody === originalText ||
            compactsInput(degradedArtifacts.applied_components as unknown[])
          ) {
            const fallbackBody = ceilingRefusal ? planShapingOnlyFallback() : undefined;
            if (fallbackBody === undefined) {
              log(
                `compaction gateway: stored authorization ${authorization.id} apply metering did not commit (${meterResult.reason}) - fail-closed, original forwarded unchanged.`
              );
              return null;
            }
            // Same reasoning as the pre-commit overshoot: the ceiling refused the INPUT plan, the engine
            // could not hand back a shaping-only treatment, and the baseline must survive that. The
            // helper retains its OWN original under the policy it actually applies; `recoveryCommitted`
            // stays false, so the `finally` discards the `deterministic-dedupe` record written above for
            // the input plan that is no longer being forwarded. One turn, one recovery record, one policy.
            log(
              `compaction gateway: stored authorization ${authorization.id} - remaining allowance did not cover this request's optimized input (${meterResult.reason}) and the engine returned no output-shaping-only treatment; applying the public baseline shaping instead (nothing debited, no auto-purchase).`
            );
            return shapingOnlyFallbackOutcome(fallbackBody, pauseFor("insufficient"));
          }
          log(
            `compaction gateway: stored authorization ${authorization.id} - remaining allowance did not cover this request's optimized input; input optimization paused, output shaping continues (nothing debited, no auto-purchase).`
          );
          decision = degraded;
          artifacts = degradedArtifacts;
          // Same product state as the pre-dispatch overshoot, reached under concurrency: what was left
          // did not cover this turn's optimized input once the fresh tally was read under the lock.
          allowancePause = pauseFor("insufficient");
          ({ plan, optimizationPlan, appliedComponents, outputShapingState, outputShapingPolicyVersion, outputShapingRegime, lcmOutcome, gatesPassed } = receiptFacts(degradedArtifacts));
        } else if (periodAllowanceTokens !== undefined && allowancePause === undefined) {
          // THE COUNTDOWN, recorded where the debit happened. `remainingTokens` is measured under the
          // journal append lock against the same fresh tally the ceiling refuses on, so it already
          // accounts for every concurrent apply that committed while this one was in the engine —
          // which the pre-dispatch `localRemainingTokens` above cannot, since all of them read it.
          //
          // COHERENCE GATE: a remainder above the total, or a zero total, is a lease the server should
          // never have signed. Rendering `2.1M/2M left` off one would be worse than rendering nothing,
          // so an incoherent pair is dropped rather than clamped into a number that looks authoritative.
          const remaining = Math.max(0, meterResult.remainingTokens);
          if (periodAllowanceTokens > 0 && remaining <= periodAllowanceTokens) {
            allowanceSnapshot = {
              remaining_tokens: remaining,
              period_total_tokens: periodAllowanceTokens,
              ...(periodId !== "" ? { period_id: periodId } : {})
            };
          }
        }
      }
      const scopeLine = authorization.scope.repo
        ? `${authorization.scope.tool} repo ${authorization.scope.repo}`
        : authorization.scope.tool;
      // The retained original is now COMMITTED: the outcome below carries its id to the receipt and
      // the activity record, and the mutation it recovers is about to be forwarded.
      recoveryCommitted = true;
      return {
        activation: {
          mode: "apply",
          requested: true,
          policy: artifacts.lcm_contributed ? LCM_APPLY_POLICY : DEDUPE_POLICY,
          activation: "stored-authorization"
        },
        outcome: {
          plan,
          optimizationPlan,
          applied: true,
          mutatedBody: Buffer.from(decision.mutatedRequestBody, "utf8"),
          recoveryId,
          appliedComponents,
          outputShapingState,
          outputShapingPolicyVersion,
          outputShapingRegime,
          lcmOutcome,
          composedInputEstimate: artifacts.composed_input_estimate,
          authorization: { id: authorization.id, scopeLine, gatesPassed },
          ...(allowancePause ? { allowancePause } : {}),
          // A pause set under the lock (the concurrent-ceiling branch above) supersedes a snapshot
          // taken earlier in the same turn: the two describe the same allowance, and the line must
          // not both count down and announce a pause.
          ...(allowanceSnapshot && !allowancePause ? { allowanceSnapshot } : {})
        }
      };
    } finally {
      // Content-free: the id is a random local uuid and the label names no request content. Silent on
      // success (the decline itself is already logged); a failed delete is surfaced because the file
      // then stays on disk and only the user can remove it.
      if (!recoveryCommitted && !discardRecoveryRecord(cwd, recoveryId)) {
        log(
          `compaction gateway: retained original ${recoveryId} could not be removed after the apply was declined - it is local-only under ${GATEWAY_RECOVERY_DIR} and can be deleted.`
        );
      }
    }
  } catch (error) {
    // Fail-open: a Compaction failure (unreadable preference file, engine error, anything) never
    // blocks the workflow - the request proceeds as plain record with the original bytes.
    log(`compaction gateway: stored-authorization path failed (${(error as Error).message}) - record mode, original forwarded unchanged (fail-open).`);
    return null;
  }
}

/** Append the content-free auto-apply activity record (best-effort; never affects the client). */
async function recordAutoApplyActivity(params: {
  options: GatewayServerOptions;
  workflow: string;
  apply: ApplyOutcome;
  requestModel?: string;
  log: (line: string) => void;
}): Promise<void> {
  const { apply } = params;
  // Mirrors the caller's guard: an input plan, or an output component that ran without one.
  const shapedOnly = apply.plan === undefined && apply.appliedComponents?.includes("output-shaping") === true;
  if ((!apply.plan && !shapedOnly) || !apply.recoveryId || !apply.authorization) return;
  const result = await appendAutoApplyActivityEvent({
    cwd: params.options.cwd ?? process.cwd(),
    workflow: params.workflow,
    ...(params.requestModel ? { requestModel: params.requestModel } : {}),
    ...(apply.plan ? { plan: apply.plan } : {}),
    recoveryId: apply.recoveryId,
    authorizationId: apply.authorization.id,
    authorizationScopeLine: apply.authorization.scopeLine,
    gatesPassed: apply.authorization.gatesPassed,
    appliedComponents: apply.appliedComponents,
    composedInputEstimate: apply.composedInputEstimate
  });
  if (!result.appended) {
    params.log(`compaction gateway: auto-apply activity record not appended (${result.reason}) - receipts still recorded.`);
  }
}

/**
 * The fixed, content-free reason recorded when planning the EXPLICIT apply route threw unexpectedly.
 * A capability statement, not a request-shape refusal and not a saving: the request itself was fine,
 * we simply could not plan a mutation for it.
 */
export const EXPLICIT_APPLY_UNAVAILABLE_REASON =
  "apply could not be planned in this build - original forwarded unchanged";

/**
 * The fixed, content-free reason recorded when the byte-exact original could not be retained for
 * recovery. Nothing is ever mutated without a recoverable original, so this is a fail-closed decline.
 */
export const APPLY_RETENTION_FAILED_REASON =
  "could not retain the original for recovery - forwarded unchanged";

/**
 * The fail-open wrapper around {@link resolveApplyOutcome}, and the ONLY way `handleProxy` calls it.
 *
 * FAIL CLOSED FOR MUTATION, FAIL OPEN FOR THE WORKFLOW. `resolveApplyOutcome` reaches the private
 * compactor through the lazy input-compaction seam, so it can throw for reasons that have nothing to
 * do with this request — a packaging defect, a bug inside a present planner. `handleProxy` is invoked
 * as a floating `void handleProxy(...)`, so ANY throw that escapes it aborts the proxy before a
 * response is written: an explicitly-apply-mode request would be strictly more fragile than a
 * record-mode one. This wrapper is what makes the explicit route degrade like the
 * stored-authorization path beside it. Do not call `resolveApplyOutcome` directly.
 *
 * The degraded outcome carries `applied: false` and no `mutatedBody`, so the caller forwards the
 * ORIGINAL bytes: an unexpected error can never produce a model-visible mutation, and the receipt
 * records the turn honestly as a non-apply with a fixed reason. Only the error's CLASS is logged —
 * a thrown message could carry request content, and this log line is content-free.
 */
async function resolveApplyOutcomeFailOpen(
  activation: ApplyActivation,
  endpoint: string,
  method: string | undefined,
  originalBody: Buffer,
  options: GatewayServerOptions,
  log: (line: string) => void
): Promise<ApplyOutcome | null> {
  try {
    return await resolveApplyOutcome(activation, endpoint, method, originalBody, options, log);
  } catch (error) {
    const errorClass = error instanceof Error ? error.name : typeof error;
    log(
      `compaction gateway: apply planning failed (${errorClass}) - ${EXPLICIT_APPLY_UNAVAILABLE_REASON}.`
    );
    // No apply was requested → stay exactly where a record-mode request already was (null).
    if (!activation.requested) return null;
    return { applied: false, failClosedReason: EXPLICIT_APPLY_UNAVAILABLE_REASON };
  }
}

/**
 * Decide what apply does for this request. NEVER mutates unless: apply mode is active, the shape is
 * supported, a safe duplicate exists, AND the original was successfully retained for recovery FIRST.
 * dry-run always forwards the original. Any uncertainty → fail closed (forward original, record the reason).
 *
 * The compaction plan comes from the lazy input-compaction seam. With the compactor absent the seam
 * returns an unsupported plan, which lands on the existing fail-closed branch below: nothing is
 * applied, the original is forwarded unchanged, and the receipt carries the seam's reason.
 */
async function resolveApplyOutcome(
  activation: ApplyActivation,
  endpoint: string,
  method: string | undefined,
  originalBody: Buffer,
  options: GatewayServerOptions,
  log: (line: string) => void
): Promise<ApplyOutcome | null> {
  if (!activation.requested) return null;
  if (activation.failClosedReason) return { applied: false, failClosedReason: activation.failClosedReason };
  if (method !== "POST") return { applied: false, failClosedReason: `apply supports only POST requests; got ${method ?? "unknown"} - forwarded unchanged` };

  const plan = await planInputCompaction(endpoint, originalBody.toString("utf8"));
  const optimizationPlan = planBestSafeOptimization({
    deterministicPlan: plan,
    providerCache: {
      capability: options.workflow === "codex" || options.workflow === "claude-code",
      observedReduction: false
    },
    // Explicit mode/header is the runtime's approval fact. It is deliberately
    // separate from stored authorization, which is handled by the eligibility path.
    authorization: { storedAuthorization: false, explicitApproval: true }
  });
  if (!plan.supported) return { plan, optimizationPlan, applied: false, ...(plan.failClosedReason ? { failClosedReason: plan.failClosedReason } : {}) };
  if (activation.mode === "dry-run") return { plan, optimizationPlan, applied: false }; // preview only - original forwarded
  if (optimizationPlan.selectedMethod !== "deterministic-compaction") {
    return {
      plan,
      optimizationPlan,
      applied: false,
      failClosedReason: `optimization planner selected '${optimizationPlan.selectedMethod}' - original forwarded unchanged`
    };
  }
  if (!plan.changed || !plan.mutatedBody) return { plan, optimizationPlan, applied: false }; // no safe duplicate → forward original

  // APPLY: retain the exact original locally FIRST; only then forward the mutated body. If retention
  // fails we fail closed (never mutate without a recoverable original).
  //
  // No abandonment window exists on THIS path (unlike the stored-authorization path): retention is the
  // last decision, the applied outcome is returned on the next line, and the caller forwards the
  // mutated body unconditionally. Every record written here is therefore published by the apply
  // receipt. Any future decline added between the save and the return would have to delete the record
  // it abandoned.
  try {
    const recoveryId = saveOriginalForRecovery(options.cwd ?? process.cwd(), {
      endpoint,
      policy: activation.policy ?? "deterministic-dedupe",
      originalBody: originalBody.toString("utf8")
    });
    return { plan, optimizationPlan, applied: true, mutatedBody: Buffer.from(plan.mutatedBody, "utf8"), recoveryId };
  } catch (e) {
    // The thrown message is a local filesystem detail (paths, errno text). It may reach the LOG in
    // class form only, and must not reach `failClosedReason` at all: that field is copied onto the
    // content-free receipt, which is a stricter surface than a log line. Same rule as the fail-open
    // wrapper above, and the same fixed phrasing the LCM boundary already uses for this decline.
    const errorClass = e instanceof Error ? e.name : typeof e;
    log(`compaction gateway: apply retention failed (${errorClass}) - forwarding original unchanged.`);
    return { plan, applied: false, failClosedReason: APPLY_RETENTION_FAILED_REASON };
  }
}

/** Build + append the content-free APPLY/dry-run receipt. Best-effort: never affects the client. */
async function recordApplyReceiptFor(params: {
  options: GatewayServerOptions;
  adapter: ProviderAdapter;
  activation: ApplyActivation;
  apply: ApplyOutcome;
  endpoint: string;
  upstreamStatus: number;
  responseTail: string;
  usageUnavailableReason?: string;
  requestModel?: string;
  /** Device-local keyed hash of the tool session id; recorded on every receipt, both modes. */
  sessionCorrelationId?: string;
  /** When the gateway received the request; the run-membership timestamp (see `GatewayReceipt`). */
  requestStartedAt?: string;
  /** The engine's LCM outcome when the stored path declined after the engine ran; `apply` wins when it carries one. */
  lcmOutcome?: { kind: string; reason: string };
  proofRunId?: string;
  proofVariant?: "baseline" | "compacted";
  /** The route this turn was forwarded on, resolved once per request by `upstreamRouteTypeFor`. */
  upstreamRouteType: "api-key" | "subscription";
  log: (line: string) => void;
}): Promise<void> {
  try {
    // Adapter routes usage extraction; bridge back to the OpenAI breakdown the receipt builder consumes.
    const usage = usageWithReason(
      openAiBreakdownFromNormalizedUsage(params.adapter.extractUsage(params.responseTail)),
      params.usageUnavailableReason
    );
    // The applied outcome's own outcome first; the engine's declined outcome only when the apply
    // that followed (an in-process shaping fallback) carries none.
    const lcmOutcome = params.apply.lcmOutcome ?? params.lcmOutcome;
    const receipt = buildApplyReceipt({
      provider: params.options.provider,
      endpoint: params.endpoint,
      upstreamStatus: params.upstreamStatus,
      usage,
      activation: params.activation,
      applied: params.apply.applied,
      ...(params.apply.plan ? { plan: params.apply.plan } : {}),
      ...(params.apply.optimizationPlan ? { optimizationPlan: params.apply.optimizationPlan } : {}),
      ...(params.apply.recoveryId ? { recoveryId: params.apply.recoveryId } : {}),
      ...(params.apply.authorization ? { authorizationId: params.apply.authorization.id } : {}),
      ...(params.apply.appliedComponents ? { appliedComponents: params.apply.appliedComponents } : {}),
      ...(params.apply.outputShapingState ? { outputShapingState: params.apply.outputShapingState } : {}),
      ...(params.apply.outputShapingPolicyVersion
        ? { outputShapingPolicyVersion: params.apply.outputShapingPolicyVersion }
        : {}),
      ...(params.apply.outputShapingRegime ? { outputShapingRegime: params.apply.outputShapingRegime } : {}),
      ...(lcmOutcome ? { lcmOutcome } : {}),
      ...(params.apply.composedInputEstimate ? { composedInputEstimate: params.apply.composedInputEstimate } : {}),
      ...(params.apply.failClosedReason ? { failClosedReason: params.apply.failClosedReason } : {}),
      ...(params.apply.allowancePause ? { allowancePause: params.apply.allowancePause } : {}),
      ...(params.apply.allowanceSnapshot ? { allowanceSnapshot: params.apply.allowanceSnapshot } : {}),
      // The route this turn was actually forwarded on, from the same expression the usage debit uses.
      // It rides on EVERY apply receipt, not only a metered one: the cost clause it gates is rendered
      // from the receipt alone, including on a replay months later, and a receipt that records no
      // route suppresses the clause rather than assuming the billed one.
      upstreamRouteType: params.upstreamRouteType,
      ...(params.requestModel ? { requestModel: params.requestModel } : {}),
      ...(params.sessionCorrelationId ? { sessionCorrelationId: params.sessionCorrelationId } : {}),
      ...(params.requestStartedAt ? { requestStartedAt: params.requestStartedAt } : {}),
      ...(params.proofRunId ? { proofRunId: params.proofRunId } : {}),
      ...(params.proofVariant ? { proofVariant: params.proofVariant } : {})
    });
    params.options.onReceipt?.(receipt);
    await appendGatewayReceipt(receipt, params.options.cwd ?? process.cwd());
    // Per-turn receipt line: the SINGLE canonical content-free line (counts + labels + source + short
    // id - never content). The receipt above is unchanged; this is display only, and the kill switch
    // (`COMPACTION_RECEIPT_LINE=0`) silences it without affecting what was written to receipts.jsonl.
    if (isReceiptLineEnabled()) {
      const line = await perTurnLineFromReceipt(receipt, params.options);
      if (line) params.log(line);
    }
  } catch {
    // Never let receipt recording break the proxy; the client's response already completed.
  }
}

/** Build + append the content-free receipt. Best-effort: a failure here never affects the client. */
async function recordReceipt(params: {
  options: GatewayServerOptions;
  adapter: ProviderAdapter;
  endpoint: string;
  upstreamStatus: number;
  responseTail: string;
  /** Present when the usage-parsing copy could not be decompressed; the honest `unavailable` reason. */
  usageUnavailableReason?: string;
  requestModel?: string;
  /** Device-local keyed hash of the tool session id; recorded on every receipt, both modes. */
  sessionCorrelationId?: string;
  /** When the gateway received the request; the run-membership timestamp (see `GatewayReceipt`). */
  requestStartedAt?: string;
  /** Fixed-vocabulary LCM outcome when the engine ran for this turn and applied nothing. */
  lcmOutcome?: { kind: string; reason: string };
  /** Output-shaping provenance for the forwarded bytes; see `buildGatewayReceipt`. */
  outputShapingState?: "attached-this-pass" | "already-active" | "absent";
  outputShapingPolicyVersion?: string;
  proofRunId?: string;
  proofVariant?: "baseline" | "compacted";
  log: (line: string) => void;
}): Promise<void> {
  try {
    // Adapter routes usage extraction; bridge back to the OpenAI breakdown the receipt builder consumes.
    const usage = usageWithReason(
      openAiBreakdownFromNormalizedUsage(params.adapter.extractUsage(params.responseTail)),
      params.usageUnavailableReason
    );
    const receipt = buildGatewayReceipt({
      provider: params.options.provider,
      endpoint: params.endpoint,
      mode: "record",
      upstreamStatus: params.upstreamStatus,
      usage,
      ...(params.requestModel ? { requestModel: params.requestModel } : {}),
      ...(params.sessionCorrelationId ? { sessionCorrelationId: params.sessionCorrelationId } : {}),
      ...(params.requestStartedAt ? { requestStartedAt: params.requestStartedAt } : {}),
      ...(params.lcmOutcome ? { lcmOutcome: params.lcmOutcome } : {}),
      ...(params.outputShapingState ? { outputShapingState: params.outputShapingState } : {}),
      ...(params.outputShapingPolicyVersion
        ? { outputShapingPolicyVersion: params.outputShapingPolicyVersion }
        : {}),
      ...(params.proofRunId ? { proofRunId: params.proofRunId } : {}),
      ...(params.proofVariant ? { proofVariant: params.proofVariant } : {})
    });
    params.options.onReceipt?.(receipt);
    await appendGatewayReceipt(receipt, params.options.cwd ?? process.cwd());
    // Per-turn receipt line: the SINGLE canonical content-free line. Record mode surfaces a
    // provider-reported cache delta only when the receipt already asserts one; never a mutation claim
    // (model-visible bytes unchanged). Display only - receipts.jsonl is unchanged; kill-switch honored.
    if (isReceiptLineEnabled()) {
      const line = await perTurnLineFromReceipt(receipt, params.options);
      if (line) params.log(line);
    }
  } catch {
    // Never let receipt recording break the proxy; the client's response already completed.
  }
}

/** Idle-check cadence for a given TTL: frequent enough to be timely, never a busy loop. */
function idleCheckIntervalMs(ttlMs: number): number {
  return Math.min(Math.max(Math.floor(ttlMs / 4), 25), 30_000);
}

/**
 * Attach idle auto-shutdown to a gateway server: track the last handled request and the number of
 * requests currently in flight; on an unref'd periodic timer (it never keeps the process alive),
 * once the server has been idle longer than `ttlMs` with ZERO requests in flight, stop accepting
 * new connections, close idle keep-alive sockets, and fire `onShutdown` (the CLI removes the
 * pidfile there). The in-flight guard means a slow request is NEVER cut off: shutdown fires only
 * when the server is genuinely idle. The idle check and `server.close()` run in the same
 * synchronous tick, so no request handler can start between the check and the close.
 */
export function attachIdleShutdown(server: http.Server, ttlMs: number, onShutdown: () => void): void {
  let inFlight = 0;
  let lastActivityAt = Date.now();
  // A second "request" listener alongside createServer's handler: counters only, never touches req/res.
  server.on("request", (_req: http.IncomingMessage, res: http.ServerResponse) => {
    inFlight += 1;
    lastActivityAt = Date.now();
    // "close" fires whether the response finished normally or the connection aborted - no leak either way.
    res.once("close", () => {
      inFlight -= 1;
      lastActivityAt = Date.now();
    });
  });
  const timer = setInterval(() => {
    if (inFlight > 0) return; // never shut down mid-request
    if (Date.now() - lastActivityAt <= ttlMs) return; // not idle long enough yet
    clearInterval(timer);
    server.close(); // stop accepting new connections; in-flight requests (none) would still complete
    server.closeIdleConnections?.(); // drop idle keep-alive sockets so close() completes promptly
    onShutdown();
  }, idleCheckIntervalMs(ttlMs));
  timer.unref(); // the timer must never keep the process alive on its own
  server.once("close", () => clearInterval(timer)); // external stop (SIGTERM/Ctrl-C) also clears the timer
}

export interface StartedGateway {
  server: http.Server;
  /** The bound address (host + port). */
  address: { host: string; port: number };
  close: () => Promise<void>;
}

/** Start the gateway on `host:port`. Resolves once it is listening. */
export function startGatewayServer(options: GatewayServerOptions & { host: string; port: number }): Promise<StartedGateway> {
  const server = createGatewayServer(options);
  if (options.idleTtlMs !== undefined && options.idleTtlMs > 0) {
    attachIdleShutdown(server, options.idleTtlMs, () => options.onIdleShutdown?.());
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : options.port;
      resolve({
        server,
        address: { host: options.host, port },
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}
