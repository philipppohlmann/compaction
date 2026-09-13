import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStatusLine, STATUS_LINE_PLACEHOLDER } from "../../src/cli/commands/statusline.js";
// ONE definition of the rule, never a second copy. `init.ts` is the only import site that exists on
// this branch's base; PR #993 moves the function to `src/cli/commands/full-apply-gate.ts` and keeps
// `init.ts` re-exporting it, so this line keeps working across that merge and should then be pointed
// at the new module. It is imported to ASSERT THE FIXTURE, not because the status line consults it -
// the line's own predicate is receipt evidence, which is strictly stronger.
import { pendingFullApplyGate } from "../../src/cli/commands/init.js";
import { FULL_APPLY_PENDING_REASONS } from "../../src/cli/onboarding/model.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { sessionCorrelationId } from "../../src/core/gateway/session-correlation.js";

/**
 * A NON-APPLY RECEIPT ON A FULL-TIER DEVICE MUST NOT RENDER `apply off` — AND MUST NOT RENDER
 * `full apply` EITHER.
 *
 * `full apply` is reserved for a real apply receipt (a real input before→after). `apply off` is the
 * Open OBSERVE posture, the user's choice of no model-visible mutation. Record-mode receipts interleave
 * with the apply receipts of one user task and land in the same `receipts.jsonl` the status line tails,
 * so the status line used to fall to the OPEN builder with a hardcoded `"observe"` and announce
 * `apply off` mid-task on a paid full-tier device. The honest fallback carries the turn's counts and
 * NO posture label: the device's posture across a whole task is a run-level statement, not a per-call one.
 *
 * The synthetic sequence below exercises apply → interleaved record → apply. It reproduces the
 * state transition that previously rendered `full apply → apply off → full apply`.
 */

/** The shared receipt shape; overridden per frame below. */
function receipt(overrides: Partial<GatewayReceipt> = {}): GatewayReceipt {
  return {
    receipt_id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    captured_at: "2030-01-01T10:00:00.000Z",
    provider: "anthropic",
    model: "claude-opus-5",
    endpoint: "/v1/messages",
    mode: "record",
    upstream_status: 200,
    model_visible_bytes_changed: false,
    tokens: { prompt_input: 2_000, output: 200 },
    fresh_billed_input_reduction: { available: false, note: "x" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "x" },
    claim_scope: "run-scoped",
    approval_status: "not-required",
    sync_status: "local-only",
    content_uploaded: false,
    label: "x",
    ...overrides
  };
}

/** A synthetic LCM apply frame. */
function applyFrame(): GatewayReceipt {
  return receipt({
    receipt_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    model: "claude-opus-5",
    mode: "apply",
    request_mutated: true,
    model_visible_bytes_changed: true,
    tokens: { prompt_input: 1_250, output: 300 },
    estimated_input_tokens_before: 1_200,
    estimated_input_tokens_after: 900,
    token_source_before: "local-estimate",
    approval_status: "auto-applied-by-policy",
    authorization_id: "pref-1234567890abcdef12345678",
    applied_components: ["lcm-compaction"]
  });
}

/** A synthetic interleaved record-mode receipt: nothing mutated, no apply axis. */
function interleavedRecordFrame(): GatewayReceipt {
  return receipt({
    receipt_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    model: "claude-sonnet-5",
    mode: "record",
    tokens: { prompt_input: 600, output: 10 }
  });
}

const LEGACY_STDIN = '{"cwd":"/some/proj"}';
const NEW_SESSION_STDIN = '{"cwd":"/some/proj","session_id":"11111111-2222-3333-4444-555555555555"}';

