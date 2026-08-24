const now = "2026-01-01T00:00:00.000Z";
const repeatedToolOutput = Array.from({ length: 260 }, (_, index) => `order_line_${index}: safe local fixture item shipped with no secrets`).join("\n");

const events = [
  {
    type: "trace",
    id: "trace_demo_openai_agents_optimization",
    workflow_name: "Safe local OpenAI Agents SDK optimization demo",
    created_at: now
  },
  {
    type: "span",
    trace_id: "trace_demo_openai_agents_optimization",
    id: "span_generation_001",
    started_at: now,
    ended_at: "2026-01-01T00:00:01.000Z",
    span_data: {
      type: "generation",
      model: "gpt-4.1-mini",
      input: [{ role: "user", content: "Review the safe local fixture order history and summarize shipping status." }],
      output: [{ role: "assistant", content: "I will inspect the local fixture order history using the available tool." }]
    }
  },
  {
    type: "span",
    trace_id: "trace_demo_openai_agents_optimization",
    id: "span_function_001",
    started_at: "2026-01-01T00:00:01.000Z",
    ended_at: "2026-01-01T00:00:02.000Z",
    span_data: {
      type: "function",
      name: "lookup_fixture_order_history",
      input: "{\"order_id\":\"demo-order-optimization-001\"}",
      output: repeatedToolOutput
    }
  },
  {
    type: "span",
    trace_id: "trace_demo_openai_agents_optimization",
    id: "span_generation_002",
    started_at: "2026-01-01T00:00:02.000Z",
    ended_at: "2026-01-01T00:00:03.000Z",
    span_data: {
      type: "generation",
      model: "gpt-4.1-mini",
      input: [{ role: "tool", content: repeatedToolOutput }],
      output: [{ role: "assistant", content: "The fixture order history shows shipped items and no secrets." }]
    }
  },
  {
    type: "span",
    trace_id: "trace_demo_openai_agents_optimization",
    id: "span_function_002",
    started_at: "2026-01-01T00:00:03.000Z",
    ended_at: "2026-01-01T00:00:04.000Z",
    span_data: {
      type: "function",
      name: "lookup_fixture_order_history",
      input: "{\"order_id\":\"demo-order-optimization-001\",\"retry\":true}",
      output: repeatedToolOutput
    }
  },
  {
    type: "span",
    trace_id: "trace_demo_openai_agents_optimization",
    id: "span_generation_003",
    started_at: "2026-01-01T00:00:04.000Z",
    ended_at: "2026-01-01T00:00:05.000Z",
    span_data: {
      type: "generation",
      model: "gpt-4.1-mini",
      input: [{ role: "tool", content: repeatedToolOutput }],
      output: [{ role: "assistant", content: "The duplicate local fixture lookup confirms the order shipped. No provider credentials or secrets were used." }]
    }
  }
];

for (const event of events) {
  console.log(JSON.stringify(event));
}
