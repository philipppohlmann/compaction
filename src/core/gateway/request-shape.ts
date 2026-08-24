/**
 * Gateway request-shape contract + validator (PUBLIC; pure, no I/O, never mutates).
 *
 * This is the public half of the gateway's deterministic apply surface. It carries:
 *   - the policy LABEL (`DEDUPE_POLICY`) that receipts, activation records, and stored
 *     authorizations compare against;
 *   - the `DedupePlan` DATA CONTRACT that receipts and activity records are built from;
 *   - the local-estimate token convention (`estimateTokens`, chars/4, never provider-reported);
 *   - `classifyRequestShape`, the pure VALIDATOR that decides whether a request body is one of the
 *     three shapes the gateway understands, and returns the validated pieces of it.
 *
 * The validator FAILS CLOSED on anything it does not explicitly understand: non-JSON bodies, unknown
 * endpoints, tool/function/structured-output requests, multimodal or block-array content, unknown
 * roles, and missing safe fields. Anthropic's top-level `system` prompt is never a validated field —
 * it is simply never a candidate for anything.
 *
 * Two consumers need exactly this and nothing more:
 *   - PUBLIC output shaping, which needs the shape verdict before attaching a pre-generation
 *     instruction and never touches user-turn text;
 *   - the deterministic input-compaction policy (`apply-policy.ts`), which consumes the validated
 *     shape and is the only thing that mutates model-visible input.
 *
 * Supported shapes:
 *   - OpenAI Responses API    (`/v1/responses`)        , string `input`.
 *   - OpenAI Chat Completions (`/v1/chat/completions`) , `messages[]` with string content.
 *   - Anthropic Messages      (`/v1/messages`)         , `messages[]` with string content; the
 *     top-level `system` prompt is never inspected, block-array/tool content fails closed.
 *
 * `classifyAnthropicApplyShape` is a SECOND, apply-only validator for Anthropic `/v1/messages`. It
 * exists because every real Claude Code and Codex request carries `tools` AND block-array content, so
 * `classifyRequestShape` refuses all of them and full apply is unreachable on real traffic. It accepts
 * that shape WITHOUT ever inspecting it: `tools`, `tool_choice`, `system` and every non-text content
 * block (tool_use, tool_result, image, thinking, ...) are OPAQUE - never read, never addressed, never
 * mutated. It returns only PATH-ADDRESSED plain-text segments, so a caller can rewrite exactly those
 * strings and leave the rest of the body byte-identical. It fails closed on any block it cannot name.
 * `classifyRequestShape` is deliberately left untouched: output shaping, the task classifier and the
 * seam's absent-plan reporting keep the narrow boundary they were written against.
 */

/** The only deterministic apply policy implemented. */
export const DEDUPE_POLICY = "deterministic-dedupe";
export type ApplyPolicyName = typeof DEDUPE_POLICY;

/** Chat roles we recognize. An unrecognized role → fail closed (role/order semantics uncertain). */
const KNOWN_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
/**
 * The only roles Anthropic `/v1/messages` uses inside `messages[]` (system is a SEPARATE top-level
 * field, never a message role). An unrecognized role → fail closed.
 */
const ANTHROPIC_ROLES = new Set(["user", "assistant"]);
/**
 * Roles the APPLY-ONLY Anthropic validator recognizes. Real Claude Code traffic does send a `system`
 * role inside `messages[]` (observed on live `/v1/messages` bodies) even though the top-level `system`
 * field is the documented home. Recognizing it only means the request is not refused; system-role text
 * is still never a mutation candidate (see `DEDUPE_ROLES` in the policy).
 */
const ANTHROPIC_APPLY_ROLES = new Set(["user", "assistant", "system"]);
/** Presence of any of these top-level fields makes the request a more complex shape → fail closed. */
const COMPLEX_FIELDS = ["tools", "functions", "tool_choice", "function_call", "response_format"];
/**
 * Anthropic `/v1/messages` complex/never-touch top-level fields. `tools`/`tool_choice` are the
 * Anthropic tool schema (shared with COMPLEX_FIELDS); `system` is Anthropic's top-level system
 * prompt, which is never inspected and whose mere PRESENCE never blocks. Listed for clarity.
 */
const ANTHROPIC_COMPLEX_FIELDS = ["tools", "tool_choice"];

