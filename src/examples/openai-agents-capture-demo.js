const now = "2026-01-01T00:00:00.000Z";

const events = [
  {
    type: "trace",
    id: "trace_demo_openai_agents_capture",
    workflow_name: "Safe local OpenAI Agents SDK capture demo",
    created_at: now
  },
  {
    type: "span",
    trace_id: "trace_demo_openai_agents_capture",
    id: "span_generation_001",
    started_at: now,
    ended_at: "2026-01-01T00:00:01.000Z",
    span_data: {
      type: "generation",
      model: "gpt-4.1-mini",
      input: [{ role: "user", content: "Summarize the safe local fixture order." }],
      output: [{ role: "assistant", content: "I will inspect the local fixture order using the available tool." }]
    }
  },
  {
    type: "span",
    trace_id: "trace_demo_openai_agents_capture",
    id: "span_function_001",
    started_at: "2026-01-01T00:00:01.000Z",
    ended_at: "2026-01-01T00:00:02.000Z",
    span_data: {
      type: "function",
      name: "lookup_fixture_order",
      input: "{\"order_id\":\"demo-order-001\"}",
      output: "{\"status\":\"shipped\",\"contains_secrets\":false}"
    }
  },
  {
    type: "span",
    trace_id: "trace_demo_openai_agents_capture",
    id: "span_generation_002",
    started_at: "2026-01-01T00:00:02.000Z",
    ended_at: "2026-01-01T00:00:03.000Z",
    span_data: {
      type: "generation",
      model: "gpt-4.1-mini",
      input: [{ role: "tool", content: "{\"status\":\"shipped\",\"contains_secrets\":false}" }],
      output: [{ role: "assistant", content: "The fixture order shipped. No provider credentials or secrets were used." }]
    }
  }
];

for (const event of events) {
  console.log(JSON.stringify(event));
}
