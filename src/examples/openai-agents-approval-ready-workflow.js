#!/usr/bin/env node

const generatedAt = "2026-01-02T00:00:00.000Z";
const traceId = "trace_level2_approval_ready_demo";

const repeatedInventorySnapshot = Array.from({ length: 28 }, (_, index) => {
  const line = index + 1;
  return `SAFE_LOCAL_DEMO_SOURCE inventory-check line ${line.toString().padStart(2, "0")}: sku=demo-${line.toString().padStart(3, "0")}; status=verified; provenance=docs/demo-inventory.csv#L${line}; recoverable_message_id=inventory-${line.toString().padStart(3, "0")}; note=deterministic non-sensitive fixture data for approval-ready Level 2 command-wrapper compaction.`;
}).join("\n");

const syntheticUsage = {
  input_tokens: 640,
  output_tokens: 180,
  total_tokens: 820,
  model: "placeholder-agent-model",
  provider: "openai-agents-demo-local",
  currency: "USD",
  metadata_status: "synthetic-demo",
  synthetic_demo: true,
  note: "Safe synthetic provider-reported usage metadata for this local demo only; not production billing data."
};

const events = [
  {
    type: "trace",
    id: traceId,
    workflow_name: "Approval-ready Level 2 command-wrapper demo",
    created_at: generatedAt,
    usage: syntheticUsage,
    source_provenance: {
      workflow_input: {
        demo_id: "approval-ready-level2-demo-001",
        source: "src/examples/openai-agents-approval-ready-workflow.js",
        recoverable_message_id: "workflow-input-approval-ready-001"
      },
      safety: "safe local demo workflow with deterministic non-sensitive fixture data",
      instrumentation_level: "Level 2 command-wrapper, not Level 3 native SDK instrumentation"
    }
  },
  {
    type: "span",
    trace_id: traceId,
    started_at: "2026-01-02T00:00:01.000Z",
    usage: syntheticUsage,
    span_data: {
      type: "generation",
      model: "placeholder-agent-model",
      usage: syntheticUsage,
      input: [
        {
          role: "user",
          content:
            "Run the safe local inventory approval demo. Preserve source pointers, recoverable message identifiers, synthetic-demo usage labels, and safety/provenance evidence."
        }
      ],
      output: [
        {
          role: "assistant",
          content:
            "I will call the local inventory_report tool twice so repeated deterministic output can be compacted while preserving source pointers."
        }
      ]
    }
  },
  {
    type: "span",
    trace_id: traceId,
    started_at: "2026-01-02T00:00:02.000Z",
    usage: syntheticUsage,
    span_data: {
      type: "function",
      name: "inventory_report",
      usage: syntheticUsage,
      input: JSON.stringify({ fixture: "safe-local-demo", source_pointer: "docs/demo-inventory.csv#L1-L28" }),
      output: repeatedInventorySnapshot
    }
  },
  {
    type: "span",
    trace_id: traceId,
    started_at: "2026-01-02T00:00:03.000Z",
    usage: syntheticUsage,
    span_data: {
      type: "function",
      name: "inventory_report",
      usage: syntheticUsage,
      input: JSON.stringify({ fixture: "safe-local-demo", source_pointer: "docs/demo-inventory.csv#L1-L28", repeat: true }),
      output: repeatedInventorySnapshot
    }
  },
  {
    type: "span",
    trace_id: traceId,
    started_at: "2026-01-02T00:00:04.000Z",
    usage: syntheticUsage,
    span_data: {
      type: "generation",
      model: "placeholder-agent-model",
      usage: syntheticUsage,
      output: [
        {
          role: "assistant",
          content:
            "Approval-ready demo complete: repeated local tool output is present for compaction; source provenance and recoverable message identifiers are present; usage metadata is synthetic-demo and not production billing data."
        }
      ]
    }
  }
];

for (const event of events) {
  console.log(JSON.stringify(event));
}
