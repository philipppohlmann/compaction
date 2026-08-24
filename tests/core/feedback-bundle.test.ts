import { describe, expect, it } from "vitest";
import {
  buildFeedbackBundle,
  filterUsageMetadata,
  formatBundlePreview,
  redactDiagnostic,
  renderBundleReadme,
  EXCLUDED_CATEGORIES,
  INCLUDED_FIELDS,
  UNKNOWN,
  type FeedbackBundleInput
} from "../../src/core/feedback-bundle.js";

/**
 * Forbidden-content sentinels. Each is a category the bundle must NEVER contain.
 * We feed every one of them into the build as if it leaked from a trace, then assert
 * none survive into the serialized bundle / preview / README.
 */
const SECRET_API_KEY = "sk-ant-FAKEFAKEFAKE0123456789abcdefABCDEF0123";
const BEARER_TOKEN = "Authorization: Bearer abcdef0123456789abcdef0123456789ZZZZ";
const ENV_VAR = "DATABASE_PASSWORD=hunter2supersecretvalue";
const RAW_PROMPT = "You are a helpful assistant. Here is the user's confidential business plan for Q3.";
const RAW_COMPLETION = "Sure! Based on the proprietary algorithm, the recommended price is forty two dollars.";
const TOOL_OUTPUT = "TOOL_RESULT: contents of /etc/passwd root:x:0:0 and customer SSN 123-45-6789";
const SOURCE_CODE = "function chargeCustomer(card) { return stripe.charge(card.number, card.cvc); }";
const FILE_CONTENT = "/Users/jane.doe/secret-project/customers.csv with names and emails jane@acme.example";
const CUSTOMER_DATA = "Customer: Acme Corp, contact bob@acme.example, contract value 1.2M USD";

const ALL_FORBIDDEN = [
  SECRET_API_KEY,
  BEARER_TOKEN,
  ENV_VAR,
  RAW_PROMPT,
  RAW_COMPLETION,
  TOOL_OUTPUT,
  SOURCE_CODE,
  FILE_CONTENT,
  CUSTOMER_DATA
];

const baseInput: FeedbackBundleInput = {
  environment: {
    cli_version: "0.1.0",
    os: "darwin 25.2.0",
    node_version: "v22.0.0",
    package_version: "0.1.0",
    install_method: "npx"
  },
  aggregate: {
    run_count: 3,
    total_original_input_tokens: 12000,
    total_compacted_input_tokens: 8000,
    total_input_tokens_saved: 4000,
    output_token_delta: UNKNOWN,
    estimated_cost_delta_usd: 0.0123
  }
};

