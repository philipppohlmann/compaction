import { describe, expect, it } from "vitest";
import {
  redactSecrets,
  REDACTION_MASK
} from "../../src/core/provider-usage/credential-redaction.js";
import {
  captureProviderUsage,
  DEFAULT_CREDENTIAL_ENV_VAR,
  MissingProviderCredentialError
} from "../../src/core/provider-usage/provider-usage-adapter.js";
import {
  parseAggregateUsage,
  type FetchUsageInput,
  type ProviderAggregateUsage,
  type ProviderUsageClient
} from "../../src/core/provider-usage/provider-usage-client.js";
import {
  evidenceSourceTypeFromTrace,
  approvalReadinessStatusFromReport,
  createSafetyReport
} from "../../src/core/safety-report.js";
import type { AgentTrace } from "../../src/core/types.js";

// Clearly-fake sentinel credential. NOT a real secret. Never goes near a network.
const SENTINEL_CREDENTIAL = "SENTINEL-FAKE-KEY-DO-NOT-USE-0123456789abcdef0123456789abcdef";

/** Mock client returning a fixture aggregate-usage response. No network, no secret use beyond receiving it. */
function mockClient(response: ProviderAggregateUsage, capture?: (input: FetchUsageInput) => void): ProviderUsageClient {
  return {
    async fetchUsage(input: FetchUsageInput): Promise<ProviderAggregateUsage> {
      capture?.(input);
      return response;
    }
  };
}

const FIXTURE_USAGE_WITH_COST: ProviderAggregateUsage = {
  model: "claude-3-5-sonnet",
  provider: "anthropic",
  input_tokens: 120000,
  output_tokens: 34000,
  total_tokens: 154000,
  request_count: 87,
  cost: 4.21,
  currency: "USD",
  window_start: "2026-06-01T00:00:00.000Z",
  window_end: "2026-06-08T00:00:00.000Z"
};

const FIXTURE_USAGE_TOKENS_ONLY: ProviderAggregateUsage = {
  model: "claude-3-5-sonnet",
  provider: "anthropic",
  input_tokens: 5000,
  output_tokens: 1000,
  total_tokens: 6000,
  request_count: 3,
  window_start: "2026-06-01T00:00:00.000Z",
  window_end: "2026-06-08T00:00:00.000Z"
};

function captureWithSentinel(overrides: Partial<Parameters<typeof captureProviderUsage>[0]> = {}) {
  return captureProviderUsage({
    endpoint: "https://provider.example/usage",
    credentialEnvVar: DEFAULT_CREDENTIAL_ENV_VAR,
    env: { [DEFAULT_CREDENTIAL_ENV_VAR]: SENTINEL_CREDENTIAL },
    client: mockClient(FIXTURE_USAGE_WITH_COST),
    capturedAt: "2026-06-08T12:00:00.000Z",
    runId: "provider-usage-test",
    windowStart: "2026-06-01T00:00:00.000Z",
    windowEnd: "2026-06-08T00:00:00.000Z",
    ...overrides
  });
}

describe("provider-usage credential redaction", () => {
  it("masks the exact configured secret value wherever it appears", () => {
    const text = `request failed with token ${SENTINEL_CREDENTIAL} in header`;
    const out = redactSecrets(text, SENTINEL_CREDENTIAL);
    expect(out).not.toContain(SENTINEL_CREDENTIAL);
    expect(out).toContain(REDACTION_MASK);
  });

  it("masks Authorization: Bearer and x-api-key header values by shape (no configured secret needed)", () => {
    const bearer = redactSecrets("Authorization: Bearer abcDEF1234567890longtoken");
    expect(bearer).toContain("Authorization: Bearer ");
    expect(bearer).toContain(REDACTION_MASK);
    expect(bearer).not.toContain("abcDEF1234567890longtoken");

    // FAKE_MARKER: a documented low-entropy fake, the same one no-committed-secrets.test.ts pins.
    const apiKey = redactSecrets("x-api-key: sk-ant-abcdef0123456789abcdef0123");
    expect(apiKey).toContain("x-api-key: ");
    expect(apiKey).toContain(REDACTION_MASK);
    expect(apiKey).not.toContain("sk-ant-abcdef0123456789abcdef0123");
  });

  it("masks provider key-prefixed tokens and long high-entropy tokens by shape", () => {
    const prefixed = redactSecrets("key=sk-ant-api03-LONGTOKENVALUE0123456789abcdef");
    expect(prefixed).toContain(REDACTION_MASK);
    expect(prefixed).not.toContain("sk-ant-api03-LONGTOKENVALUE0123456789abcdef");

    const longToken = redactSecrets("token: ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij");
    expect(longToken).toContain(REDACTION_MASK);
  });
});

