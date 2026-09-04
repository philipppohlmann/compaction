import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveOriginalForRecovery, readRecovery, GATEWAY_RECOVERY_DIR } from "../../src/core/gateway/recovery.js";
import { buildApplyReceipt } from "../../src/core/gateway/apply-receipt.js";
import type { ApplyActivation } from "../../src/core/gateway/apply-activation.js";
import type { DedupePlan } from "../../src/core/gateway/request-shape.js";
import type { OpenAiUsageBreakdown } from "../../src/core/gateway/openai-usage.js";

const APPLY_ACT: ApplyActivation = { mode: "apply", requested: true, policy: "deterministic-dedupe", activation: "explicit-mode" };
const DRYRUN_ACT: ApplyActivation = { mode: "dry-run", requested: true, policy: "deterministic-dedupe", activation: "dry-run-mode" };
const CHANGED_PLAN: DedupePlan = {
  policy: "deterministic-dedupe",
  shape: "responses-string",
  supported: true,
  changed: true,
  mutatedBody: JSON.stringify({ input: "x" }),
  removedBlocks: 1,
  charsBefore: 1000,
  charsAfter: 500,
  estTokensBefore: 250,
  estTokensAfter: 125,
  reductionPercent: 50
};
const PROVIDER_USAGE: OpenAiUsageBreakdown = {
  present: true,
  promptInputTokens: 120,
  outputTokens: 20
};
const NO_USAGE: OpenAiUsageBreakdown = { present: false, unavailableReason: "no usage" };

describe("gateway recovery store - retain + recover the original body locally", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-recovery-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("saves the original and reads it back byte-for-byte", () => {
    const original = JSON.stringify({ model: "gpt-x", input: "the exact original body" });
    const id = saveOriginalForRecovery(dir, { endpoint: "/v1/responses", policy: "deterministic-dedupe", originalBody: original });
    expect(typeof id).toBe("string");
    const rec = readRecovery(dir, id);
    expect(rec?.original_body).toBe(original);
    expect(rec?.endpoint).toBe("/v1/responses");
    expect(rec?.policy).toBe("deterministic-dedupe");
  });

  it("writes the recovery file with restrictive 0600 permissions", () => {
    const id = saveOriginalForRecovery(dir, { endpoint: "/v1/responses", policy: "deterministic-dedupe", originalBody: "{}" });
    const file = path.join(dir, GATEWAY_RECOVERY_DIR, `${id}.json`);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns null for a missing recovery id", () => {
    expect(readRecovery(dir, "does-not-exist")).toBeNull();
  });
});

