/**
 * Native-engine apply-seam degradation tests.
 *
 * The seam maps a supervisor outcome to a safe-degradation decision.
 * Proven here with a fake supervisor (the real spawn round-trip is in engine-supervisor.test.ts):
 * - a degraded outcome → forward-original (original bytes preserved);
 * - a refused/noop/error engine result → forward-original;
 * - an "applied" result with a real changed body + recovery_required → apply (transport body out);
 * - an "applied" result missing a body / unchanged / without recovery_required → forward-original;
 * - the seam never throws.
 */
import { describe, expect, it } from "vitest";
import { decideEngineApply } from "../../../src/core/gateway/engine-ipc/engine-apply-seam.js";
import type { EngineRequestInput, EngineSupervisor, EngineSupervisorOutcome } from "../../../src/core/gateway/engine-ipc/supervisor.js";

function fakeSupervisor(outcome: EngineSupervisorOutcome): EngineSupervisor {
  return { request: async () => outcome } as unknown as EngineSupervisor;
}

const input: EngineRequestInput = {
  operation: "plan_and_apply",
  workflow: "claude-code",
  provider: "anthropic",
  route_type: "api-key",
  request_body: "ORIGINAL",
  authorization: { policy_id: "p", scope_hash: "h" },
  entitlement: { token: "" },
  quota: { period_id: "2026-07", locally_allocated_tokens_remaining: 100 }
};

describe("engine apply seam degradation", () => {
  it("degraded → forward-original", async () => {
    const d = await decideEngineApply(fakeSupervisor({ status: "degraded", reason: "engine-absent" }), input);
    expect(d.decision).toBe("forward-original");
    if (d.decision === "forward-original") expect(d.reason).toBe("engine-degraded:engine-absent");
  });

  it("engine noop/refused/error → forward-original", async () => {
    for (const result of ["noop", "refused", "error"] as const) {
      const d = await decideEngineApply(
        fakeSupervisor({
          status: "response",
          response: { protocol_version: 1, request_id: "x", result, applied_components: [], recovery_required: false }
        }),
        input
      );
      expect(d.decision).toBe("forward-original");
    }
  });

  it("applied with a real changed body + recovery_required → apply", async () => {
    const d = await decideEngineApply(
      fakeSupervisor({
        status: "response",
        response: {
          protocol_version: 1,
          request_id: "x",
          result: "applied",
          mutated_request_body: "COMPACTED",
          recovery_required: true,
          applied_components: ["input-compaction"]
        }
      }),
      input
    );
    expect(d.decision).toBe("apply");
    if (d.decision === "apply") {
      expect(d.mutatedRequestBody).toBe("COMPACTED");
      expect(d.recoveryRequired).toBe(true);
      expect(d.appliedComponents).toEqual(["input-compaction"]);
    }
  });

  it("applied but unchanged/absent body or missing recovery_required → forward-original", async () => {
    const cases: EngineSupervisorOutcome[] = [
      { status: "response", response: { protocol_version: 1, request_id: "x", result: "applied", recovery_required: true, applied_components: [] } },
      { status: "response", response: { protocol_version: 1, request_id: "x", result: "applied", mutated_request_body: "ORIGINAL", recovery_required: true, applied_components: [] } },
      { status: "response", response: { protocol_version: 1, request_id: "x", result: "applied", mutated_request_body: "COMPACTED", recovery_required: false, applied_components: [] } }
    ];
    for (const outcome of cases) {
      const d = await decideEngineApply(fakeSupervisor(outcome), input);
      expect(d.decision).toBe("forward-original");
    }
  });

  it("a noop that says why LCM did not contribute carries that fact out; a bare noop carries none", async () => {
    const lcm_outcome = { kind: "unavailable", reason: "prefix-exceeds-local-context" };
    const withOutcome = await decideEngineApply(
      fakeSupervisor({
        status: "response",
        response: { protocol_version: 1, request_id: "x", result: "noop", applied_components: [], recovery_required: false, lcm_outcome }
      }),
      input
    );
    expect(withOutcome).toEqual({ decision: "forward-original", reason: "engine-result:noop", lcmOutcome: lcm_outcome });

    // An older engine omits the field: unknown, and no key is invented for it.
    const bare = await decideEngineApply(
      fakeSupervisor({
        status: "response",
        response: { protocol_version: 1, request_id: "x", result: "noop", applied_components: [], recovery_required: false }
      }),
      input
    );
    expect(bare).toEqual({ decision: "forward-original", reason: "engine-result:noop" });
  });

  it.each(["already-active", "absent"] as const)("carries no-op output provenance %s", async (output_shaping_state) => {
    const decision = await decideEngineApply(
      fakeSupervisor({
        status: "response",
        response: {
          protocol_version: 1,
          request_id: "x",
          result: "noop",
          applied_components: [],
          recovery_required: false,
          output_shaping_state
        }
      }),
      input
    );
    expect(decision).toEqual({
      decision: "forward-original",
      reason: "engine-result:noop",
      outputShapingState: output_shaping_state
    });
  });
});