describe("provider-usage capture - missing-credential refusal", () => {
  it("refuses cleanly when the env var is absent (no artifact, names the env var, no secret)", async () => {
    await expect(
      captureProviderUsage({
        endpoint: "https://provider.example/usage",
        credentialEnvVar: DEFAULT_CREDENTIAL_ENV_VAR,
        env: {}, // absent
        client: mockClient(FIXTURE_USAGE_WITH_COST)
      })
    ).rejects.toBeInstanceOf(MissingProviderCredentialError);

    try {
      await captureProviderUsage({
        endpoint: "https://provider.example/usage",
        credentialEnvVar: DEFAULT_CREDENTIAL_ENV_VAR,
        env: {},
        client: mockClient(FIXTURE_USAGE_WITH_COST)
      });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(DEFAULT_CREDENTIAL_ENV_VAR);
      expect(message).not.toContain(SENTINEL_CREDENTIAL);
      expect(message.toLowerCase()).toContain("no fallback");
    }
  });

  it("refuses cleanly when the env var is present but empty", async () => {
    await expect(
      captureProviderUsage({
        endpoint: "https://provider.example/usage",
        credentialEnvVar: DEFAULT_CREDENTIAL_ENV_VAR,
        env: { [DEFAULT_CREDENTIAL_ENV_VAR]: "" },
        client: mockClient(FIXTURE_USAGE_WITH_COST)
      })
    ).rejects.toBeInstanceOf(MissingProviderCredentialError);
  });

  it("never performs the read when the credential is missing", async () => {
    let fetched = false;
    const watching = mockClient(FIXTURE_USAGE_WITH_COST, () => {
      fetched = true;
    });
    await expect(
      captureProviderUsage({
        endpoint: "https://provider.example/usage",
        env: {},
        client: watching
      })
    ).rejects.toBeInstanceOf(MissingProviderCredentialError);
    expect(fetched).toBe(false);
  });
});