describe("feedback bundle - INCLUDES default fields when available", () => {
  it("carries every default non-sensitive field", () => {
    const bundle = buildFeedbackBundle(
      {
        ...baseInput,
        supplied: {
          command_path: "compact",
          evidence_level: "measured_input_token_reduction",
          recoverability_status: "verified",
          applied_context: "yes",
          workflow_outcome: "succeeded",
          missing_context: "no",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage_metadata: { input_tokens: 8000, output_tokens: 400 }
        }
      },
      "2026-06-15T00:00:00.000Z"
    );

    expect(bundle.environment.cli_version).toBe("0.1.0");
    expect(bundle.environment.os).toBe("darwin 25.2.0");
    expect(bundle.environment.node_version).toBe("v22.0.0");
    expect(bundle.environment.package_version).toBe("0.1.0");
    expect(bundle.environment.install_method).toBe("npx");
    expect(bundle.command_path).toBe("compact");
    expect(bundle.evidence_level).toBe("measured_input_token_reduction");
    expect(bundle.tokens.aggregate_original_input_tokens).toBe(12000);
    expect(bundle.tokens.aggregate_compacted_input_tokens).toBe(8000);
    expect(bundle.tokens.aggregate_input_tokens_saved).toBe(4000);
    expect(bundle.cost.estimated_cost_delta_usd).toBe(0.0123);
    expect(bundle.recoverability_status).toBe("verified");
    expect(bundle.applied_context).toBe("yes");
    expect(bundle.workflow_outcome).toBe("succeeded");
    expect(bundle.missing_context).toBe("no");
    expect(bundle.provider).toBe("anthropic");
    expect(bundle.model).toBe("claude-sonnet-4-6");
    expect(bundle.usage_metadata).toEqual({ input_tokens: 8000, output_tokens: 400 });
  });

  it("records unknown (never inferred) when optional signals are absent", () => {
    const bundle = buildFeedbackBundle(baseInput, "2026-06-15T00:00:00.000Z");
    expect(bundle.command_path).toBe(UNKNOWN);
    expect(bundle.evidence_level).toBe("unknown");
    expect(bundle.recoverability_status).toBe(UNKNOWN);
    expect(bundle.applied_context).toBe("unknown");
    expect(bundle.workflow_outcome).toBe("unknown");
    expect(bundle.missing_context).toBe("unknown");
    expect(bundle.provider).toBe(UNKNOWN);
    expect(bundle.model).toBe(UNKNOWN);
    expect(bundle.usage_metadata).toBe(UNKNOWN);
    expect(bundle.tokens.output_token_delta).toBe(UNKNOWN);
    expect(bundle.redacted_diagnostics).toBe(UNKNOWN);
  });
});

describe("feedback bundle - EXCLUDES every forbidden category", () => {
  it("never lets forbidden content reach the serialized bundle, preview, or README", () => {
    // Feed a diagnostic blob containing EVERY forbidden category, as if it leaked from
    // a trace, plus stuff the same content into usage_metadata to be thorough.
    const leakedBlob = ALL_FORBIDDEN.join("\n");
    const bundle = buildFeedbackBundle(
      {
        ...baseInput,
        supplied: {
          diagnostic_text: leakedBlob,
          usage_metadata: { input_tokens: 8000 }
        }
      },
      "2026-06-15T00:00:00.000Z"
    );

    const serialized = JSON.stringify(bundle);
    const preview = formatBundlePreview(bundle);
    const readme = renderBundleReadme(bundle);
    const everywhere = `${serialized}\n${preview}\n${readme}`;

    // Distinctive secret/content fragments must be absent from every surface.
    const forbiddenFragments = [
      SECRET_API_KEY,
      "abcdef0123456789abcdef0123456789ZZZZ", // bearer token body
      "hunter2supersecretvalue", // env var value
      "confidential business plan", // raw prompt
      "proprietary algorithm", // raw completion
      "root:x:0:0", // tool output / file content
      "123-45-6789", // SSN in tool output
      "stripe.charge", // source code
      "customers.csv", // file content
      "jane@acme.example", // email
      "bob@acme.example", // customer email
      "Acme Corp" // customer data
    ];
    for (const fragment of forbiddenFragments) {
      expect(everywhere, `forbidden fragment leaked: ${fragment}`).not.toContain(fragment);
    }

    // The diagnostics field, if present, must be the redacted form (no raw secret).
    if (bundle.redacted_diagnostics !== UNKNOWN) {
      expect(bundle.redacted_diagnostics).not.toContain(SECRET_API_KEY);
      expect(bundle.redacted_diagnostics).toContain("***REDACTED");
    }

    // No code path copies whole forbidden categories into the structure: the only
    // free-text channel is the redacted diagnostics; usage_metadata is the operator's
    // own supplied object. Assert the bundle keys are exactly the allowed set.
    const allowedTopLevelKeys = new Set([
      "bundle_version",
      "generated_at",
      "privacy",
      "environment",
      "command_path",
      "evidence_level",
      "tokens",
      "cost",
      "recoverability_status",
      "applied_context",
      "workflow_outcome",
      "missing_context",
      "provider",
      "model",
      "usage_metadata",
      "usage_metadata_dropped_key_count",
      "redacted_diagnostics",
      "run_count"
    ]);
    for (const key of Object.keys(bundle)) {
      expect(allowedTopLevelKeys.has(key), `unexpected bundle key: ${key}`).toBe(true);
    }
  });
});

