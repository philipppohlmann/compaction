/**
 * Task-aware gate for deterministic output shaping (pure, engine-free, content-free).
 *
 * Blanket output shaping is safe where an external signal carries the turn's state across turns -
 * the code artifact plus a test/verifier failure, and on short factual answers. It is NOT
 * established as safe on the pure-planning / no-oracle regime, where the model's own prose is the
 * only state it carries forward. This classifier holds shaping on that regime and shapes the rest.
 *
 * Measured boundary (2026-07-24): shaping the code-output / verifier-in-loop turns preserved task
 * completion at ~55-61% output reduction; the no-oracle multi-step planning regime is untested, so
 * the conservative bias is to HOLD whenever the turn reads as planning/reasoning or the client has
 * explicitly asked the model to reason (extended thinking). Holding never hurts quality; it only
 * forgoes savings on that turn.
 *
 * Content-free: this module reads request bytes locally to decide, and returns ONLY a decision plus
 * a fixed signal label. It never returns, logs, or embeds prompt/response content.
 */

/**
 * The decision/signal CONTRACT lives in the public seam (`task-awareness-seam.ts`) so public output
 * shaping can name the signal it persists without depending on this module. Re-exported here for the
 * callers that already speak in these names.
 */
export type {
  OutputShapingTaskClassification,
  OutputShapingTaskDecision,
  OutputShapingTaskSignal
} from "./task-awareness-seam.js";

import type {
  OutputShapingTaskClassification,
  OutputShapingTaskSignal
} from "./task-awareness-seam.js";

/** Env override: set to "0"/"false" to fall back to blanket shaping (task-awareness disabled). */
export const OUTPUT_SHAPING_TASK_AWARE_ENV = "COMPACTION_OUTPUT_SHAPING_TASK_AWARE";

/**
 * The turn reads as planning / reasoning / explanation, where prose is plausibly load-bearing or
 * the user explicitly wants it. Deliberately generous: over-holding forgoes savings but never hurts
 * quality, while under-holding (shaping a planning turn) is the untested-risky direction.
 */
// `plan`/`design` are required to sit in a planning context (an article/pronoun/planning-object
// follows) so passing mentions on code turns, "my plan is to implement", "the design pattern" -
// still shape, while genuine phrasings ("design the architecture", "plan out the rollout") hold.
// The remaining alternatives are strong standalone planning/reasoning signals. Bias stays over-hold.
const PLANNING_REQUEST =
  /\b(?:(?:plan(?:ning)?|design(?:ing)?)\s+(?:the|a|an|out|for|this|that|how|my|our|your|me|us|it|approach|architecture|strateg\w*|system|solution|migration|rollout|structure|schema)|architect|brainstorm|outline|strateg\w*|trade[- ]?offs?|pros and cons|weigh(?:ing)?|compare (?:the )?(?:approach|option|design)|explain|reason(?:ing)? through|think (?:through|step by step)|step[- ]by[- ]step|walk me through|talk me through|why (?:do|does|would|should|is|are|did)|should i\b|what(?:'s| is) the best way|how (?:would|should) (?:you|we|i)|help me (?:decide|understand|figure)|figure out)\b/i;

/**
 * Does this request OPT IN, per turn, to extended reasoning?
 *
 * "Per turn" is the whole point, and the reason two adjacent-looking fields are deliberately NOT
 * treated as extended thinking:
 *
 *   - `thinking: { type: "adaptive" }` - Claude Code's session default. Measured across a real
 *     10-turn session it was identical on every turn, from "reply OK" to a multi-file edit: the
 *     model decides per turn whether to think, the request does not. It is a capability flag, not
 *     a task signal.
 *   - `output_config.effort` - likewise a session-level setting, constant across that same
 *     session.
 *
 * Holding on either would suppress shaping on ~100% of real Claude Code traffic, which is the
 * same "refuses everything" failure this module's gate exists to avoid - just relocated. The
 * per-turn task signal is the planning-request classifier below, which does vary by turn.
 *
 * `thinking: { type: "enabled" }` IS a genuine per-turn opt-in (the caller sets it with a budget),
 * so it still holds.
 */
function isExtendedThinkingEnabled(body: Record<string, unknown>): boolean {
  // Anthropic: { thinking: { type: "enabled", ... } }. NOT "adaptive" - see above.
  const thinking = body.thinking;
  if (thinking && typeof thinking === "object" && (thinking as Record<string, unknown>).type === "enabled") {
    return true;
  }
  // OpenAI responses/chat reasoning effort.
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object") {
    const effort = (reasoning as Record<string, unknown>).effort;
    if (effort === "high" || effort === "medium") return true;
  }
  const effort = body.reasoning_effort;
  if (effort === "high" || effort === "medium") return true;
  return false;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  // Block-array content (e.g. Anthropic content parts). Defensive only: on the apply path
  // planDeterministicDedupe fails closed on non-string message content before this runs, so this
  // branch is unreachable there; it joins `text` sub-fields (never other keys) and leaks nothing.
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
          ? ((part as Record<string, unknown>).text as string)
          : ""
      )
      .join(" ");
  }
  return "";
}

