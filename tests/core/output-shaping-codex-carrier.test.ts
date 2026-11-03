import { describe, expect, it } from "vitest";
import { buildHookOutputShapingTreatment, buildOutputShapingPolicy } from "../../src/core/output-shaping.js";
import {
  bodyAlreadyCarriesOutputShaping,
  outputShapingActiveOnRequest,
  outputShapingPolicyVersionOnRequest
} from "../../src/core/gateway/output-shaping-policy.js";

/**
 * CODEX RESPONSES `input[]` — the instruction carrier the 0.6.11 release benchmark showed was missed.
 *
 * Codex delivers its `UserPromptSubmit` hook context as a `developer` message item in the Responses
 * `input[]` array, content-block form `input_text`. The shape below is the one recorded in the
 * benchmark rollout (ON-1). Before the fix the duplicate-policy guard saw it (so nothing was attached
 * twice) while the strict predicate did not, and every hook-shaped Codex turn recorded no shaping.
 * Engine-free on purpose: it runs in the public tree, beside the predicate it covers.
 */
const CORE_POLICY = buildOutputShapingPolicy();
const HOOK_POLICY = buildHookOutputShapingTreatment();
const MARKER = CORE_POLICY.instructions.split("\n")[0];

function codexResponsesBody(items: unknown[]): string {
  return JSON.stringify({ model: "gpt-6-astra", instructions: "You are Codex.", input: items, stream: true });
}
const codexHookItem = { type: "message", role: "developer", content: [{ type: "input_text", text: HOOK_POLICY.instructions }] };
const codexUserItem = { type: "message", role: "user", content: [{ type: "input_text", text: "implement help groups" }] };

describe("outputShapingActiveOnRequest — Codex Responses input[] carrier", () => {
  it("is TRUE for Codex's hook developer message, with the exact hook identity", () => {
    const body = codexResponsesBody([codexUserItem, codexHookItem]);
    expect(outputShapingActiveOnRequest(body)).toBe(true);
    expect(outputShapingPolicyVersionOnRequest(body)).toBe(HOOK_POLICY.policyVersion);
    // The guard and the predicate now agree on this carrier.
    expect(bodyAlreadyCarriesOutputShaping(body)).toBe(true);
  });

  it("is TRUE for a system-role item and for the EasyInputMessage form (no type, string content)", () => {
    expect(outputShapingActiveOnRequest(codexResponsesBody([{ role: "system", content: CORE_POLICY.instructions }]))).toBe(true);
    expect(outputShapingActiveOnRequest(codexResponsesBody([{ role: "developer", content: HOOK_POLICY.instructions }]))).toBe(true);
  });

  it("is FALSE when the payload is only in user or assistant items", () => {
    const user = { type: "message", role: "user", content: [{ type: "input_text", text: HOOK_POLICY.instructions }] };
    const assistant = { type: "message", role: "assistant", content: [{ type: "output_text", text: HOOK_POLICY.instructions }] };
    const body = codexResponsesBody([user, assistant]);
    expect(bodyAlreadyCarriesOutputShaping(body)).toBe(true);
    expect(outputShapingActiveOnRequest(body)).toBe(false);
  });

  it("is FALSE when the payload is only in tool output or a non-message item that claims a developer role", () => {
    const toolOutput = { type: "function_call_output", call_id: "c1", output: HOOK_POLICY.instructions };
    const reasoning = { type: "reasoning", role: "developer", content: [{ type: "input_text", text: HOOK_POLICY.instructions }] };
    const body = codexResponsesBody([codexUserItem, toolOutput, reasoning]);
    expect(bodyAlreadyCarriesOutputShaping(body)).toBe(true);
    expect(outputShapingActiveOnRequest(body)).toBe(false);
  });

  it("is FALSE for a developer item carrying only the marker sentence, or a string `input`", () => {
    const markerOnly = { type: "message", role: "developer", content: [{ type: "input_text", text: MARKER }] };
    expect(outputShapingActiveOnRequest(codexResponsesBody([codexUserItem, markerOnly]))).toBe(false);
    expect(outputShapingActiveOnRequest(JSON.stringify({ model: "m", input: HOOK_POLICY.instructions }))).toBe(false);
  });

  it("stays TRUE across the tool loop of a shaped turn (no new user item)", () => {
    const body = codexResponsesBody([
      codexUserItem,
      codexHookItem,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading the code." }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" }
    ]);
    expect(outputShapingActiveOnRequest(body)).toBe(true);
  });

  it("is FALSE on a later HELD turn that only replays an earlier turn's policy item", () => {
    // Codex persists the hook item in history; the hook held this turn, so it added nothing after
    // the new user message. The replayed item is history, not this turn's instruction.
    const heldTurn = { type: "message", role: "user", content: [{ type: "input_text", text: "now plan the next step" }] };
    const body = codexResponsesBody([
      codexUserItem,
      codexHookItem,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
      heldTurn
    ]);
    expect(bodyAlreadyCarriesOutputShaping(body)).toBe(true);
    expect(outputShapingActiveOnRequest(body)).toBe(false);
  });

  it("skips malformed items without failing open", () => {
    const body = codexResponsesBody([null, 7, "text", { role: "developer" }, codexUserItem]);
    expect(outputShapingActiveOnRequest(body)).toBe(false);
  });
});