describe("feedback bundle - best-effort redaction", () => {
  it("masks credential shapes, env vars, paths, emails, and long content fragments", () => {
    const text = [
      SECRET_API_KEY,
      BEARER_TOKEN,
      ENV_VAR,
      "export OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOP012345",
      "/Users/jane.doe/work/secret.txt",
      "contact me at jane@acme.example",
      `prompt: "${RAW_PROMPT}"`
    ].join("\n");
    const redacted = redactDiagnostic(text);

    expect(redacted).not.toContain(SECRET_API_KEY);
    expect(redacted).not.toContain("abcdef0123456789abcdef0123456789ZZZZ");
    expect(redacted).not.toContain("hunter2supersecretvalue");
    expect(redacted).not.toContain("sk-proj-ABCDEFGHIJKLMNOP012345");
    expect(redacted).not.toContain("jane.doe");
    expect(redacted).not.toContain("jane@acme.example");
    expect(redacted).not.toContain("confidential business plan");
    expect(redacted).toContain("***REDACTED");
  });

  it("labels redaction as best-effort in preview and README", () => {
    const bundle = buildFeedbackBundle(baseInput, "2026-06-15T00:00:00.000Z");
    expect(formatBundlePreview(bundle).toLowerCase()).toContain("best-effort");
    expect(renderBundleReadme(bundle).toLowerCase()).toContain("best-effort");
    expect(bundle.privacy.redaction.toLowerCase()).toContain("best-effort");
  });
});

describe("feedback bundle - README + include/exclude lists present", () => {
  it("README states what is included, excluded, best-effort, and tester-chooses-to-send", () => {
    const bundle = buildFeedbackBundle(baseInput, "2026-06-15T00:00:00.000Z");
    const readme = renderBundleReadme(bundle);
    for (const field of INCLUDED_FIELDS) {
      expect(readme).toContain(field);
    }
    for (const category of EXCLUDED_CATEGORIES) {
      expect(readme).toContain(category);
    }
    expect(readme.toLowerCase()).toContain("you choose whether to send");
    expect(readme.toLowerCase()).toContain("no network");
  });
});

describe("feedback bundle - evidence honesty (workflow_confirmed != billing_confirmed)", () => {
  it("never emits a billing-confirmed / semantic / output-token-reduction claim", () => {
    const bundle = buildFeedbackBundle(
      {
        ...baseInput,
        supplied: { evidence_level: "workflow_confirmed", workflow_outcome: "succeeded" }
      },
      "2026-06-15T00:00:00.000Z"
    );
    const surface = `${JSON.stringify(bundle)}\n${formatBundlePreview(bundle)}\n${renderBundleReadme(bundle)}`.toLowerCase();

    // workflow_confirmed is recorded, but is NOT presented as billing_confirmed.
    expect(bundle.evidence_level).toBe("workflow_confirmed");
    expect(surface).not.toContain("billing-confirmed savings");
    expect(surface).not.toContain("billing_confirmed savings");
    expect(surface).not.toMatch(/output[\s-]token[\s-]reduction(?!\s+claim)/);
    // No semantic/commitment-preservation claim.
    expect(surface).not.toContain("semantic preservation");
    expect(surface).not.toContain("commitment preservation");
    // Cost delta is honestly labeled estimated, not billing-confirmed.
    expect(bundle.cost.label.toLowerCase()).toContain("estimated");
    expect(bundle.cost.label.toLowerCase()).toContain("not billing-confirmed");
    // The README explicitly distinguishes workflow_confirmed from billing_confirmed.
    expect(renderBundleReadme(bundle).toLowerCase()).toContain("workflow_confirmed is not billing_confirmed");
  });
});

