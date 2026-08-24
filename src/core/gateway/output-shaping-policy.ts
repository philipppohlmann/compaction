/**
 * Gateway request attachment for the existing deterministic output-shaping policy family.
 *
 * This module is pure and engine-free. It only attaches the generic policy block before
 * generation on the three request shapes the deterministic Gateway already accepts. It never
 * computes or claims an output-token delta. Unknown or complex shapes fail closed so the caller
 * can forward the original request unchanged.
 *
 * SHAPING PARITY ACROSS PLANS. The turn-aware hold is PUBLIC: it ships
 * to every plan including account-free Open, so `planPublicBasicOutputShaping` resolves the gate and
 * passes it to `planGatewayOutputShaping`, and the classifier is a plain static import. There is no
 * free/paid split in the shaping method — what stays commercial is FUTURE improvement on it.
 *
 * The gate is still optional to `planGatewayOutputShaping`, and that is the degrade path, not a tier:
 * `taskAwareGate()` honours its env kill switch and returns `undefined`, and an absent or throwing
 * gate means blanket shaping. Turning the gate off costs the hold on planning/reasoning turns; it
 * never fails a request.
 *
 * The request-shape boundary comes from the PUBLIC validator (`request-shape.ts`), not from the
 * input-compaction planner: shaping needs to know whether the request is a shape we understand, and
 * that question is answerable with nothing private present. Tools, multimodal content, unknown roles,
 * and other complex shapes retain exactly the same fail-closed boundary as input compaction because
 * both consult the same validator.
 */
import {
  buildOutputShapingPolicy,
  OUTPUT_SHAPING_POLICY_MARKER,
  type OutputShapingAttribution
} from "../output-shaping.js";
import {
  classifyAnthropicShapingEnvelope,
  classifyOpenAiShapingEnvelope,
  classifyRequestShape,
  numbersSurviveReserialization,
  type AnthropicShapingEnvelope,
  type OpenAiShapingEnvelope
} from "./request-shape.js";
// Static import, not a lazy seam: the turn gate is PUBLIC and ships to every plan, so the
// public planner may depend on it directly. Pure, engine-free, deterministic.
import { taskAwareGate } from "./output-shaping-task-classifier.js";
import type { OutputShapingTaskSignal } from "./task-awareness-seam.js";

export interface GatewayOutputShapingPlan {
  supported: boolean;
  changed: boolean;
  mutatedBody?: string;
  /** Model-visible instruction characters added by this treatment. */
  addedInputCharacters: number;
  applied: OutputShapingAttribution[];
  reason: string;
  /** Task-aware classification signal (content-free) when task-awareness gated this request. */
  taskSignal?: OutputShapingTaskSignal;
}

// The idempotence marker, taken from the ONE constant the builder emits.
// It used to be a hand-copied literal here: changing the builder's header would have silently stopped
// this check from matching, and the failure mode is a double-attached policy block that nothing warns
// about. Importing the constant makes drift impossible rather than merely unlikely.
const marker = OUTPUT_SHAPING_POLICY_MARKER;

function unchanged(reason: string, supported = false, taskSignal?: OutputShapingTaskSignal): GatewayOutputShapingPlan {
  return { supported, changed: false, addedInputCharacters: 0, applied: [], reason, ...(taskSignal ? { taskSignal } : {}) };
}

function endpointFamily(endpoint: string): "responses" | "chat" | "anthropic" | "other" {
  const path = endpoint.split("?")[0];
  if (path.endsWith("/responses")) return "responses";
  if (path.endsWith("/chat/completions")) return "chat";
  if (path.endsWith("/messages")) return "anthropic";
  return "other";
}

/**
 * A task-aware HOLD gate. Returns `hold` (+ a content-free signal) to suppress shaping on a
 * planning/reasoning/extended-thinking turn, or `shape` to proceed. Injected rather than called
 * directly so the caller decides whether this request gets a gate at all, and called defensively:
 * any throw degrades to blanket shaping.
 */
export type OutputShapingTaskGate = (
  endpoint: string,
  bodyText: string
) => { decision: "shape" | "hold"; signal?: OutputShapingTaskSignal };

export interface PlanGatewayOutputShapingOptions {
  /**
   * Task-aware gate. When provided, a `hold` decision suppresses shaping on the planning/reasoning
   * regime. When absent — the env kill switch is set, or the caller is a build without the classifier
   * — shaping is blanket/always-on. Called defensively: any throw degrades to blanket.
   */
  taskGate?: OutputShapingTaskGate;
}

/**
 * The Open `basic` output-shaping plan. Callers
 * on the Open basic route use THIS entry point.
 *
 * It APPLIES THE TURN GATE, and must: every plan gets the same shaping method, and the
 * per-prompt hook path holds planning/reasoning turns. A blanket entry point here would make the
 * Open gateway route shape exactly the regime the gate exists to protect, while the hook held it —
 * a surface split dressed up as a tier.
 */
