/**
 * Native-engine IPC protocol (PUBLIC — the public client owns the client half).
 *
 * The versioned, framed, local-only wire contract between the public client supervisor and the
 * private native engine. It is transport-agnostic in spirit but
 * carried over the supervised child's stdin/stdout as length-prefixed JSON frames — NOT a TCP
 * listener and NOT a new gateway. Every field here is content-free metadata or the request bytes
 * the gateway already forwards upstream; there are NO provider credentials and NO Authorization
 * headers anywhere in these types, and the protocol never carries a network endpoint.
 *
 * Framing: each frame is a 4-byte big-endian unsigned length prefix followed by exactly that many
 * bytes of UTF-8 JSON. A bounded maximum frame size is enforced on both encode and decode so a
 * malformed or hostile length can never allocate unboundedly. The protocol is versioned
 * (`protocol_version: 1`); a version the peer does not speak is a clean refusal/degrade, never a
 * throw into the request path.
 *
 * This module is engine-free at import: it defines the shared shapes and the frame codec only. It
 * imports nothing from `src/engine/**` (the supervisor reaches the engine solely by spawning the
 * child process). `npm run boundary:engine` keeps the CLI graph at zero static engine edges.
 */

/** The one protocol version this client half speaks. A mismatch degrades; it never throws. */
export const ENGINE_IPC_PROTOCOL_VERSION = 1 as const;
export type EngineIpcProtocolVersion = typeof ENGINE_IPC_PROTOCOL_VERSION;

/**
 * Maximum bytes of a single framed payload (the JSON body after the 4-byte length prefix).
 * Bounded so a corrupt/hostile length prefix can never drive an unbounded allocation. 8 MiB is
 * generously above any real request body while staying a hard ceiling.
 */
export const MAX_ENGINE_IPC_FRAME_BYTES = 8 * 1024 * 1024;

/** Width of the length prefix in bytes (big-endian uint32). */
export const ENGINE_IPC_LENGTH_PREFIX_BYTES = 4;

/** The operations the engine understands. `ping` is the liveness/version handshake. */
export type EngineIpcOperation = "plan_and_apply" | "dry_run" | "ping";

/** Terminal result classes an engine response may carry (includes explicit refusal states). */
export type EngineIpcResult = "applied" | "refused" | "noop" | "error";

/**
 * Opaque authorization descriptor. Content-free: a policy id and a scope hash only. The engine
 * uses these to bind a response to a scope; it never receives the authorization's contents, the
 * user's identity, or any credential.
 */
export interface EngineIpcAuthorization {
  policy_id: string;
  scope_hash: string;
}

/**
 * Opaque/signed entitlement placeholder. In this PR it is a passthrough token the supervisor may
 * forward; the engine treats it as opaque. It never contains a credential or a network endpoint.
 */
export interface EngineIpcEntitlement {
  /** Opaque token (signed placeholder; real signing/verification is a later PR). */
  token: string;
}

/**
 * Locally-allocated quota snapshot. Counts only — never a credential, never a control-plane call.
 * The engine may refuse when the locally-allocated remainder is exhausted; it performs no network.
 */
export interface EngineIpcQuota {
  period_id: string;
  locally_allocated_tokens_remaining: number;
}

/**
 * A request frame. `request_body` carries the framed request bytes as a UTF-8 string — the
 * same class of data the gateway already forwards upstream — and is the ONLY content-shaped field.
 * There is deliberately no `authorization_header`, no `api_key`, no `provider_url`: credentials and
 * network never cross this boundary.
 */
export interface EngineIpcRequest {
  protocol_version: EngineIpcProtocolVersion;
  request_id: string;
  operation: EngineIpcOperation;
  /** Content-free workflow class id (e.g. the routed tool/workflow). */
  workflow: string;
  /** Content-free provider label (e.g. "openai" | "anthropic"), NOT a URL and NOT a key. */
  provider: string;
  /** Content-free route label (e.g. "api-key" | "subscription"). */
  route_type: string;
  /**
   * Content-free routed endpoint PATH (e.g. "/v1/messages", "/v1/chat/completions"). Selects the
   * request shape the engine's deterministic planner validates. NOT a URL, NOT a host, NOT a key —
   * the provider base URL and credentials never cross this boundary. Optional/additive.
   */
  endpoint?: string;
  /**
   * Whether the persisted optimization mode enabled deterministic pre-generation output shaping for
   * this request (content-free boolean the public gateway already knows). Optional/additive.
   */
  output_shaping_enabled?: boolean;
  /**
   * Whether the caller's VERIFIED entitlement covers hybrid/LCM input compaction for this request
   * (content-free boolean; Community and Pro do, Open does not).
   *
   * This is the ONLY channel that can activate input compaction inside the engine. It is carried
   * here, explicitly, rather than through the environment on purpose: the supervisor spawns the
   * child with a two-key env allowlist (`PATH`, `COMPACTION_ENGINE_IPC`), so an ambient
   * `COMPACTION_HYBRID_APPLY` on an operator's shell cannot reach the engine and cannot switch a
   * capability on. Activation therefore travels the same audited path as the authorization and
   * quota it belongs to, and a request that does not carry it is dormant by construction.
   *
   * Content-free: a boolean derived from an entitlement the gateway already verified. It carries no
   * lease id, no account, no signature — those never cross this boundary.
   *
   * Optional/additive: an older engine that does not read it simply stays dormant, so
   * `protocol_version` stays `1`.
   */
  input_compaction_enabled?: boolean;
  /** The request body bytes to optimize, as UTF-8. The only content-shaped field. */
  request_body: string;
  authorization: EngineIpcAuthorization;
  entitlement: EngineIpcEntitlement;
  quota: EngineIpcQuota;
}