export type RequestShape = "responses-string" | "chat-messages" | "anthropic-messages" | "unsupported";

/**
 * The plan contract produced over a validated shape. PUBLIC because receipts, activity records, and
 * the optimization planner are all built from it; the ALGORITHM that fills it in is not public.
 */
export interface DedupePlan {
  policy: ApplyPolicyName;
  shape: RequestShape;
  /** The shape is one we handle. */
  supported: boolean;
  /** A safe mutation was actually produced (duplicates removed). Only then is `mutatedBody` set. */
  changed: boolean;
  /** Why we will NOT apply (present whenever `supported` is false, or parsing failed). */
  failClosedReason?: string;
  /** Serialized JSON of the mutated request, present ONLY when `changed` is true. */
  mutatedBody?: string;
  /** How many exact-duplicate large blocks were removed. */
  removedBlocks: number;
  /**
   * The TRANSPORT basis (chars): how many bytes the forwarded request shrank by. For the OpenAI shapes
   * it is the safe text fields, which on those shapes are essentially the whole request. For the
   * Anthropic apply path it is the WHOLE canonical serialized request - canonical on both sides, so a
   * pretty-printed client cannot book its own indentation as a saving.
   *
   * REPORTED, never claimed as a model-visible quantity. Neither `estTokens*` nor `reductionPercent`
   * derives from these numbers - see below.
   */
  charsBefore: number;
  charsAfter: number;
  /**
   * LOCAL-ESTIMATE token counts (chars/4), never provider-reported, never a billing figure on their
   * own - but this is the number the meter is built from (`optimized-input-v1`, frozen to pre-mutation
   * MODEL-VISIBLE input tokens), so it is measured on the PROMPT basis: model-visible text only. On the
   * OpenAI shapes that is the same text `charsBefore` counts. On the Anthropic apply path it is NOT:
   * `charsBefore` there is the whole envelope, and metering it would spend a user's allowance on JSON
   * punctuation and transport-only fields (`max_tokens`, `stream`, `metadata`).
   */
  estTokensBefore: number;
  estTokensAfter: number;
  /**
   * Estimated model-visible input reduction percent (0 when nothing changed). Taken over the SAME
   * prompt basis as `estTokens*`, because the receipt publishes it as
   * `estimated_model_visible_input_reduction_percent` and prints it beside those token counts - a
   * percentage over the transport basis would be a different quantity under that name.
   */
  reductionPercent: number;
}

/** chars/4, the repo's local-estimate token convention. NEVER provider-reported. */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** endpoint family from the request path (e.g. `/v1/responses`, `/responses`, `/v1/messages`). */
export function endpointFamily(endpoint: string): "responses" | "chat" | "anthropic" | "other" {
  const p = endpoint.split("?")[0];
  if (p.endsWith("/responses")) return "responses";
  if (p.endsWith("/chat/completions")) return "chat";
  if (p.endsWith("/messages")) return "anthropic"; // Anthropic /v1/messages
  return "other";
}

/** A message that passed validation: known role, string content. */
export interface ValidatedMessage {
  role: string;
  content: string;
}

/** The validator's verdict. `supported: false` carries the exact fail-closed reason to report. */
export type RequestShapeClassification =
  | { supported: true; shape: "responses-string"; body: Record<string, unknown>; input: string }
  | {
      supported: true;
      shape: "chat-messages" | "anthropic-messages";
      body: Record<string, unknown>;
      messages: ValidatedMessage[];
    }
  | { supported: false; shape: RequestShape; failClosedReason: string };

function unsupported(shape: RequestShape, failClosedReason: string): RequestShapeClassification {
  return { supported: false, shape, failClosedReason };
}

/**
 * Validate one request body against the three shapes the gateway understands. PURE, no I/O, never
 * mutates. Returns the parsed body plus the validated safe fields on success, or the shape label and
 * the exact fail-closed reason on refusal. Callers that cannot act on an unsupported shape forward
 * the ORIGINAL bytes unchanged.
 */
