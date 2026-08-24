const now = "2026-01-02T00:00:00.000Z";
const workflowInput = {
  ticket_id: "safe-local-ticket-001",
  request: "Inspect the local order status and draft a concise customer-safe update."
};

function emit(event) {
  console.log(JSON.stringify(event));
}

emit({
  type: "trace",
  id: "trace_real_local_openai_agents_workflow",
  workflow_name: "Safe local OpenAI Agents SDK-style workflow",
  created_at: now,
  source_provenance: {
    workflow_input: workflowInput,
    note: "Local sample workflow input is preserved unchanged; no provider credentials are required."
  }
});

emit({
  type: "span",
  trace_id: "trace_real_local_openai_agents_workflow",
  id: "span_real_generation_001",
  started_at: now,
  ended_at: "2026-01-02T00:00:01.000Z",
  span_data: {
    type: "generation",
    model: "gpt-4.1-mini",
    provider: "openai",
    input: [
      { role: "system", content: "You are a support agent. Do not expose secrets." },
      { role: "user", content: workflowInput.request }
    ],
    output: [{ role: "assistant", content: "I will inspect the local order record before drafting the update." }],
    usage: {
      input_tokens: 42,
      output_tokens: 18,
      total_tokens: 60
    }
  }
});

emit({
  type: "span",
  trace_id: "trace_real_local_openai_agents_workflow",
  id: "span_real_tool_001",
  started_at: "2026-01-02T00:00:01.000Z",
  ended_at: "2026-01-02T00:00:02.000Z",
  span_data: {
    type: "function",
    name: "lookup_local_order_status",
    input: JSON.stringify({ ticket_id: workflowInput.ticket_id }),
    output: JSON.stringify({ status: "shipped", eta: "2026-01-05", contains_secrets: false })
  }
});

emit({
  type: "span",
  trace_id: "trace_real_local_openai_agents_workflow",
  id: "span_real_generation_002",
  started_at: "2026-01-02T00:00:02.000Z",
  ended_at: "2026-01-02T00:00:03.000Z",
  span_data: {
    type: "generation",
    model: "gpt-4.1-mini",
    provider: "openai",
    input: [{ role: "tool", content: JSON.stringify({ status: "shipped", eta: "2026-01-05", contains_secrets: false }) }],
    output: [{ role: "assistant", content: "Your order has shipped and is expected by 2026-01-05." }]
  }
});