describe("feedback bundle - usage_metadata is ALLOWLIST-filtered (P1 privacy)", () => {
  // A realistic provider usage export: token counts + model/provider (allowlisted) mixed
  // with forbidden categories a naive verbatim copy would leak.
  const FORBIDDEN_EMAIL = "billing-contact@customer.example";
  const FORBIDDEN_USER_ID = "user_8f3a-PRIVATE-29bc";
  const FORBIDDEN_PROMPT = "You are an assistant. Confidential: the Q3 acquisition target is Acme.";
  const FORBIDDEN_REQUEST_BODY = "POST /v1/messages {\"messages\":[{\"role\":\"user\",\"content\":\"secret\"}]}";

  const dirtyUsage: Record<string, unknown> = {
    // allowlisted, non-sensitive - must survive
    input_tokens: 8000,
    output_tokens: 400,
    total_tokens: 8400,
    cache_read_input_tokens: 1200,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    // forbidden - must be DROPPED (allowlist, not blocklist)
    email: FORBIDDEN_EMAIL,
    user_id: FORBIDDEN_USER_ID,
    prompt: FORBIDDEN_PROMPT,
    request_body: FORBIDDEN_REQUEST_BODY,
    response: { content: "leaked completion text" },
    organization: "Acme Corp Internal"
  };

  it("filterUsageMetadata keeps ONLY allowlisted fields and counts the dropped keys", () => {
    const filtered = filterUsageMetadata(dirtyUsage);
    expect(filtered).toBeDefined();
    expect(filtered!.kept).toEqual({
      input_tokens: 8000,
      output_tokens: 400,
      total_tokens: 8400,
      cache_read_input_tokens: 1200,
      model: "claude-sonnet-4-6",
      provider: "anthropic"
    });
    // email, user_id, prompt, request_body, response, organization = 6 dropped keys.
    expect(filtered!.dropped_key_count).toBe(6);
    // The forbidden VALUES never appear in the kept object.
    const keptSerialized = JSON.stringify(filtered!.kept);
    for (const forbidden of [
      "email",
      "user_id",
      "prompt",
      "request_body",
      "response",
      "organization",
      FORBIDDEN_EMAIL,
      FORBIDDEN_USER_ID,
      "acquisition target",
      "leaked completion",
      "Acme Corp Internal"
    ]) {
      expect(keptSerialized).not.toContain(forbidden);
    }
  });

  it("drops allowlisted keys whose value has the WRONG type (fail-closed)", () => {
    const filtered = filterUsageMetadata({
      input_tokens: { nested: "object-not-a-number" }, // wrong type → dropped
      output_tokens: "400", // string, not number → dropped
      total_tokens: 8400, // ok
      model: 12345, // number where string expected → dropped
      provider: "anthropic" // ok
    });
    expect(filtered!.kept).toEqual({ total_tokens: 8400, provider: "anthropic" });
    expect(filtered!.dropped_key_count).toBe(3);
  });

  it("the built bundle + preview contain ONLY allowlisted usage fields and NONE of the forbidden keys/values", () => {
    const bundle = buildFeedbackBundle(
      { ...baseInput, supplied: { usage_metadata: dirtyUsage } },
      "2026-06-15T00:00:00.000Z"
    );

    // Bundle's usage_metadata is the filtered object - exactly the allowlisted fields.
    expect(bundle.usage_metadata).toEqual({
      input_tokens: 8000,
      output_tokens: 400,
      total_tokens: 8400,
      cache_read_input_tokens: 1200,
      model: "claude-sonnet-4-6",
      provider: "anthropic"
    });
    expect(bundle.usage_metadata_dropped_key_count).toBe(6);

    // The forbidden keys/values are absent from EVERY surface (bundle, preview, README).
    const everywhere = `${JSON.stringify(bundle)}\n${formatBundlePreview(bundle)}\n${renderBundleReadme(bundle)}`;
    for (const forbidden of [
      FORBIDDEN_EMAIL,
      FORBIDDEN_USER_ID,
      "acquisition target",
      "leaked completion text",
      "Acme Corp Internal",
      '"prompt"',
      '"request_body"',
      '"user_id"'
    ]) {
      expect(everywhere, `forbidden usage fragment leaked: ${forbidden}`).not.toContain(forbidden);
    }

    // The preview surfaces the dropped-key COUNT but never a dropped VALUE.
    expect(formatBundlePreview(bundle)).toContain("6 unrecognized key(s) dropped");
  });

  it("absent / empty usage metadata stays unknown with zero dropped keys", () => {
    const bundle = buildFeedbackBundle(baseInput, "2026-06-15T00:00:00.000Z");
    expect(bundle.usage_metadata).toBe(UNKNOWN);
    expect(bundle.usage_metadata_dropped_key_count).toBe(0);

    const allForbidden = buildFeedbackBundle(
      { ...baseInput, supplied: { usage_metadata: { secret_only: "x", another: "y" } } },
      "2026-06-15T00:00:00.000Z"
    );
    // Nothing allowlisted survived → unknown, but the dropped count is recorded.
    expect(allForbidden.usage_metadata).toBe(UNKNOWN);
    expect(allForbidden.usage_metadata_dropped_key_count).toBe(2);
  });

  it("README records the allowlist-based, best-effort usage-metadata filtering", () => {
    const bundle = buildFeedbackBundle(
      { ...baseInput, supplied: { usage_metadata: dirtyUsage } },
      "2026-06-15T00:00:00.000Z"
    );
    const readme = renderBundleReadme(bundle).toLowerCase();
    expect(readme).toContain("allowlist");
    expect(readme).toContain("best-effort");
    expect(readme).toContain("input_tokens");
  });
});

