import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/core/gateway/request-shape.js";
import {
  planGatewayOutputShaping,
  planPublicBasicOutputShaping
} from "../../src/core/gateway/output-shaping-policy.js";
import { taskAwareGate } from "../../src/core/gateway/output-shaping-task-classifier.js";
import { attachOutputShapingToCommand } from "../../src/core/output-shaping-attach.js";
import { buildOutputShapingPolicy } from "../../src/core/output-shaping.js";
import { decideShaping, shapingInstructionBlock } from "../../src/core/subscription-shaping-runtime.js";

const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACT = join(REPO_ROOT, "evals", "output-shaping-treatment-census", "benchmark-report-v1.json");
const BENCHMARK_ID = "output-shaping-treatment-input-overhead-reproducibility-v1";

const GATEWAY_CASES = [
  {
    caseId: "anthropic_absent_system",
    carrier: "anthropic_system_string",
    endpoint: "/v1/messages",
    body: { model: "synthetic", messages: [{ role: "user", content: "Implement the function." }] }
  },
  {
    caseId: "anthropic_block_array_system",
    carrier: "anthropic_system_block_array",
    endpoint: "/v1/messages",
    body: {
      model: "synthetic",
      system: [{ type: "text", text: "Synthetic existing instruction." }],
      messages: [{ role: "user", content: "Implement the function." }]
    }
  },
  {
    caseId: "anthropic_string_system",
    carrier: "anthropic_system_string",
    endpoint: "/v1/messages",
    body: {
      model: "synthetic",
      system: "Synthetic existing instruction.",
      messages: [{ role: "user", content: "Implement the function." }]
    }
  },
  {
    caseId: "openai_chat_inserted_system",
    carrier: "openai_chat_system_message",
    endpoint: "/v1/chat/completions",
    body: { model: "synthetic", messages: [{ role: "user", content: "Implement the function." }] }
  },
  {
    caseId: "openai_responses_absent_instructions",
    carrier: "openai_responses_instructions",
    endpoint: "/v1/responses",
    body: { model: "synthetic", input: "Implement the function." }
  },
  {
    caseId: "openai_responses_nonempty_instructions",
    carrier: "openai_responses_instructions",
    endpoint: "/v1/responses",
    body: {
      model: "synthetic",
      instructions: "Synthetic existing instruction.",
      input: "Implement the function."
    }
  }
] as const;

let hookConfigDirectory: string;

beforeAll(() => {
  hookConfigDirectory = mkdtempSync(join(tmpdir(), "compaction-output-treatment-census-"));
});

afterAll(() => {
  rmSync(hookConfigDirectory, { recursive: true, force: true });
});

interface ExactInputMeasurement {
  utf8_bytes: number;
  unicode_code_points: number;
  javascript_string_units: number;
  repository_local_estimate_tokens: number;
}

function measure(value: string): ExactInputMeasurement {
  return {
    utf8_bytes: Buffer.byteLength(value, "utf8"),
    unicode_code_points: [...value].length,
    javascript_string_units: value.length,
    repository_local_estimate_tokens: estimateTokens(value.length)
  };
}