/** Extract the latest user-turn text across the three accepted request shapes (best-effort). */
function latestUserText(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as Record<string, unknown>;
      if (m && m.role === "user") return textOf(m.content);
    }
    return "";
  }
  // OpenAI responses: `input` may be a string or an array of turns.
  const input = body.input;
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    for (let i = input.length - 1; i >= 0; i--) {
      const t = input[i] as Record<string, unknown>;
      if (t && (t.role === "user" || t.role === undefined)) return textOf(t.content ?? t);
    }
  }
  return "";
}

/**
 * Decide whether this request's turn should receive output shaping. Fail-safe: if the body cannot
 * be parsed or no user turn is found, default to shapeable (the plan function has already validated
 * the request shape upstream; an unreadable turn carries no planning signal to hold on).
 */
export function classifyOutputShapingTask(
  _endpoint: string,
  bodyText: string
): OutputShapingTaskClassification {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return { decision: "shape", signal: "default-shapeable", reason: "request body is not valid JSON; no planning signal to hold on" };
  }

  if (isExtendedThinkingEnabled(body)) {
    return {
      decision: "hold",
      signal: "extended-thinking",
      reason: "extended thinking / high reasoning effort is enabled - the client asked the model to reason; do not suppress it"
    };
  }

  const userText = latestUserText(body);
  if (userText && PLANNING_REQUEST.test(userText)) {
    return {
      decision: "hold",
      signal: "planning-request",
      reason: "latest turn reads as planning/reasoning/explanation - prose is plausibly load-bearing (untested regime); hold shaping"
    };
  }

  return {
    decision: "shape",
    signal: "default-shapeable",
    reason: "code-output / answer / verifier-in-loop turn - shaping is measured-safe here"
  };
}

/** Whether task-aware gating is engaged (default on; env can disable to fall back to blanket shaping). */
export function isOutputShapingTaskAware(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[OUTPUT_SHAPING_TASK_AWARE_ENV];
  if (v === undefined) return true;
  const s = v.trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "off" || s === "no");
}

/**
 * Build the task-aware HOLD gate to inject into `planGatewayOutputShaping({ taskGate })` — the private-
 * engine enhancement over the public blanket method. Returns `undefined` when task-awareness is disabled
 * (env kill switch) so the gateway plan degrades to blanket shaping. This is the ONLY seam through which
 * the private classifier reaches the gateway shaping plan; the public basic path passes no gate and
 * never imports this.
 */
export function taskAwareGate(
  env: NodeJS.ProcessEnv = process.env
): ((endpoint: string, bodyText: string) => { decision: "shape" | "hold"; signal?: OutputShapingTaskSignal }) | undefined {
  if (!isOutputShapingTaskAware(env)) return undefined;
  return (endpoint: string, bodyText: string) => {
    const task = classifyOutputShapingTask(endpoint, bodyText);
    return { decision: task.decision, signal: task.signal };
  };
}