/**
 * A usage debit the engine reports for a metered application. Counts + ids only.
 */
export interface EngineIpcUsageDebit {
  event_id: string;
  lease_id: string;
  tokens: number;
}

/**
 * Content-free receipt artifacts the engine returns alongside an `applied` mutation so the PUBLIC
 * gateway can build the identical content-free apply receipt + activity record it built when the
 * optimization ran in-process. Every field here is counts / labels / method names — the SAME
 * class of content-free data the gateway already writes into `receipts.jsonl`; there is deliberately
 * no request/prompt/candidate text. The shapes mirror the public `DedupePlan` / `OptimizationPlan`
 * structurally without importing them here (the protocol module stays engine-free at import).
 *
 * Optional and additive: an older peer that omits it degrades to `forward-original` in the seam, so
 * `protocol_version` stays `1` (a peer that does not populate it simply does not carry it).
 */
export interface EngineIpcReceiptArtifacts {
  /** Content-free deterministic-dedupe plan facts (counts, labels; NO body). */
  deterministic_plan: {
    policy: string;
    shape: string;
    supported: boolean;
    changed: boolean;
    failClosedReason?: string;
    removedBlocks: number;
    charsBefore: number;
    charsAfter: number;
    estTokensBefore: number;
    estTokensAfter: number;
    reductionPercent: number;
  };
  /** Content-free optimization-plan facts (selected/rejected method labels, evidence labels). */
  optimization_plan: unknown;
  /** Applied-component labels, in fixed order (lcm → deterministic → output-shaping). */
  applied_components: string[];
  /** Local-estimate model-visible input tokens over every changed component (counts only). */
  composed_input_estimate: { before: number; after: number };
  /** True when the LCM hybrid candidate contributed (selects the LCM policy receipt label). */
  lcm_contributed: boolean;
  /** Content-free shape-gate results the engine evaluated (pass/fail labels only). */
  shape_gate_results: Record<string, "pass" | "fail">;
}

/**
 * A response frame. `mutated_request_body`, when present, is the replacement request bytes
 * for the supervisor's caller to forward upstream — the same class of data the gateway forwards.
 * It is transport-only and is never recorded/logged by the supervisor. All other fields are
 * content-free counts, labels, or ids. `recovery_required` tells the caller a byte-exact recovery
 * path must exist before any mutation is used.
 */
export interface EngineIpcResponse {
  protocol_version: EngineIpcProtocolVersion;
  request_id: string;
  result: EngineIpcResult;
  /** Transport-only replacement body; present only when `result === "applied"`. */
  mutated_request_body?: string;
  /** Frozen meter version label when a metered optimization occurred (e.g. "optimized-input-v1"). */
  meter_version?: string;
  /** Pre-mutation model-visible input tokens metered (counts only). */
  metered_optimized_input_tokens?: number;
  /** Local estimate of model-visible input tokens after the mutation (counts only). */
  estimated_input_tokens_after?: number;
  /** Content-free labels of the components the engine applied (e.g. ["input-compaction"]). */
  applied_components: string[];
  recovery_required: boolean;
  usage_debit?: EngineIpcUsageDebit;
  /** Fixed reason label when `result === "refused"` | `"error"`; never engine internals/content. */
  failure_reason?: string;
  /** Content-free receipt artifacts for the public receipt/activity record; present on `applied`. */
  receipt_artifacts?: EngineIpcReceiptArtifacts;
  /**
   * THE ENGINE'S OWN CEILING FIRED: this `applied` result is the output-shaping-only DEGRADATION of a
   * request whose pre-mutation metered input exceeded the caller's declared remainder — not a turn
   * that simply had no input to compact. The two are indistinguishable from `applied_components`
   * alone (both report `["output-shaping"]` and meter zero), and the caller needs to tell them apart:
   * only the first one is a user hitting their allowance ceiling, and only the first one should say so
   * and offer a conversion path. Without this flag the caller's own overshoot branch — which requires
   * a body that compacted input — is unreachable whenever the engine degrades first, which it always
   * does, because the caller hands it the real remainder.
   *
   * A single boolean; no counts, no window, no reason text. OPTIONAL AND ADDITIVE: an older engine
   * omits it and the caller reads `undefined` (no pause claimed), so `protocol_version` stays `1`.
   */
  quota_degraded?: boolean;
}