export function classifyRequestShape(endpoint: string, bodyText: string): RequestShapeClassification {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return unsupported("unsupported", "request body is not a JSON object");
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return unsupported("unsupported", "request body is not valid JSON - fail closed (never mutate an unknown shape)");
  }

  const family = endpointFamily(endpoint);
  if (family === "other") {
    return unsupported(
      "unsupported",
      `endpoint '${endpoint}' is not a supported apply shape (only /v1/responses, /v1/chat/completions, and /v1/messages)`
    );
  }

  // The known shape for this family (used both for the fail-closed reasons below and success verdicts).
  const familyShape: RequestShape =
    family === "responses" ? "responses-string" : family === "anthropic" ? "anthropic-messages" : "chat-messages";

  // Any tool/function schema or structured-output field → a more complex shape we deliberately do not
  // touch (never modify tool schemas; fail closed rather than guess). For Anthropic we also fail closed
  // on its `tools`/`tool_choice` (both already present in COMPLEX_FIELDS).
  const complexFields = family === "anthropic" ? ANTHROPIC_COMPLEX_FIELDS : COMPLEX_FIELDS;
  for (const f of complexFields) {
    if (obj[f] !== undefined) {
      return unsupported(
        familyShape,
        `request contains '${f}' (tool/function/structured-output shape) - fail closed (never touch tool schemas)`
      );
    }
  }

  if (family === "responses") {
    const input = obj.input;
    if (typeof input !== "string") {
      return unsupported("unsupported", "responses.input is not a simple string (arrays/multimodal/other shapes fail closed)");
    }
    return { supported: true, shape: "responses-string", body: obj, input };
  }

  const anthropic = family === "anthropic";
  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return unsupported(
      "unsupported",
      anthropic
        ? "anthropic messages is missing or not a non-empty array"
        : "chat.completions.messages is missing or not a non-empty array"
    );
  }
  const shape = anthropic ? "anthropic-messages" : "chat-messages";
  const roles = anthropic ? ANTHROPIC_ROLES : KNOWN_ROLES;
  // Validate EVERY message first: any non-string content (block array/object/null) or unknown role →
  // fail closed. Anthropic's block-array content is its common multimodal / tool_use / tool_result
  // shape; refusing it here is what keeps those requests byte-exact downstream.
  for (const m of messages) {
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      return unsupported(shape, "a message is not an object - fail closed");
    }
    const role = (m as Record<string, unknown>).role;
    const content = (m as Record<string, unknown>).content;
    if (typeof role !== "string" || !roles.has(role)) {
      return unsupported(shape, "a message has an unknown/missing role - fail closed (role/order semantics uncertain)");
    }
    if (typeof content !== "string") {
      return unsupported(
        shape,
        anthropic
          ? "a message has non-string content (block array/multimodal) - fail closed"
          : "a message has non-string content (multimodal/array) - fail closed"
      );
    }
  }

  return { supported: true, shape, body: obj, messages: messages as ValidatedMessage[] };
}

/**
 * One plain-text string inside an Anthropic request that the apply policy is ALLOWED to see, addressed
 * by its path in the parsed body (e.g. `["messages", 3, "content", 1, "text"]`). Everything not named
 * by a segment is opaque: never read, never rewritten.
 */
export interface AnthropicTextSegment {
  /** Role of the message that owns this text. Mutation eligibility is decided by role, not by path. */
  role: string;
  /** Path to the string itself in the parsed body. */
  path: (string | number)[];
  /** The text currently at that path. */
  text: string;
}

/** Verdict of the apply-only Anthropic validator. */
export type AnthropicApplyClassification =
  | { supported: true; shape: "anthropic-messages"; segments: AnthropicTextSegment[] }
  | { supported: false; shape: RequestShape; failClosedReason: string };

function unsupportedApply(reason: string, shape: RequestShape = "anthropic-messages"): AnthropicApplyClassification {
  return { supported: false, shape, failClosedReason: reason };
}

/**
 * Validate an Anthropic `/v1/messages` body for the APPLY path. PURE, no I/O, never mutates.
 *
 * What it accepts that `classifyRequestShape` refuses: `tools`/`tool_choice` (present, never inspected),
 * a list-valued top-level `system` (never inspected), a `system` role inside `messages[]`, and
 * block-array message content. What it returns: the plain-text segments only. A `tool_result` block is
 * OPAQUE - tool output is evidence the model reasons about, and this path never rewrites evidence.
 *
 * It still fails closed on anything it cannot name: a non-object message, an unknown role, content that
 * is neither a string nor an array, a block that is not an object, a block with no string `type`, or a
 * `text` block whose `text` is not a string.
 */