describe("statusline posture on a full-tier device", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function communityDevice(): NodeJS.ProcessEnv {
    const dir = mkdtempSync(join(tmpdir(), "statusline-posture-"));
    dirs.push(dir);
    return provisionValidLease(dir, {}, { productMode: "full" }) as NodeJS.ProcessEnv;
  }

  async function render(frame: GatewayReceipt, env: NodeJS.ProcessEnv): Promise<string> {
    return (await computeStatusLine(LEGACY_STDIN, { readReceipt: async () => frame, env })) ?? "";
  }

  // --- Property assertions (the contract) -------------------------------------------------------

  it("never renders `apply off` on any frame of apply → record → apply", async () => {
    const env = communityDevice();
    for (const frame of [applyFrame(), interleavedRecordFrame(), applyFrame()]) {
      expect(await render(frame, env)).not.toContain("apply off");
    }
  });

  it("renders `full apply` on the apply frames only, and no posture label on the record frame", async () => {
    const env = communityDevice();
    expect(await render(applyFrame(), env)).toContain("full apply");
    const record = await render(interleavedRecordFrame(), env);
    expect(record).not.toContain("full apply");
    expect(record).not.toContain("apply off");
    expect(record).not.toContain("basic shaping");
    expect(await render(applyFrame(), env)).toContain("full apply");
  });

  it("renders the record frame with a plain input count and NO apply axis", async () => {
    const line = await render(interleavedRecordFrame(), communityDevice());
    expect(line).toContain("input 600");
    expect(line).toContain("output 10");
    // NO fabricated saving: no before→after arrow, no percentage, no cost clause on a turn that applied nothing.
    expect(line).not.toMatch(/input [\d,]+→/);
    expect(line).not.toMatch(/−\d+%/);
    expect(line).not.toContain("$");
    // And it is not silently relabelled as the Open observe posture.
    expect(line).not.toContain("observed input");
  });

  it("still renders the real apply axis on the apply frame", async () => {
    const line = await render(applyFrame(), communityDevice());
    expect(line).toContain("1,200→900");
  });

  it("keeps a deterministic-only input reduction visible without calling it private Full", async () => {
    const deterministic = { ...applyFrame(), applied_components: ["deterministic-compaction"] };
    const line = await render(deterministic, communityDevice());
    expect(line).toContain("1,200→900");
    expect(line).not.toContain("full apply");
  });

  // --- The line may not announce a posture the gateway's own gate would refuse ------------------

  it("is rendered on a device the full-apply gate REFUSES (the `compaction mode full` state)", async () => {
    // `compaction mode full` writes `product_mode` only. The routing guard reads `optimization_mode`,
    // which nothing on that path writes, so this device reads as full TIER while every routed turn
    // stays record-only. `pendingFullApplyGate` is the predicate that answers the question the
    // gateway will answer; this asserts the fixture really is in the refused state, so the assertion
    // below is about the status line and not about a device that happens to pass.
    expect(await pendingFullApplyGate(["claude-code"], communityDevice())).toBe(
      FULL_APPLY_PENDING_REASONS.optimizationMode
    );
  });

  it("announces no apply posture at all on a record turn from that device", async () => {
    // The property, alone: whatever tier the device reports, `full apply` rides RECEIPT EVIDENCE of a
    // real apply - never `product_mode`. A weaker predicate here would announce full apply to exactly
    // the users the gate refuses.
    const line = await render(interleavedRecordFrame(), communityDevice());
    expect(line).not.toContain("full apply");
    expect(line).not.toContain("apply off");
    expect(line).not.toContain("basic shaping");
  });

  // --- Literal-line pins (kept apart from the properties above so a pin failure cannot mask them) --

  it("pins the record frame's exact line", async () => {
    const line = await render(interleavedRecordFrame(), communityDevice());
    expect(line).toBe("compaction · input 600 · output 10 · id bbbbbbbb");
  });

  it("pins the apply frame's exact line", async () => {
    const line = await render(applyFrame(), communityDevice());
    expect(line).toBe("compaction · input 1,200→900 (−25%) · output 300 · full apply · id aaaaaaaa");
  });

  it("does not borrow a prior session's receipt before this session has a run boundary", async () => {
    const env = communityDevice();
    const foreignCorrelation = sessionCorrelationId("99999999-8888-7777-6666-555555555555", env)!;
    const line = await computeStatusLine(NEW_SESSION_STDIN, {
      readReceipt: async () => ({ ...applyFrame(), session_correlation_id: foreignCorrelation }),
      env
    });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
    expect(line).not.toContain("aaaaaaaa");
    expect(line).not.toContain("full apply");
  });

  it("does not borrow an uncorrelated legacy private-LCM receipt for named-session stdin", async () => {
    const line = await computeStatusLine(NEW_SESSION_STDIN, {
      readReceipt: async () => applyFrame(),
      env: communityDevice()
    });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
    expect(line).not.toContain("aaaaaaaa");
    expect(line).not.toContain("full apply");
  });

  it("fails closed when a named session cannot derive its keyed correlation", async () => {
    const root = mkdtempSync(join(tmpdir(), "statusline-unusable-config-"));
    dirs.push(root);
    const unusableConfigPath = join(root, "not-a-directory");
    writeFileSync(unusableConfigPath, "regular file", "utf8");
    const line = await computeStatusLine(NEW_SESSION_STDIN, {
      readReceipt: async () => applyFrame(),
      env: { COMPACTION_CONFIG_DIR: unusableConfigPath }
    });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
    expect(line).not.toContain("aaaaaaaa");
    expect(line).not.toContain("full apply");
  });
});