/** A well-formed decoded frame body is one of these two shapes. */
export type EngineIpcMessage = EngineIpcRequest | EngineIpcResponse;

/** Thrown ONLY by the low-level codec on a frame that exceeds the bound or is malformed. Callers
 * (the supervisor / the engine reader) catch this and degrade — it never escapes into a request. */
export class EngineIpcFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineIpcFrameError";
  }
}

/**
 * Encode a message into a single length-prefixed frame. Enforces the max-frame bound on the
 * serialized JSON so an over-large payload is refused here (never written to the pipe).
 */
export function encodeFrame(message: EngineIpcMessage): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > MAX_ENGINE_IPC_FRAME_BYTES) {
    throw new EngineIpcFrameError(
      `frame body ${json.length} bytes exceeds max ${MAX_ENGINE_IPC_FRAME_BYTES}`
    );
  }
  const prefix = Buffer.allocUnsafe(ENGINE_IPC_LENGTH_PREFIX_BYTES);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json]);
}

/**
 * A bounded, backpressure-safe streaming frame decoder. Feed it chunks as they arrive; it yields
 * whole decoded frame bodies (parsed JSON) and buffers partial frames across chunks. The pending
 * buffer is bounded by the max frame size + prefix; a length prefix that claims more than the max
 * is a fatal `EngineIpcFrameError` (the caller degrades/kills the peer). It never blocks and never
 * allocates beyond one max frame.
 */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private declaredLength: number | null = null;

  /**
   * Push a chunk; returns every complete frame body newly available. Parsing errors on a complete
   * frame surface as `EngineIpcFrameError` so the caller can degrade rather than crash.
   */
  push(chunk: Buffer): EngineIpcMessage[] {
    // Bound the retained buffer: never hold more than one max frame plus its prefix in flight.
    if (this.pending.length + chunk.length > MAX_ENGINE_IPC_FRAME_BYTES + ENGINE_IPC_LENGTH_PREFIX_BYTES) {
      // Only fatal if we cannot possibly be mid-legitimate-frame: a declared length within bound
      // whose bytes simply have not all arrived is fine. Guard against unbounded growth from a
      // peer that never emits a valid prefix.
      if (this.declaredLength === null) {
        throw new EngineIpcFrameError("inbound buffer exceeded max frame size without a valid length prefix");
      }
    }
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const out: EngineIpcMessage[] = [];
    for (;;) {
      if (this.declaredLength === null) {
        if (this.pending.length < ENGINE_IPC_LENGTH_PREFIX_BYTES) break;
        const len = this.pending.readUInt32BE(0);
        if (len > MAX_ENGINE_IPC_FRAME_BYTES) {
          throw new EngineIpcFrameError(`declared frame length ${len} exceeds max ${MAX_ENGINE_IPC_FRAME_BYTES}`);
        }
        this.declaredLength = len;
        this.pending = this.pending.subarray(ENGINE_IPC_LENGTH_PREFIX_BYTES);
      }
      if (this.pending.length < this.declaredLength) break;
      const body = this.pending.subarray(0, this.declaredLength);
      this.pending = this.pending.subarray(this.declaredLength);
      this.declaredLength = null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        throw new EngineIpcFrameError("frame body was not valid JSON");
      }
      out.push(parsed as EngineIpcMessage);
    }
    return out;
  }
}

/** Narrow an unknown decoded frame to a request (validates the shape the engine reader relies on). */
export function isEngineIpcRequest(value: unknown): value is EngineIpcRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.protocol_version === ENGINE_IPC_PROTOCOL_VERSION &&
    typeof v.request_id === "string" &&
    (v.operation === "plan_and_apply" || v.operation === "dry_run" || v.operation === "ping") &&
    typeof v.request_body === "string" &&
    typeof v.authorization === "object" &&
    v.authorization !== null
  );
}

/** Narrow an unknown decoded frame to a response (validates the shape the supervisor relies on). */
export function isEngineIpcResponse(value: unknown): value is EngineIpcResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.protocol_version === ENGINE_IPC_PROTOCOL_VERSION &&
    typeof v.request_id === "string" &&
    (v.result === "applied" || v.result === "refused" || v.result === "noop" || v.result === "error") &&
    Array.isArray(v.applied_components) &&
    typeof v.recovery_required === "boolean"
  );
}