export function classifyAnthropicApplyShape(endpoint: string, bodyText: string): AnthropicApplyClassification {
  if (endpointFamily(endpoint) !== "anthropic") {
    return unsupportedApply(`endpoint '${endpoint}' is not Anthropic /v1/messages`, "unsupported");
  }

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return unsupportedApply("request body is not a JSON object", "unsupported");
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return unsupportedApply("request body is not valid JSON - fail closed (never mutate an unknown shape)", "unsupported");
  }

  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    // Same shape label and same reason as the sibling validator: nothing identifies this as an
    // Anthropic-shaped request once `messages` is gone.
    return unsupportedApply("anthropic messages is missing or not a non-empty array", "unsupported");
  }

  const segments: AnthropicTextSegment[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      return unsupportedApply("a message is not an object - fail closed");
    }
    const role = (m as Record<string, unknown>).role;
    if (typeof role !== "string" || !ANTHROPIC_APPLY_ROLES.has(role)) {
      return unsupportedApply("a message has an unknown/missing role - fail closed (role/order semantics uncertain)");
    }
    const content = (m as Record<string, unknown>).content;
    if (typeof content === "string") {
      segments.push({ role, path: ["messages", i, "content"], text: content });
      continue;
    }
    if (!Array.isArray(content)) {
      return unsupportedApply("a message has content that is neither a string nor a block array - fail closed");
    }
    for (let j = 0; j < content.length; j++) {
      const block = content[j] as unknown;
      if (typeof block !== "object" || block === null || Array.isArray(block)) {
        return unsupportedApply("a content block is not an object - fail closed");
      }
      const type = (block as Record<string, unknown>).type;
      if (typeof type !== "string") {
        return unsupportedApply("a content block has no string 'type' - fail closed");
      }
      // Every non-text block (tool_use, tool_result, image, document, thinking, ...) is OPAQUE: not a
      // segment, so it is never read and never rewritten. Only `text` blocks are ever addressed.
      if (type !== "text") continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text !== "string") {
        return unsupportedApply("a text block has non-string 'text' - fail closed");
      }
      segments.push({ role, path: ["messages", i, "content", j, "text"], text });
    }
  }

  return { supported: true, shape: "anthropic-messages", segments };
}

/**
 * The Anthropic SYSTEM-INSTRUCTION carrier an output-shaping attach may extend, and nothing else.
 * `absent` → no `system` field; `string` → the legacy string form; `blocks` → the block-array form
 * real Claude Code sends. `blockCount` lets the caller append WITHOUT reading any existing block.
 */
export type AnthropicSystemCarrier =
  | { kind: "absent" }
  | { kind: "string"; value: string }
  | { kind: "blocks"; blockCount: number };

/** An Anthropic request whose system instructions can be safely EXTENDED (never rewritten). */
export type AnthropicShapingEnvelope =
  | { supported: true; shape: RequestShape; system: AnthropicSystemCarrier }
  /**
   * `recognized` separates "this is not a request shape we handle at all" (false) from "this IS a
   * well-formed request of this family, but its specific attach point is unusable" (true). The
   * caller reports the latter as a supported-but-unchanged plan, so a receipt distinguishes
   * "shaping does not apply here" from "shaping applies but declined this body".
   */
  | { supported: false; shape: RequestShape; recognized: boolean; failClosedReason: string };

function unsupportedEnvelope(
  reason: string,
  shape: RequestShape = "anthropic-messages",
  recognized = true
): AnthropicShapingEnvelope {
  return { supported: false, shape, recognized, failClosedReason: reason };
}

/**
 * OUTPUT-SHAPING ENVELOPE VALIDATOR (public; ships in the npm package because output shaping is the
 * base capability on every plan, Open included).
 *
 * Same principle as `classifyAnthropicApplyShape`: widen the REFUSAL boundary for a known-safe
 * envelope without widening the MUTATION boundary. It is deliberately WEAKER than its apply sibling
 * because the mutation surface is strictly smaller. Output shaping APPENDS the shaping instruction to
 * the top-level system instructions and rewrites nothing else, so `messages` is never read and never
 * addressed here: `tools`, `tool_choice`, `tool_use`, `tool_result`, images, documents, thinking
 * blocks, and all existing user/assistant content stay opaque and pass through byte-identical via the
 * caller's field-replacement spread. Their PRESENCE therefore cannot make an attach unsafe, which is
 * exactly the over-broad refusal this fixes.
 *
 * What it still fails closed on: a non-Anthropic endpoint, a body that is not a JSON object, a
 * missing/empty `messages` array (nothing identifies the request as Anthropic-shaped), and any
 * `system` carrier that is not absent, a string, or an array of well-formed `{type:"text", text}`
 * blocks. An unknown or malformed shape is never mutated.
 *
 * PROMPT-CACHE SAFETY: the block form reports only a COUNT. The caller appends a new trailing block
 * and leaves every existing block byte-identical, so `cache_control` breakpoints and the cached
 * prefix they mark survive the attach. Editing an existing block would invalidate the user's prompt
 * cache — a real cost regression — so this type makes that inexpressible.
 */