describe("feedback bundle - diagnostics allowlist requires STACK-TRACE STRUCTURE (P1 privacy)", () => {
  it("DROPS a `trace: <raw prompt>` line (substring 'trace' is not enough)", () => {
    const rawPrompt = "the user's confidential business plan for Q3 acquisitions";
    const text = [
      `trace: ${rawPrompt}`,
      "stack: here is some prose that merely mentions a stack of pancakes",
      "TypeError: Cannot read properties of undefined (reading 'foo')",
      "    at handleRequest (server.js:42:13)"
    ].join("\n");

    const redacted = redactDiagnostic(text);

    // The bare `trace:`/`stack:` prose lines are DROPPED - raw prompt absent.
    expect(redacted).not.toContain(rawPrompt);
    expect(redacted).not.toContain("pancakes");
    expect(redacted).toContain("[dropped: non-error-shaped line]");

    // Real diagnostic structure is KEPT (shape-redacted form).
    expect(redacted).toContain("TypeError: Cannot read properties of undefined");
    expect(redacted).toContain("at handleRequest");
  });

  it("keeps recognized error headers / stack frames / Node error codes; drops other prose", () => {
    const text = [
      "Error: connection refused", // kept (error header)
      "    at Socket.connect (net.js:1138:14)", // kept (stack frame)
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module", // kept (Node error code)
      "code: 'ENOENT'", // kept (error code line)
      "Once upon a time the assistant summarized the customer's private roadmap", // DROPPED prose
      "trace of execution: the model chose tool X then leaked data Y" // DROPPED (no structure)
    ].join("\n");

    const redacted = redactDiagnostic(text);
    const keptLines = redacted.split("\n");

    expect(redacted).toContain("Error: connection refused");
    expect(redacted).toContain("at Socket.connect");
    expect(redacted).toContain("ERR_MODULE_NOT_FOUND");
    expect(redacted).toContain("ENOENT");
    // Both prose lines are dropped.
    expect(redacted).not.toContain("Once upon a time");
    expect(redacted).not.toContain("private roadmap");
    expect(redacted).not.toContain("leaked data Y");
    expect(keptLines.filter((l) => l === "[dropped: non-error-shaped line]").length).toBe(2);
  });
});
