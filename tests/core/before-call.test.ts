import { describe, it, expect } from "vitest";
import {
  analyzeBeforeCall,
  locatePromptArg,
  BEFORE_CALL_POLICY_NAME,
  BEFORE_CALL_EVIDENCE_LABEL,
  MIN_DUPLICATE_BLOCK_CHARS
} from "../../src/core/before-call.js";
import { buildBeforeCallActivityEvent } from "../../src/core/before-call-activity.js";
import { validateActivityEvent } from "../../src/core/activity-event.js";

const BLOCK = "This is a shared context block that is comfortably longer than the duplicate size floor.";
const dupInput = `${BLOCK}\n\nNow do the real task using the block above, concisely.\n\n${BLOCK}`;

describe("analyzeBeforeCall - deterministic duplicate-context-block detection", () => {
  it("flags an exact-duplicate context block and returns a smaller local-estimate + a compacted input", () => {
    const rec = analyzeBeforeCall("codex", dupInput);
    expect(rec.has_avoidable_context).toBe(true);
    expect(rec.policy).toBe(BEFORE_CALL_POLICY_NAME);
    expect(rec.input_tokens_after_estimate).toBeLessThan(rec.input_tokens_before);
    expect(rec.reduction_tokens_estimate).toBe(rec.input_tokens_before - rec.input_tokens_after_estimate);
    expect(rec.blocks_removed).toBe(1);
    // The duplicate block appears ONCE in the compacted input; the unique task text is preserved.
    expect(rec.compacted_input.split(BLOCK).length - 1).toBe(1);
    expect(rec.compacted_input).toContain("Now do the real task");
  });

  it("original is never mutated: compacted_input is a NEW string; the input argument is unchanged", () => {
    const input = dupInput;
    const rec = analyzeBeforeCall("codex", input);
    expect(input).toBe(dupInput); // caller's string is untouched
    expect(rec.compacted_input).not.toBe(input);
  });

  it("no avoidable context → has_avoidable_context:false and compacted_input === original (honest no-op)", () => {
    const clean = "just do one simple task, no repeated blocks anywhere in this prompt at all";
    const rec = analyzeBeforeCall("cursor", clean);
    expect(rec.has_avoidable_context).toBe(false);
    expect(rec.input_tokens_after_estimate).toBe(rec.input_tokens_before);
    expect(rec.reduction_tokens_estimate).toBe(0);
    expect(rec.compacted_input).toBe(clean);
  });

  it("a duplicate SMALLER than the size floor is NOT flagged (conservative)", () => {
    const tiny = "hi\n\ndo x\n\nhi";
    expect(tiny.length).toBeLessThan(MIN_DUPLICATE_BLOCK_CHARS * 3);
    const rec = analyzeBeforeCall("codex", tiny);
    expect(rec.has_avoidable_context).toBe(false);
  });

  it("a single block (no blank-line boundary) is never flagged", () => {
    const rec = analyzeBeforeCall("codex", "one continuous instruction with no blank lines to split on");
    expect(rec.has_avoidable_context).toBe(false);
    expect(rec.blocks_total).toBe(1);
  });

  it("labels are honest: local-estimate, never billing-confirmed / provider-reported / a saving", () => {
    const rec = analyzeBeforeCall("codex", dupInput);
    expect(rec.evidence_label).toBe(BEFORE_CALL_EVIDENCE_LABEL);
    expect(rec.evidence_label).toContain("local-estimate");
    expect(rec.reduction_label).toContain("NOT billing-confirmed");
    expect(rec.reduction_label).toContain("NOT provider-reported");
    expect(rec.reduction_label).toContain("NOT a realized saving");
    expect(rec.reduction_label).not.toMatch(/provider-reported saving|billing-confirmed saving/);
  });
});

describe("locatePromptArg - conservative, fail-closed prompt identification", () => {
  it("codex: the prompt is the last non-flag positional", () => {
    expect(locatePromptArg("codex", ["exec", "--json", "do X"])).toEqual({ index: 2, value: "do X", inline: false });
  });
  it("codex: fail-closed (null) when the last element is a flag or argv is empty", () => {
    expect(locatePromptArg("codex", ["exec", "--json"])).toBeNull();
    expect(locatePromptArg("codex", [])).toBeNull();
  });
  it("cursor: the prompt follows -p / --prompt, incl. the inline = form", () => {
    expect(locatePromptArg("cursor", ["-p", "do X", "--output-format", "json"])).toEqual({ index: 1, value: "do X", inline: false });
    expect(locatePromptArg("cursor", ["--prompt", "do X"])).toEqual({ index: 1, value: "do X", inline: false });
    expect(locatePromptArg("cursor", ["--prompt=do X", "--output-format", "json"])).toEqual({ index: 0, value: "do X", inline: true });
  });
  it("cursor: fail-closed (null) when there is no -p/--prompt flag", () => {
    expect(locatePromptArg("cursor", ["agent", "--output-format", "json"])).toBeNull();
  });
});

describe("buildBeforeCallActivityEvent - content-free, honest, auto-apply OFF", () => {
  it("codex: validates, local-estimate input, output unavailable-with-reason, recommendation-only", () => {
    const rec = analyzeBeforeCall("codex", dupInput);
    const event = buildBeforeCallActivityEvent({ tool: "codex", recommendation: rec, approvalStatus: "not-required" });
    expect(validateActivityEvent(event).problems).toEqual([]);
    expect(event.surface).toBe("codex");
    expect(event.token_source?.input.source).toBe("local-estimate");
    expect(event.token_source?.output.source).toBe("unavailable");
    expect(event.token_source?.output.unavailable_reason).toBeTruthy();
    expect(event.input_before).toBe(rec.input_tokens_before);
    expect(event.input_after).toBe(rec.input_tokens_after_estimate);
    expect(event.policy_used).toBe(BEFORE_CALL_POLICY_NAME);
    expect(event.approval_status).toBe("not-required");
    expect(event.auto_apply?.applied_automatically).toBe(false);
    expect(event.auto_apply?.preference).toBe("ask-each-time");
    expect(event.recovery?.original_retained).toBe(true);
    expect(event.sync_status).toBe("local-only");
    // No prompt text rides on the event (content-free).
    const raw = JSON.stringify(event);
    expect(raw).not.toContain("shared context block");
    expect(raw).not.toContain("Now do the real task");
  });

  it("cursor: input is local-estimate and NEVER provider-reported (tier table)", () => {
    const rec = analyzeBeforeCall("cursor", dupInput);
    const event = buildBeforeCallActivityEvent({ tool: "cursor", recommendation: rec, approvalStatus: "not-required" });
    expect(validateActivityEvent(event).problems).toEqual([]);
    expect(event.surface).toBe("cursor");
    expect(event.token_source?.input.source).toBe("local-estimate");
    expect(event.token_source?.input.source).not.toBe("provider-reported");
  });
});