describe("provider-usage capture - no-secret-leak", () => {
  it("never includes the sentinel credential in the produced CapturedRun (trace/usage/provenance)", async () => {
    const run = await captureWithSentinel();
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain(SENTINEL_CREDENTIAL);
    // Provenance descriptor is non-secret: endpoint + window only.
    expect(run.provenance.sourcePath).toContain("https://provider.example/usage");
    expect(run.provenance.sourcePath).not.toContain(SENTINEL_CREDENTIAL);
  });

  it("passes the credential to the client auth path but never copies it into the result", async () => {
    let seenCredential: string | undefined;
    const run = await captureProviderUsage({
      endpoint: "https://provider.example/usage",
      env: { [DEFAULT_CREDENTIAL_ENV_VAR]: SENTINEL_CREDENTIAL },
      client: mockClient(FIXTURE_USAGE_WITH_COST, (input) => {
        seenCredential = input.credential;
      }),
      capturedAt: "2026-06-08T12:00:00.000Z",
      runId: "provider-usage-test"
    });
    // The client received the credential (it authenticates the read)...
    expect(seenCredential).toBe(SENTINEL_CREDENTIAL);
    // ...but it appears nowhere in the serialized result.
    expect(JSON.stringify(run)).not.toContain(SENTINEL_CREDENTIAL);
  });

  it("redacts the sentinel on a failure path (auth error) before it could be printed", async () => {
    const failingClient: ProviderUsageClient = {
      async fetchUsage(): Promise<ProviderAggregateUsage> {
        // Provider error WITHOUT echoing the credential (by construction); redaction is the backstop.
        throw new Error("Provider usage endpoint returned HTTP 401 Unauthorized.");
      }
    };
    let thrown: Error | undefined;
    try {
      await captureProviderUsage({
        endpoint: "https://provider.example/usage",
        env: { [DEFAULT_CREDENTIAL_ENV_VAR]: SENTINEL_CREDENTIAL },
        client: failingClient
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    // Even if an error somehow embedded the secret, the redaction pass removes it.
    const redacted = redactSecrets(`error: ${thrown!.message}`, SENTINEL_CREDENTIAL);
    expect(redacted).not.toContain(SENTINEL_CREDENTIAL);
  });
});

describe("provider-usage capture - aggregate-only behavior", () => {
  it("produces a usage-only trace: source provider_usage, no messages, no content fields", async () => {
    const run = await captureWithSentinel();
    expect(run.trace.source).toBe("provider_usage");
    expect(run.trace.messages).toEqual([]);
    // No content anywhere: the serialized trace carries no message/prompt/completion content.
    const traceJson = JSON.stringify(run.trace);
    expect(traceJson).not.toMatch(/prompt|completion/i);
  });

  it("labels cost as provider-reported when the endpoint exposes cost", async () => {
    const run = await captureWithSentinel();
    expect(run.usage.provider_reported_tokens).toBe(true);
    expect(run.usage.estimated_tokens).toBe(false);
    expect(run.usage.cost_source).toBe("provider_reported");
    expect(run.usage.input_tokens).toBe(FIXTURE_USAGE_WITH_COST.input_tokens);
    expect(run.usage.currency).toBe("USD");
  });

  it("does NOT claim provider-reported cost when the endpoint exposes tokens only", async () => {
    const run = await captureWithSentinel({ client: mockClient(FIXTURE_USAGE_TOKENS_ONLY) });
    expect(run.usage.provider_reported_tokens).toBe(true);
    // Tokens-only: cost falls back to the price-table estimate path, NOT provider_reported.
    expect(run.usage.cost_source).not.toBe("provider_reported");
    expect(run.usage.limitations.join(" ")).toContain("Cost not exposed by the endpoint");
  });

  it("records non-secret aggregate-only provenance and the Tier-3-not-claimed limitation", async () => {
    const run = await captureWithSentinel();
    const limitations = run.provenance.limitations.join(" ");
    expect(limitations).toContain("NO prompt/completion content");
    expect(limitations).toContain("Billing-confirmed savings (Tier 3) are NOT claimed");
  });

  it("parseAggregateUsage drops unexpected/content-shaped fields defensively", () => {
    const parsed = parseAggregateUsage({
      model: "m",
      input_tokens: 10,
      prompt: "SHOULD-NOT-SURVIVE",
      completion: "SHOULD-NOT-SURVIVE",
      messages: [{ role: "user", content: "SHOULD-NOT-SURVIVE" }]
    });
    expect(JSON.stringify(parsed)).not.toContain("SHOULD-NOT-SURVIVE");
    expect(parsed.input_tokens).toBe(10);
  });
});

describe("provider-usage evidence classification + readiness cap (Option 2)", () => {
  it("maps provider_usage trace source to provider_reported_usage evidence type (not real_captured)", () => {
    expect(evidenceSourceTypeFromTrace("provider_usage")).toBe("provider_reported_usage");
    expect(evidenceSourceTypeFromTrace("provider_usage")).not.toBe("real_captured");
  });

  it("caps a passing report on provider_reported_usage at conditional, NEVER ready", () => {
    // Even with an independent human reviewer + review summary present, the new
    // evidence type must NOT unlock "ready" (only real_captured does).
    const status = approvalReadinessStatusFromReport("pass", "provider_reported_usage", "human", true);
    expect(status).toBe("conditional");
    expect(status).not.toBe("ready");
  });

  it("createSafetyReport on a usage-only provider_usage trace passes but stays conditional", async () => {
    const run = await captureWithSentinel();
    const trace: AgentTrace = run.trace;
    const report = createSafetyReport({
      runId: "provider-usage-safety",
      generatedAt: "2026-06-08T12:00:00.000Z",
      originalTrace: trace,
      compactedMessages: [],
      stateCapsules: [],
      compactedMessageIds: [],
      tokensSaved: 0,
      policyName: "no_compaction",
      reviewerType: "human",
      reviewSummaryPresent: true
    });
    // No-compaction branch passes (nothing to compact)...
    expect(report.status).toBe("pass");
    expect(report.evidence_source_type).toBe("provider_reported_usage");
    // ...but a usage/cost record is cost/spend evidence, never approval-ready.
    expect(report.approval_readiness_status).toBe("conditional");
    expect(report.approval_readiness_status).not.toBe("ready");
  });
});