function measureAddedUnits(units: number): ExactInputMeasurement {
  return {
    utf8_bytes: units,
    unicode_code_points: units,
    javascript_string_units: units,
    repository_local_estimate_tokens: estimateTokens(units)
  };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function carrierValue(endpoint: string, bodyText: string): string {
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  if (endpoint.endsWith("/responses")) {
    return typeof body.instructions === "string" ? body.instructions : "";
  }
  if (endpoint.endsWith("/chat/completions")) {
    const messages = body.messages as Array<Record<string, unknown>>;
    return messages
      .filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("");
  }
  const system = body.system;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const text = (block as Record<string, unknown>).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

function gatewayRows() {
  return GATEWAY_CASES.map(({ caseId, carrier, endpoint, body }) => {
    const original = JSON.stringify(body);
    const beforeCarrier = carrierValue(endpoint, original);
    const first = planPublicBasicOutputShaping(endpoint, original);
    if (!first.changed || first.mutatedBody === undefined) {
      throw new Error(`Expected first-pass gateway shaping for ${caseId}`);
    }
    const afterFirstCarrier = carrierValue(endpoint, first.mutatedBody);
    const independentlyDerivedFirstDelta = afterFirstCarrier.slice(beforeCarrier.length);

    const second = planPublicBasicOutputShaping(endpoint, first.mutatedBody);
    const afterSecondBody = second.mutatedBody ?? first.mutatedBody;
    const afterSecondCarrier = carrierValue(endpoint, afterSecondBody);
    const independentlyDerivedSecondDelta = afterSecondCarrier.slice(afterFirstCarrier.length);

    return {
      case_id: caseId,
      native_attach_carrier: carrier,
      first_pass: {
        planner_reported_addedInputCharacters: first.addedInputCharacters,
        independently_derived_carrier_value_delta: measure(independentlyDerivedFirstDelta)
      },
      same_native_carrier_second_pass: {
        planner_reported_addedInputCharacters: second.addedInputCharacters,
        independently_derived_carrier_value_delta: measure(independentlyDerivedSecondDelta)
      }
    };
  });
}

function commandRows() {
  return (["codex", "cursor"] as const).map((surface) => {
    const command = [surface, "exec", "Synthetic task."];
    const first = attachOutputShapingToCommand(command);
    const firstPrompt = first.commandParts[first.commandParts.length - 1];
    const second = attachOutputShapingToCommand(first.commandParts);
    const secondPrompt = second.commandParts[second.commandParts.length - 1];
    return {
      surface,
      first_invocation: measure(firstPrompt.slice(0, firstPrompt.length - command[command.length - 1].length)),
      duplicate_second_invocation: measure(secondPrompt.slice(0, secondPrompt.length - firstPrompt.length))
    };
  });
}

function emittedContext(tool: "claude-code" | "codex" | "cursor", stdout: string): string {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  if (tool === "cursor") {
    const context = parsed.additional_context;
    if (typeof context !== "string") throw new Error("Cursor emitter omitted additional_context");
    return context;
  }
  const hookOutput = parsed.hookSpecificOutput as Record<string, unknown> | undefined;
  const context = hookOutput?.additionalContext;
  if (typeof context !== "string") throw new Error(`${tool} emitter omitted additionalContext`);
  return context;
}

async function hookRows() {
  const env = { COMPACTION_CONFIG_DIR: hookConfigDirectory } as NodeJS.ProcessEnv;
  return Promise.all(
    (["claude-code", "codex", "cursor"] as const).map(async (surface) => {
      const scope = surface === "cursor" ? "session_level" : "per_prompt";
      const shapeableInput = surface === "cursor" ? "{}" : JSON.stringify({ prompt: "Implement the function." });
      const shaped = await decideShaping(surface, shapeableInput, env);
      const emitted = emittedContext(surface, shaped.stdout);

      if (scope === "session_level") {
        return {
          surface,
          emitter_scope: scope,
          shapeable_or_session_start_outcome: shaped.outcome,
          emitted_context: measure(emitted),
          per_prompt_planning_hold: {
            applicability: "not_applicable_to_session_level_emitter",
            emitted_context: null
          }
        };
      }

      const planning = await decideShaping(
        surface,
        JSON.stringify({ prompt: "Design the architecture and weigh the trade-offs." }),
        env
      );
      return {
        surface,
        emitter_scope: scope,
        shapeable_or_session_start_outcome: shaped.outcome,
        emitted_context: measure(emitted),
        per_prompt_planning_hold: {
          applicability: "measured",
          outcome: planning.outcome,
          emitted_context: measure(planning.stdout)
        }
      };
    })
  );
}

function holdRows() {
  const gate = taskAwareGate({});
  const planningBody = JSON.stringify({
    model: "synthetic",
    messages: [{ role: "user", content: "Design the architecture and weigh the trade-offs." }]
  });
  const extendedThinkingBody = JSON.stringify({
    model: "synthetic",
    thinking: { type: "enabled", budget_tokens: 1000 },
    messages: [{ role: "user", content: "Implement the function." }]
  });
  return [
    { case_id: "planning_request", plan: planGatewayOutputShaping("/v1/messages", planningBody, { taskGate: gate }) },
    {
      case_id: "extended_thinking",
      plan: planGatewayOutputShaping("/v1/messages", extendedThinkingBody, { taskGate: gate })
    }
  ].map(({ case_id, plan }) => ({
    case_id,
    changed: plan.changed,
    planner_reported_addedInputCharacters: plan.addedInputCharacters,
    added_input: measureAddedUnits(plan.addedInputCharacters),
    task_signal: plan.taskSignal
  }));
}

async function benchmarkReport() {
  const policy = buildOutputShapingPolicy();
  const gateway = gatewayRows();
  const matrixFirstPasses = gateway.map((row) => row.first_pass.independently_derived_carrier_value_delta);
  return {
    schema_version: 1,
    benchmark_id: BENCHMARK_ID,
    evidence_type: "synthetic_fixture",
    measurement_basis: {
      input_basis: "model_visible_treatment_carrier_values_only",
      utf8_bytes: "Buffer.byteLength(value, utf8)",
      unicode_code_points: "spread_iteration_length",
      javascript_string_units: "value.length",
      repository_local_estimate_tokens: "estimateTokens(javascript_string_units); local estimate only"
    },
    proves: ["deterministic_treatment_input_measurements_for_registered_synthetic_cases_only"],
    does_not_prove: [
      "provider_prompt_construction",
      "provider_token_counts",
      "native_external_hook_application",
      "output_reduction",
      "output_sufficiency",
      "savings",
      "effectiveness",
      "real_trace_prevalence",
      "reducibility",
      "generalization_beyond_registered_synthetic_cases"
    ],
    default_policy: {
      policy_count: policy.applied.length,
      line_count: policy.instructions.split("\n").length,
      policy_version: policy.policyVersion,
      treatment_input: measure(policy.instructions)
    },
    command_attachments: {
      semantics: "each invocation prepends again; duplicate invocation is not idempotent",
      cases: commandRows()
    },
    gateway_native_carriers: {
      idempotence_scope: "same native attach carrier only; cross-surface external application is not measured",
      cases: gateway,
      first_pass_matrix_closure: {
        case_count: gateway.length,
        exact_input: {
          utf8_bytes: matrixFirstPasses.reduce((sum, row) => sum + row.utf8_bytes, 0),
          unicode_code_points: matrixFirstPasses.reduce((sum, row) => sum + row.unicode_code_points, 0),
          javascript_string_units: matrixFirstPasses.reduce((sum, row) => sum + row.javascript_string_units, 0),
          repository_local_estimate_tokens: matrixFirstPasses.reduce(
            (sum, row) => sum + row.repository_local_estimate_tokens,
            0
          )
        },
        interpretation: "matrix closure only"
      }
    },
    task_aware_gateway_holds: holdRows(),
    hook_emitters: {
      shared_instruction_block: measure(shapingInstructionBlock()),
      cases: await hookRows()
    }
  };
}

describe("output shaping treatment input overhead reproducibility benchmark", () => {
  it("reproduces the checked-in synthetic report byte for byte", async () => {
    const report = await benchmarkReport();
    expect(GATEWAY_CASES.map(({ caseId }) => caseId)).toEqual([...GATEWAY_CASES.map(({ caseId }) => caseId)].sort());
    expect(new Set(GATEWAY_CASES.map(({ caseId }) => caseId)).size).toBe(6);
    expect(stableJson(report)).toBe(readFileSync(ARTIFACT, "utf8"));
  });

  it("cross-checks current policy, command, gateway, hold, and hook measurements", async () => {
    const report = await benchmarkReport();
    expect(report.default_policy).toEqual({
      policy_count: 4,
      line_count: 5,
      policy_version: "output-shaping.v1.sha256.a94bd8a0b5b4e93b4e9c9657ad5d35ef85a91708bf082530e81434a80f47e845",
      treatment_input: {
        utf8_bytes: 466,
        unicode_code_points: 466,
        javascript_string_units: 466,
        repository_local_estimate_tokens: 117
      }
    });
    for (const row of report.command_attachments.cases) {
      expect(row.first_invocation).toEqual(measureAddedUnits(468));
      expect(row.duplicate_second_invocation).toEqual(measureAddedUnits(468));
    }
    expect(report.gateway_native_carriers.first_pass_matrix_closure.exact_input).toEqual({
      utf8_bytes: 2800,
      unicode_code_points: 2800,
      javascript_string_units: 2800,
      repository_local_estimate_tokens: 702
    });
    for (const row of report.gateway_native_carriers.cases) {
      expect(row.first_pass.planner_reported_addedInputCharacters).toBe(
        row.first_pass.independently_derived_carrier_value_delta.javascript_string_units
      );
      expect(row.same_native_carrier_second_pass.planner_reported_addedInputCharacters).toBe(0);
      expect(row.same_native_carrier_second_pass.independently_derived_carrier_value_delta).toEqual(measureAddedUnits(0));
    }
    for (const row of report.task_aware_gateway_holds) {
      expect(row.changed).toBe(false);
      expect(row.planner_reported_addedInputCharacters).toBe(0);
      expect(row.added_input).toEqual(measureAddedUnits(0));
    }
    expect(report.hook_emitters.shared_instruction_block).toEqual(measureAddedUnits(466));
    for (const row of report.hook_emitters.cases) {
      expect(row.emitted_context).toEqual(measureAddedUnits(466));
      if (row.emitter_scope === "per_prompt") {
        expect(row.per_prompt_planning_hold).toEqual({
          applicability: "measured",
          outcome: "hold-planning",
          emitted_context: measureAddedUnits(0)
        });
      }
    }
  });

  it("uses one exact policy identity across command, gateway, and hook carriers", async () => {
    const policy = buildOutputShapingPolicy();
    for (const surface of ["codex", "cursor"] as const) {
      const attached = attachOutputShapingToCommand([surface, "exec", "Synthetic task."]);
      expect(attached.policyVersion).toBe(policy.policyVersion);
      expect(attached.commandParts.at(-1)).toBe(`${policy.instructions}\n\nSynthetic task.`);
    }

    for (const { endpoint, body } of GATEWAY_CASES) {
      const plan = planPublicBasicOutputShaping(endpoint, JSON.stringify(body));
      expect(plan.policyVersion).toBe(policy.policyVersion);
      expect(plan.mutatedBody).toBeDefined();
      expect(carrierValue(endpoint, plan.mutatedBody ?? "{}")).toContain(policy.instructions);
    }

    expect(shapingInstructionBlock()).toBe(policy.instructions);
    const env = { COMPACTION_CONFIG_DIR: hookConfigDirectory } as NodeJS.ProcessEnv;
    for (const surface of ["claude-code", "codex", "cursor"] as const) {
      const input = surface === "cursor" ? "{}" : JSON.stringify({ prompt: "Implement the function." });
      const decision = await decideShaping(surface, input, env);
      expect(decision.outcome).toBe("shape");
      expect(emittedContext(surface, decision.stdout)).toBe(shapingInstructionBlock());
    }
  });

  it("uses a closed, content-free field set without request, policy, session, receipt, or path data", async () => {
    const report = await benchmarkReport();
    expect(Object.keys(report)).toEqual([
      "schema_version",
      "benchmark_id",
      "evidence_type",
      "measurement_basis",
      "proves",
      "does_not_prove",
      "default_policy",
      "command_attachments",
      "gateway_native_carriers",
      "task_aware_gateway_holds",
      "hook_emitters"
    ]);
    expect(Object.keys(report.measurement_basis)).toEqual([
      "input_basis",
      "utf8_bytes",
      "unicode_code_points",
      "javascript_string_units",
      "repository_local_estimate_tokens"
    ]);
    expect(Object.keys(report.default_policy)).toEqual([
      "policy_count",
      "line_count",
      "policy_version",
      "treatment_input"
    ]);
    expect(Object.keys(report.command_attachments)).toEqual(["semantics", "cases"]);
    expect(Object.keys(report.gateway_native_carriers)).toEqual([
      "idempotence_scope",
      "cases",
      "first_pass_matrix_closure"
    ]);
    expect(Object.keys(report.hook_emitters)).toEqual(["shared_instruction_block", "cases"]);
    for (const row of report.gateway_native_carriers.cases) {
      expect(Object.keys(row)).toEqual([
        "case_id",
        "native_attach_carrier",
        "first_pass",
        "same_native_carrier_second_pass"
      ]);
    }
    const serialized = stableJson(report);
    expect(serialized).not.toContain(buildOutputShapingPolicy().instructions);
    expect(serialized).not.toContain(shapingInstructionBlock());
    for (const excluded of [
      "Output-shaping policy (apply to your response):",
      "Implement the function.",
      "Synthetic existing instruction.",
      "Design the architecture",
      "session_id",
      "receipt_id",
      "request_path",
      '"endpoint"',
      '"prompt"',
      '"instructions"',
      '"policy_text"',
      '"percentage"'
    ]) {
      expect(serialized).not.toContain(excluded);
    }
  });
});