export function planPublicBasicOutputShaping(endpoint: string, bodyText: string): GatewayOutputShapingPlan {
  return planGatewayOutputShaping(endpoint, bodyText, { taskGate: taskAwareGate() });
}

/**
 * Does this request body ALREADY carry our output-shaping policy block?
 *
 * THE DOUBLE-SHAPING GUARD. The gateway is not the only place shaping can happen: the tool's own
 * `UserPromptSubmit` hook (`subscription-shaping-runtime.ts`) injects the SAME block, and it fires
 * BEFORE the gateway ever sees the request. On a device with hooks installed and gateway routing
 * both active, attaching again would send the model two identical policy blocks — wasteful, and it
 * would make the receipt claim an attachment that added nothing.
 *
 * The test is a substring match on `OUTPUT_SHAPING_POLICY_MARKER`, the exact first line of every
 * block the builder emits. Both directions of error were considered:
 *  - FALSE POSITIVE (a user's own prompt happens to contain that sentence — e.g. asking about this
 *    very feature): the gateway skips shaping for that turn. The cost is one unshaped turn; nothing
 *    is mutated and nothing is claimed. Cheap and self-correcting.
 *  - FALSE NEGATIVE (the block is present but unrecognised): the model receives it twice. More
 *    expensive and invisible to the user.
 * The marker is a full sentence with punctuation, so collisions are rare, and the asymmetry favours
 * skipping. Erring toward "already shaped" is therefore the correct bias.
 */
export function bodyAlreadyCarriesOutputShaping(bodyText: string): boolean {
  return bodyText.includes(OUTPUT_SHAPING_POLICY_MARKER);
}

/**
 * Attach the default deterministic output-shaping block idempotently, behind the shared public
 * request-shape validator (same fail-closed boundary as input compaction, no private dependency).
 *
 * The task-aware HOLD gate is a PRIVATE-ENGINE enhancement passed via `options.taskGate`. When it is
 * absent (the public basic path) shaping is blanket/always-on. It is invoked defensively — if the gate
 * throws, shaping falls back to blanket (the public method), never a hard failure.
 */