export function classifyAnthropicShapingEnvelope(endpoint: string, bodyText: string): AnthropicShapingEnvelope {
  if (endpointFamily(endpoint) !== "anthropic") {
    return unsupportedEnvelope(`endpoint '${endpoint}' is not Anthropic /v1/messages`, "unsupported", false);
  }

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return unsupportedEnvelope("request body is not a JSON object", "unsupported", false);
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return unsupportedEnvelope("request body is not valid JSON - fail closed (never mutate an unknown shape)", "unsupported", false);
  }

  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return unsupportedEnvelope("anthropic messages is missing or not a non-empty array", "unsupported", false);
  }

  const system = obj.system;
  if (system === undefined) return { supported: true, shape: "anthropic-messages", system: { kind: "absent" } };
  if (typeof system === "string") {
    return { supported: true, shape: "anthropic-messages", system: { kind: "string", value: system } };
  }
  if (!Array.isArray(system)) {
    return unsupportedEnvelope("anthropic system is neither a string nor a block array - fail closed");
  }
  for (const block of system) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      return unsupportedEnvelope("a system block is not an object - fail closed");
    }
    const b = block as Record<string, unknown>;
    if (b.type !== "text" || typeof b.text !== "string") {
      return unsupportedEnvelope("a system block is not a well-formed text block - fail closed");
    }
  }
  return { supported: true, shape: "anthropic-messages", system: { kind: "blocks", blockCount: system.length } };
}

/**
 * What the OPENAI-FAMILY output-shaping attach point looks like on a request we are willing to
 * shape. Same split as the Anthropic sibling: `responses` traffic carries a top-level
 * `instructions` string, `chat` traffic carries a `messages` array we prepend a NEW system
 * message to.
 */
export type OpenAiShapingCarrier =
  | { kind: "responses-instructions"; present: boolean }
  | { kind: "chat-messages"; messageCount: number };

export type OpenAiShapingEnvelope =
  | { supported: true; shape: RequestShape; carrier: OpenAiShapingCarrier }
  /** See `AnthropicShapingEnvelope` for what `recognized` separates. */
  | { supported: false; shape: RequestShape; recognized: boolean; failClosedReason: string };

/**
 * Validate the OpenAI-family (Codex `/v1/responses`, `/v1/chat/completions`) envelope for
 * OUTPUT SHAPING ONLY.
 *
 * Deliberately weaker than `classifyRequestShape`, for exactly the reason the Anthropic sibling
 * is: the mutation surface is strictly smaller. Output shaping adds `instructions` text or
 * inserts one new system message. It never reads or rewrites `tools`, tool calls, tool outputs,
 * images, reasoning blocks, or any existing message content — so the presence of those fields
 * says nothing about whether the attach is safe. Refusing tool-bearing traffic here refused
 * essentially all real coding-agent traffic while protecting nothing.
 *
 * What still fails closed: anything we cannot attach to without guessing — a non-object body,
 * an `instructions` field that is not a string, a `messages` array that is missing/empty or
 * contains a non-object element (which the `{...message}` copy would mangle).
 */