describe("buildApplyReceipt - honest before/after, claim only when mutated", () => {
  it("applied: request_mutated + model_visible_bytes_changed true, local-estimate before/after, apply claim present", () => {
    const r = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/responses",
      upstreamStatus: 200,
      usage: PROVIDER_USAGE,
      activation: APPLY_ACT,
      plan: CHANGED_PLAN,
      applied: true,
      recoveryId: "rec-123"
    });
    expect(r.mode).toBe("apply");
    expect(r.request_mutated).toBe(true);
    expect(r.response_mutated).toBe(false);
    expect(r.model_visible_bytes_changed).toBe(true);
    expect(r.approval_status).toBe("explicit-mode");
    expect(r.estimated_input_tokens_before).toBe(250);
    expect(r.estimated_input_tokens_after).toBe(125);
    expect(r.estimated_model_visible_input_reduction_percent).toBe(50);
    expect(r.token_source_before).toBe("local-estimate");
    expect(r.token_source_after).toBe("local-estimate"); // paired with the chars/4 request estimate above
    expect(r.recovery_id).toBe("rec-123");
    expect(r.apply_label).toMatch(/model-visible input reduced by 50%/i);
    // The receipt `label` must NOT keep the record-mode "byte-for-byte / bytes unchanged" claim once mutated.
    expect(r.label).toMatch(/deterministic-dedupe/i);
    expect(r.label).not.toMatch(/byte-for-byte|bytes unchanged/i);
    // NEVER an output/cost claim.
    expect(JSON.stringify(r)).not.toMatch(/reduced output token|output tokens? reduced|cost saved|saved \$/i);
  });

  it("dry-run: candidate flagged, request NOT mutated, no applied-reduction claim, bytes unchanged", () => {
    const r = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/responses",
      upstreamStatus: 200,
      usage: PROVIDER_USAGE,
      activation: DRYRUN_ACT,
      plan: CHANGED_PLAN,
      applied: false
    });
    expect(r.request_mutated).toBe(false);
    expect(r.model_visible_bytes_changed).toBe(false);
    expect(r.candidate_available).toBe(true);
    expect(r.approval_status).toBe("explicit-dry-run");
    expect(r.apply_label).toMatch(/dry-run.*available/i);
    expect(r.apply_label).not.toMatch(/input reduced by/i); // dry-run never claims an APPLIED reduction
  });

  /** The LCM-only receipt must use the pipeline's end-to-end input basis. */
  it("LCM-only apply: reports the TRUE pre-LCM input as before, not the already-compacted figure", () => {
    const lcmOnlyPlan: DedupePlan = {
      policy: "deterministic-dedupe",
      shape: "messages-array",
      supported: true,
      changed: false, // dedupe found nothing on the body LCM handed it
      removedBlocks: 0,
      charsBefore: 3_600,
      charsAfter: 3_600,
      estTokensBefore: 900, // LCM's output, so it cannot be the end-to-end "before"
      estTokensAfter: 900,
      reductionPercent: 0
    };
    const r = buildApplyReceipt({
      provider: "anthropic",
      endpoint: "/v1/messages",
      upstreamStatus: 200,
      usage: NO_USAGE,
      activation: APPLY_ACT,
      plan: lcmOnlyPlan,
      applied: true,
      appliedComponents: ["lcm-compaction"],
      composedInputEstimate: { before: 1_000, after: 900 },
      recoveryId: "rec-lcm"
    });
    expect(r.estimated_input_tokens_before).toBe(1_000);
    expect(r.estimated_input_tokens_after).toBe(900);
    expect(r.estimated_input_tokens_before).toBeGreaterThan(r.estimated_input_tokens_after!);
    // The percent is derived from the SAME basis, so the receipt cannot state a number its own two
    // figures contradict. The synthetic 1000→900 basis is exactly 10%.
    expect(r.estimated_model_visible_input_reduction_percent).toBe(10);
  });

  it("deterministic-only apply is UNCHANGED by the LCM basis fix (single-layer plan stays the source)", () => {
    const r = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/responses",
      upstreamStatus: 200,
      usage: PROVIDER_USAGE,
      activation: APPLY_ACT,
      plan: CHANGED_PLAN,
      applied: true,
      appliedComponents: ["deterministic-compaction"],
      // Deliberately CONTRADICTORY: a deterministic-only turn must ignore this and read its own plan.
      composedInputEstimate: { before: 999_999, after: 1 }
    });
    expect(r.estimated_input_tokens_before).toBe(250);
    expect(r.estimated_input_tokens_after).toBe(125);
    expect(r.estimated_model_visible_input_reduction_percent).toBe(50);
  });

  it("fail-closed apply: not mutated, reason recorded, no reduction claim, provider usage still parsed-or-unavailable", () => {
    const failReason = "request contains 'tools' - fail closed";
    const r = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/responses",
      upstreamStatus: 200,
      usage: NO_USAGE,
      activation: APPLY_ACT,
      applied: false,
      failClosedReason: failReason
    });
    expect(r.request_mutated).toBe(false);
    expect(r.model_visible_bytes_changed).toBe(false);
    expect(r.fail_closed_reason).toBe(failReason);
    expect(r.approval_status).toBe("not-required"); // nothing applied → nothing approved
    expect(r.apply_label).toMatch(/forwarded unchanged/i);
    expect(r.estimated_model_visible_input_reduction_percent).toBeUndefined(); // no plan → no estimate
    expect(r.token_source).toBe("unavailable"); // provider reported no usage
  });
});