export function planGatewayOutputShaping(
  endpoint: string,
  bodyText: string,
  options: PlanGatewayOutputShapingOptions = {}
): GatewayOutputShapingPlan {
  // SHAPE GATE, family-aware. Output shaping APPENDS to the top-level system instructions and
  // rewrites nothing else, so on Anthropic it is gated by the narrow envelope validator rather than
  // by the input-compaction classifier. The compaction classifier fails closed whenever `tools` or a
  // block-array message is present - correct when naming message text to rewrite, over-broad for an
  // append that never reads a message. Deliberately NOT coupled to input-compaction eligibility:
  // "input compaction: NO, output shaping: YES" is a valid state.
  const family = endpointFamily(endpoint);
  let anthropicEnvelope: AnthropicShapingEnvelope | undefined;
  let openAiEnvelope: OpenAiShapingEnvelope | undefined;
  if (family === "anthropic") {
    anthropicEnvelope = classifyAnthropicShapingEnvelope(endpoint, bodyText);
    if (!anthropicEnvelope.supported) {
      return unchanged(anthropicEnvelope.failClosedReason, anthropicEnvelope.recognized);
    }
  } else if (family === "responses" || family === "chat") {
    // Same widening as the Anthropic branch, for the same reason: the OpenAI-family attach is
    // strictly additive (a top-level `instructions` string, or one NEW system message), so
    // tool-bearing and multimodal traffic is safe to shape and must not be refused.
    openAiEnvelope = classifyOpenAiShapingEnvelope(endpoint, bodyText);
    if (!openAiEnvelope.supported) {
      return unchanged(openAiEnvelope.failClosedReason, openAiEnvelope.recognized);
    }
  } else {
    const shape = classifyRequestShape(endpoint, bodyText);
    if (!shape.supported) {
      return unchanged(shape.failClosedReason ?? "request shape is unsupported for output shaping");
    }
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return unchanged("request body is not valid JSON");
  }

  // Attaching the instruction means reserializing the WHOLE body, and JSON numbers are not JS numbers:
  // an integer past 2^53 comes back rounded, `-0` loses its sign, `1e400` comes back as `null`. Those
  // numbers live in tool definitions and tool-call arguments this policy was never asked to touch, and
  // the widened envelope deliberately admits tool-bearing traffic. Shaping is an optimization; silently
  // altering an id or a bound is not a trade worth making, so a body we cannot rebuild exactly is
  // forwarded unshaped. Formatting may still change (`1.0` -> `1` denotes the same number); values may not.
  if (!numbersSurviveReserialization(bodyText)) {
    return unchanged(
      "a number in the request does not survive JSON round-tripping (precision, -0, or non-finite) - fail closed",
      true
    );
  }

  const policy = buildOutputShapingPolicy();
  if (policy.instructions === "" || policy.applied.length === 0) {
    return unchanged("no deterministic output-shaping policies are enabled", true);
  }

  // Task-aware gate (PRIVATE-ENGINE enhancement; injected, never required). Hold shaping on the pure-
  // planning / no-oracle / extended-thinking regime, where prose is plausibly load-bearing. The PUBLIC
  // basic path passes no gate → blanket/always-on shaping. Any gate throw degrades to blanket (fail-open
  // to the public method).
  if (options.taskGate) {
    let held: { decision: "shape" | "hold"; signal?: OutputShapingTaskSignal } | undefined;
    try {
      held = options.taskGate(endpoint, bodyText);
    } catch {
      held = undefined; // enhancement unavailable → blanket public shaping
    }
    if (held?.decision === "hold") {
      // Fixed literal reason (no interpolation of the classifier's free-text) so nothing but the
      // typed signal reaches the persisted content-free receipt. `taskSignal` disambiguates the case.
      return unchanged("task-aware: held shaping on a planning/reasoning or extended-thinking turn", true, held.signal);
    }
  }

  if (family === "responses") {
    if (openAiEnvelope?.supported !== true || openAiEnvelope.carrier.kind !== "responses-instructions") {
      return unchanged("responses shaping carrier was not classified - fail closed", true);
    }
    const existing = body.instructions;
    if (typeof existing === "string" && existing.includes(marker)) {
      return unchanged("output-shaping policy is already attached", true);
    }
    const instructions = typeof existing === "string" && existing.length > 0
      ? `${existing}\n\n${policy.instructions}`
      : policy.instructions;
    return {
      supported: true,
      changed: true,
      mutatedBody: JSON.stringify({ ...body, instructions }),
      addedInputCharacters: policy.instructions.length + (typeof existing === "string" && existing.length > 0 ? 2 : 0),
      applied: policy.applied,
      reason: "attached deterministic pre-generation output shaping to responses.instructions"
    };
  }

  if (family === "anthropic") {
    const carrier = anthropicEnvelope?.supported === true ? anthropicEnvelope.system : undefined;
    if (carrier === undefined) {
      return unchanged("anthropic system carrier was not classified - fail closed", true);
    }

    // BLOCK-ARRAY form (what real Claude Code sends). Append a NEW trailing text block and leave
    // every existing block byte-identical: the `cache_control` breakpoints and the cached prefix
    // they mark are preserved, so the attach never invalidates the user's prompt cache. Existing
    // blocks are neither read for content nor rewritten.
    if (carrier.kind === "blocks") {
      const existingBlocks = body.system as Array<Record<string, unknown>>;
      if (existingBlocks.some((b) => typeof b.text === "string" && b.text.includes(marker))) {
        return unchanged("output-shaping policy is already attached", true);
      }
      const system = [...existingBlocks, { type: "text", text: policy.instructions }];
      return {
        supported: true,
        changed: true,
        mutatedBody: JSON.stringify({ ...body, system }),
        addedInputCharacters: policy.instructions.length,
        applied: policy.applied,
        reason: "attached deterministic pre-generation output shaping to anthropic system instructions"
      };
    }

    const existing = carrier.kind === "string" ? carrier.value : undefined;
    if (typeof existing === "string" && existing.includes(marker)) {
      return unchanged("output-shaping policy is already attached", true);
    }
    const system = typeof existing === "string" && existing.length > 0
      ? `${existing}\n\n${policy.instructions}`
      : policy.instructions;
    return {
      supported: true,
      changed: true,
      mutatedBody: JSON.stringify({ ...body, system }),
      addedInputCharacters: policy.instructions.length + (typeof existing === "string" && existing.length > 0 ? 2 : 0),
      applied: policy.applied,
      reason: "attached deterministic pre-generation output shaping to anthropic system instructions"
    };
  }

  if (family === "chat") {
    if (openAiEnvelope?.supported !== true || openAiEnvelope.carrier.kind !== "chat-messages") {
      return unchanged("chat shaping carrier was not classified - fail closed", true);
    }
    const messages = body.messages as Array<Record<string, unknown>>;
    const alreadyAttached = messages.some(
      (message) =>
        (message.role === "system" || message.role === "developer") &&
        typeof message.content === "string" &&
        message.content.includes(marker)
    );
    if (alreadyAttached) return unchanged("output-shaping policy is already attached", true);

    const next = messages.map((message) => ({ ...message }));
    const insertion = next.findIndex((message) => message.role !== "system" && message.role !== "developer");
    next.splice(insertion < 0 ? next.length : insertion, 0, {
      role: "system",
      content: policy.instructions
    });
    return {
      supported: true,
      changed: true,
      mutatedBody: JSON.stringify({ ...body, messages: next }),
      addedInputCharacters: policy.instructions.length,
      applied: policy.applied,
      reason: "attached deterministic pre-generation output shaping as a chat system instruction"
    };
  }

  return unchanged("endpoint is unsupported for output shaping");
}