export function classifyOpenAiShapingEnvelope(endpoint: string, bodyText: string): OpenAiShapingEnvelope {
  const family = endpointFamily(endpoint);
  if (family !== "responses" && family !== "chat") {
    return {
      supported: false,
      shape: "unsupported",
      recognized: false,
      failClosedReason: `endpoint '${endpoint}' is not an OpenAI-family endpoint`
    };
  }
  const shape: RequestShape = family === "responses" ? "responses-string" : "chat-messages";
  const unsupported = (reason: string, recognized = true): OpenAiShapingEnvelope => ({
    supported: false,
    shape,
    recognized,
    failClosedReason: reason
  });

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return unsupported("request body is not a JSON object", false);
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return unsupported("request body is not valid JSON - fail closed (never mutate an unknown shape)", false);
  }

  if (family === "responses") {
    const instructions = obj.instructions;
    if (instructions !== undefined && typeof instructions !== "string") {
      return unsupported("responses.instructions is neither absent nor a string - fail closed");
    }
    // A body carrying none of the request-defining fields is not a shape we recognise.
    if (obj.input === undefined && obj.prompt === undefined && obj.messages === undefined && instructions === undefined) {
      return unsupported("responses request carries no input/prompt/messages/instructions - fail closed", false);
    }
    return { supported: true, shape, carrier: { kind: "responses-instructions", present: typeof instructions === "string" } };
  }

  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return unsupported("chat messages is missing or not a non-empty array", false);
  }
  for (const message of messages) {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return unsupported("a chat message is not an object - fail closed");
    }
  }
  return { supported: true, shape, carrier: { kind: "chat-messages", messageCount: messages.length } };
}

/**
 * Normalize a JSON number LITERAL to its exact decimal value as `{negative, digits, exponent}`, where
 * `digits` has no leading or trailing zeros. Two literals normalize identically exactly when they denote
 * the same number, so `1.0` and `1` match while `9007199254740993` and `9007199254740992` do not.
 * `-0` keeps its sign, because that is a distinction JSON preserves and `JSON.stringify` destroys.
 */
function normalizeNumberLiteral(literal: string): string {
  const m = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (m === null) return `raw:${literal}`; // not a literal we can compare exactly → never matches
  const [, sign, intPart, fracPart = "", expPart = "0"] = m;
  const digits = `${intPart}${fracPart}`;
  // Exponent of the LAST digit, then strip padding so 1.0 / 1 / 1e0 / 0.01e2 all agree.
  let exponent = Number(expPart) - fracPart.length;
  let start = 0;
  while (start < digits.length - 1 && digits[start] === "0") start++;
  let end = digits.length;
  while (end > start + 1 && digits[end - 1] === "0") {
    end--;
    exponent++;
  }
  const significant = digits.slice(start, end);
  if (significant === "0") return `${sign}0`; // zero: exponent is meaningless, the SIGN is not
  return `${sign}${significant}e${exponent}`;
}

/**
 * Does every number in this request body survive a `JSON.parse` → `JSON.stringify` round trip with its
 * VALUE intact?
 *
 * The apply path rebuilds the request by reparsing the original bytes and reserializing them. That is
 * safe for strings and structure, but JSON numbers are not JS numbers: `9007199254740993` comes back as
 * `...92`, `-0` comes back as `0`, `1e400` comes back as `null`, and a 20-significant-digit decimal
 * comes back rounded. Those numbers live in TOOL ARGUMENTS we were never asked to touch — an id, an
 * offset, a coordinate — and silently altering one is worse than not optimizing the request at all.
 *
 * So the literals are read out of the ORIGINAL TEXT (a JSON scanner: outside a string, a `-` or a digit
 * can only begin a number) and compared by exact decimal value against what reserialization would emit.
 * Formatting is allowed to change — `1.0` → `1` denotes the same number, and Rust-side clients do emit
 * `1.0` — but the value may not. Any literal that cannot be vouched for makes the whole body ineligible.
 */
export function numbersSurviveReserialization(bodyText: string): boolean {
  for (let i = 0; i < bodyText.length; i++) {
    const ch = bodyText[i];
    if (ch === '"') {
      // Skip the string literal, honouring escapes, so digits inside text are never mistaken for numbers.
      i++;
      while (i < bodyText.length && bodyText[i] !== '"') i += bodyText[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch !== "-" && (ch < "0" || ch > "9")) continue;
    let end = i + 1;
    while (end < bodyText.length && /[-+0-9.eE]/.test(bodyText[end])) end++;
    const literal = bodyText.slice(i, end);
    i = end - 1;
    const value = Number(literal);
    if (!Number.isFinite(value)) return false; // 1e400 → Infinity → reserializes as `null`
    // `-0` is caught here too: it normalizes to "-0" while `String(-0)` normalizes to "0".
    if (normalizeNumberLiteral(literal) !== normalizeNumberLiteral(String(value))) return false;
  }
  return true;
}
