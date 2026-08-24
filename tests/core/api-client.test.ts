/**
 * Compaction API client tests (Track E reference client).
 *
 * These run ONLY against a LOCAL stub HTTP server bound to 127.0.0.1 that mirrors the
 * `docs/api/compaction-api-v0.md` contract surface the client uses (status / optimize /
 * evaluate / reports) including the fail-closed `consent_required` behavior. The stub is
 * self-contained and imports NOTHING from `src/engine` or the `apps/api` package, that is the
 * whole point of the boundary: the public client must be exercisable with no engine present.
 * No real/remote endpoint is ever contacted; the server listens on an ephemeral local port.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  apiStatus,
  buildEvaluateRequest,
  buildOptimizeRequest,
  buildReportsRequest,
  ConsentError,
  isContentBearing,
  previewPayload,
  resolveApiConfig,
  sendRequest,
  ApiNotConfirmedError,
  ApiTransportError,
  DEFAULT_API_URL,
  isToolName,
  resolveToolName,
  TOOL_NAMES,
  type ApiConfig, PRODUCTION_API_URL, LOCAL_DEV_API_URL } from "../../src/core/api-client/index.js";

const CONTENT_BEARING = new Set(["sanitized_snippets", "full_trace"]);

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      resolve(raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>));
    });
  });
}

/** Records what the stub actually received, so tests can assert NO content leaked. */
const received: Array<{ path: string; body: Record<string, unknown> }> = [];

/**
 * Minimal local stub of the v0 contract. Implements just enough to exercise the client and to
 * enforce the SAME consent fail-closed rule the real server does. NO engine, NO persistence.
 */
function makeStub(): http.Server {
  return http.createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload);
    };

    if (req.method === "GET" && req.url === "/v0/status") {
      return send(200, {
        status: "ok",
        service: "compaction-api",
        version: "v0",
        mode: "local-engine-dev",
        engine: "local-engine",
        hosted: false,
        uptime_seconds: 1
      });
    }

    if (req.method === "POST" && req.url && req.url.startsWith("/v0/")) {
      void readJsonBody(req).then((body) => {
        received.push({ path: req.url as string, body });
        const consent = (body.consent as { upload_permitted?: boolean } | undefined) ?? {};
        const cls = body.payload_class as string | undefined;
        // Contract fail-closed mirror: content-bearing class requires upload consent.
        if (cls && CONTENT_BEARING.has(cls) && consent.upload_permitted !== true) {
          return send(400, {
            error: "validation_error",
            details: [{ message: `consent_required: payload_class "${cls}" carries content` }]
          });
        }
        if (req.url === "/v0/optimize") {
          return send(200, {
            status: "optimized",
            optimization_id: "opt_stub",
            compacted_context: null,
            reference: null,
            token_delta: { before: 100, after: 60, saved: 40, percent: 40, source: "local-estimate" },
            estimated_cost_delta: {
              before: 0.01,
              after: 0.006,
              saved: 0.004,
              currency: "USD",
              label: "token-estimated-cost"
            },
            evidence_status: "not_evaluated",
            apply_recommendation: "review_required",
            warnings: ["local-estimate", "no-content-echo"]
          });
        }
        if (req.url === "/v0/evaluate") {
          return send(200, {
            status: "evaluated",
            recoverability_result: "passed",
            commitment_preservation_result: "not_computed",
            task_replay_result: "future",
            task_check_result: "not_computed",
            readiness: "conditional",
            per_axis: [],
            scope_note: "deterministic recoverability only",
            reasons: ["recoverability/semantic-scope caveat"]
          });
        }
        if (req.url === "/v0/reports") {
          return send(200, {
            status: "aggregated",
            report_id: "rep_stub",
            normalized_summary: {
              run_count: 1,
              total_original_input_tokens: 100,
              total_compacted_input_tokens: 60,
              total_tokens_saved: 40,
              total_estimated_cost_before: 0.01,
              total_estimated_cost_after: 0.006,
              total_estimated_cost_saved: 0.004,
              average_percent_reduction: 40
            },
            skipped_runs: [],
            warnings: ["sums-only", "never-extrapolated", "in-memory-only"]
          });
        }
        return send(404, { error: "not_found" });
      });
      return;
    }

    send(404, { error: "not_found" });
  });
}

let server: http.Server;
let config: ApiConfig;

beforeAll(async () => {
  server = makeStub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  config = resolveApiConfig({ COMPACTION_API_URL: `http://127.0.0.1:${port}` });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("config", () => {
  it("defaults to the PRODUCTION service when env is unset, and carries no credential", () => {
    // This assertion was inverted, deliberately. It used to require a loopback default and call a
    // baked remote a defect, which was right while no service was deployed: a default pointing at a
    // host nobody ran would have been a fake. The service is deployed now, and a normal install sets
    // no environment at all, so a loopback default would send every fresh activation to a port on
    // the user's own machine. The property that actually matters is unchanged and pinned below: the
    // default carries no credential, and the URL is a single reviewable constant rather than
    // something assembled per call — the host a device authenticates to is a trust boundary.
    const c = resolveApiConfig({});
    expect(c.url).toBe(DEFAULT_API_URL);
    expect(c.url).toBe(PRODUCTION_API_URL);
    expect(c.url.startsWith("https://"), "production is HTTPS-only").toBe(true);
    expect(c.url.startsWith("http://127.0.0.1"), "loopback is a dev override, never the default").toBe(false);
    expect(c.apiKey).toBeUndefined();
  });

  it("keeps the loopback dev origin available as an explicit override only", () => {
    expect(LOCAL_DEV_API_URL.startsWith("http://127.0.0.1")).toBe(true);
    expect(resolveApiConfig({ COMPACTION_API_URL: LOCAL_DEV_API_URL }).url).toBe(LOCAL_DEV_API_URL);
  });

  it("attaches a bearer token only when COMPACTION_API_KEY is set, and never persists it", () => {
    const c = resolveApiConfig({ COMPACTION_API_KEY: "secret-key" });
    expect(c.apiKey).toBe("secret-key");
  });
});

describe("payload builders fail closed", () => {
  it("content-free class (default metrics_only) attaches NO inline content even if provided", () => {
    const req = buildOptimizeRequest({
      trace: { redacted: false, content: { messages: ["secret"] }, reference: "local://a" }
    });
    expect(req.payload_class).toBe("metrics_only");
    expect(req.trace.content).toBeUndefined();
    expect(req.trace.reference).toBe("local://a");
    expect(req.token_usage.source).toBe("local-estimate");
  });

  it("content-bearing class WITHOUT consent throws ConsentError (never builds a sendable body)", () => {
    expect(() =>
      buildOptimizeRequest({
        trace: { redacted: false, content: { messages: ["secret"] } },
        payloadClass: "full_trace"
      })
    ).toThrow(ConsentError);
  });

  it("content-bearing class WITH consent builds a body that carries content", () => {
    const req = buildOptimizeRequest({
      trace: { redacted: false, content: { messages: ["secret"] } },
      payloadClass: "sanitized_snippets",
      uploadPermitted: true
    });
    expect(req.consent.upload_permitted).toBe(true);
    expect(req.trace.content).toBeDefined();
    expect(isContentBearing(req.payload_class)).toBe(true);
  });

  it("never upgrades the token source label", () => {
    const req = buildOptimizeRequest({
      trace: { redacted: true, reference: "local://a" },
      tokenSource: "unknown"
    });
    expect(req.token_usage.source).toBe("unknown");
  });
});

describe("content-free tool/provider/model attribution", () => {
  it("emits tool + model + provider into provider_metadata (content-free)", () => {
    const req = buildOptimizeRequest({
      trace: { redacted: true, reference: "local://a" },
      tool: "cursor",
      provider: "anthropic",
      model: "claude-sonnet-4-6"
    });
    expect(req.provider_metadata).toEqual({ provider: "anthropic", tool: "cursor", model: "claude-sonnet-4-6" });
    // Attribution never pulls in any trace content.
    expect(req.trace.content).toBeUndefined();
  });

  it("omits provider_metadata entirely when no attribution is supplied", () => {
    const req = buildOptimizeRequest({ trace: { redacted: true, reference: "local://a" } });
    expect(req.provider_metadata).toBeUndefined();
  });

  it("resolveToolName maps capture-adapter ids / sources to canonical values, honest default `other`", () => {
    expect(resolveToolName("claude-code")).toBe("claude-code");
    expect(resolveToolName("openai-agents")).toBe("openai-agents");
    expect(resolveToolName("codex_import")).toBe("codex");
    expect(resolveToolName("cursor")).toBe("cursor");
    expect(resolveToolName("something-unknown")).toBe("other");
    expect(resolveToolName(null)).toBe("other");
  });

  it("isToolName guards the canonical five and rejects anything else", () => {
    for (const t of TOOL_NAMES) expect(isToolName(t)).toBe(true);
    expect(isToolName("not-a-tool")).toBe(false);
    expect(isToolName(undefined)).toBe(false);
  });
});

describe("preview shows exactly what would be sent", () => {
  it("reports content=false and a byte size for a metrics_only body, redacting nothing secret into it", () => {
    const req = buildOptimizeRequest({ trace: { redacted: true, reference: "local://a" } });
    const preview = previewPayload("POST", "/v0/optimize", config.url, req);
    expect(preview.contentIncluded).toBe(false);
    expect(preview.summary).toContain("NO message content");
    expect(preview.byteSize).toBeGreaterThan(0);
    expect(JSON.stringify(preview.body)).not.toContain("Bearer");
  });

  it("flags content for a content-bearing body", () => {
    const req = buildOptimizeRequest({
      trace: { redacted: false, content: { messages: ["x"] } },
      payloadClass: "full_trace",
      uploadPermitted: true
    });
    const preview = previewPayload("POST", "/v0/optimize", config.url, req);
    expect(preview.contentIncluded).toBe(true);
    expect(preview.summary.toLowerCase()).toContain("content included");
  });
});

describe("no auto-upload", () => {
  it("sendRequest refuses a content-bearing body without consent (no network)", async () => {
    const body = {
      trace: { redacted: false, content: { messages: ["x"] } },
      consent: { upload_permitted: false, redacted: false },
      payload_class: "full_trace" as const,
      token_usage: { source: "local-estimate" as const },
      optimization_mode: "recommend" as const
    };
    await expect(sendRequest(config, "/v0/optimize", body)).rejects.toBeInstanceOf(
      ApiNotConfirmedError
    );
  });

  it("sendRequest refuses a content-bearing body with consent but WITHOUT explicit confirm", async () => {
    const body = buildOptimizeRequest({
      trace: { redacted: false, content: { messages: ["x"] } },
      payloadClass: "sanitized_snippets",
      uploadPermitted: true
    });
    await expect(sendRequest(config, "/v0/optimize", body)).rejects.toBeInstanceOf(
      ApiNotConfirmedError
    );
  });
});

describe("consent gate is driven by ACTUAL body content, not the declared payload_class", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // (a) Builder fix: a content-free class with a populated compactedContext.content must build a
  // body that carries NO inline content from ANY source - the previously-leaked trace-derived
  // compacted content is now stripped.
  it("buildEvaluateRequest (metrics_only) strips inline compactedContext.content (no leak)", () => {
    const req = buildEvaluateRequest({
      originalTrace: { redacted: false, content: { messages: ["orig-secret"] }, reference: "local://a" },
      compactedContext: { content: { summary: ["compacted-secret"] }, reference: "local://b" }
    });
    expect(req.payload_class).toBe("metrics_only");
    expect(req.original_trace.content).toBeUndefined();
    expect(req.original_trace.reference).toBe("local://a");
    // The previously-leaked field: compacted_context.content must be gone for a content-free class.
    expect(req.compacted_context.content).toBeUndefined();
    expect(req.compacted_context.reference).toBe("local://b");
    // Belt-and-suspenders: no secret string survives anywhere in the serialized body.
    expect(JSON.stringify(req)).not.toContain("compacted-secret");
    expect(JSON.stringify(req)).not.toContain("orig-secret");
  });

  it("buildEvaluateRequest (redacted_structure) also strips inline compactedContext.content", () => {
    const req = buildEvaluateRequest({
      originalTrace: { redacted: false, content: { messages: ["x"] }, reference: "local://a" },
      compactedContext: { content: { summary: ["leak"] }, reference: "local://b" },
      payloadClass: "redacted_structure"
    });
    expect(req.compacted_context.content).toBeUndefined();
    expect(JSON.stringify(req)).not.toContain("leak");
  });

  // (b) Client fix: a hand-built body declaring a content-free class but actually carrying inline
  // content with upload_permitted:false must THROW before any network call. We spy on global fetch
  // and assert it was NEVER invoked.
  it("sendRequest THROWS (no fetch) on a metrics_only body that hides inline trace.content", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const body = {
      trace: { redacted: false, content: { messages: ["hidden-raw"] } },
      consent: { upload_permitted: false, redacted: false },
      payload_class: "metrics_only" as const,
      token_usage: { source: "local-estimate" as const },
      optimization_mode: "recommend" as const
    };
    await expect(sendRequest(config, "/v0/optimize", body)).rejects.toBeInstanceOf(ConsentError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sendRequest THROWS (no fetch) on a metrics_only EVALUATE body hiding original_trace.content", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const body = {
      original_trace: { redacted: false, content: { messages: ["orig-raw"] } },
      compacted_context: { reference: "local://b" },
      consent: { upload_permitted: false, redacted: false },
      payload_class: "metrics_only" as const
    };
    await expect(sendRequest(config, "/v0/evaluate", body)).rejects.toBeInstanceOf(ConsentError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sendRequest THROWS (no fetch) on a metrics_only EVALUATE body hiding compacted_context.content", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const body = {
      original_trace: { redacted: true, reference: "local://a" },
      compacted_context: { content: { summary: ["compacted-raw"] } },
      consent: { upload_permitted: false, redacted: false },
      payload_class: "metrics_only" as const
    };
    await expect(sendRequest(config, "/v0/evaluate", body)).rejects.toBeInstanceOf(ConsentError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Even WITH upload_permitted:true, a content-free LABEL carrying content is itself an error
  // (the label lied). Reject before any fetch - the strongest fail-closed posture.
  it("sendRequest THROWS (no fetch) on a content-free label carrying content even with consent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const body = {
      trace: { redacted: false, content: { messages: ["raw"] } },
      consent: { upload_permitted: true, redacted: false },
      payload_class: "metrics_only" as const,
      token_usage: { source: "local-estimate" as const },
      optimization_mode: "recommend" as const
    };
    await expect(sendRequest(config, "/v0/optimize", body, { confirmed: true })).rejects.toBeInstanceOf(
      ConsentError
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // (c) The honest path: a content-BEARING class carrying content WITH upload_permitted:true AND an
  // explicit confirm is allowed through to the (local stub) server.
  it("sendRequest ALLOWS a content-bearing body with consent + explicit confirm", async () => {
    const req = buildOptimizeRequest({
      trace: { redacted: false, content: { messages: ["payload"] } },
      payloadClass: "sanitized_snippets",
      uploadPermitted: true
    });
    const res = await sendRequest(config, "/v0/optimize", req, { confirmed: true });
    expect(res.ok).toBe(true);
  });
});

describe("against the local stub", () => {
  it("apiStatus returns the honest local-engine-dev shape (hosted: false)", async () => {
    const res = await apiStatus(config);
    expect(res.ok).toBe(true);
    const body = res.body as { mode: string; hosted: boolean };
    expect(body.mode).toBe("local-engine-dev");
    expect(body.hosted).toBe(false);
  });

  it("optimize (metrics_only) round-trips honest labels and never sends content", async () => {
    received.length = 0;
    const req = buildOptimizeRequest({ trace: { redacted: true, reference: "local://a" } });
    const res = await sendRequest<{ token_delta: { source: string }; apply_recommendation: string }>(
      config,
      "/v0/optimize",
      req
    );
    expect(res.ok).toBe(true);
    const body = res.body as { token_delta: { source: string }; apply_recommendation: string };
    expect(body.token_delta.source).toBe("local-estimate");
    expect(body.apply_recommendation).toBe("review_required");
    // The server received NO message content for a metrics_only send.
    const sent = received.find((r) => r.path === "/v0/optimize");
    expect((sent?.body.trace as { content?: unknown })?.content).toBeUndefined();
  });

  it("evaluate round-trips deterministic verdicts (task_replay stays future)", async () => {
    const req = buildEvaluateRequest({
      originalTrace: { redacted: true, reference: "local://a" },
      compactedContext: { reference: "local://b" }
    });
    const res = await sendRequest<{ task_replay_result: string }>(config, "/v0/evaluate", req);
    expect((res.body as { task_replay_result: string }).task_replay_result).toBe("future");
  });

  it("a content-bearing send WITH consent AND explicit confirm reaches the stub", async () => {
    const req = buildOptimizeRequest({
      trace: { redacted: false, content: { messages: ["payload"] } },
      payloadClass: "sanitized_snippets",
      uploadPermitted: true
    });
    const res = await sendRequest(config, "/v0/optimize", req, { confirmed: true });
    expect(res.ok).toBe(true);
  });

  it("reports aggregation returns sums-only labels", async () => {
    const req = buildReportsRequest({ reportBundle: { redacted: true, runs: [] } });
    const res = await sendRequest<{ warnings: string[] }>(config, "/v0/reports", req);
    expect((res.body as { warnings: string[] }).warnings).toContain("sums-only");
  });
});

describe("transport errors", () => {
  it("surfaces a clean transport error when the server is unreachable", async () => {
    // Port 1 is privileged/unused → connection refused; the client must not hang or leak.
    const badConfig = resolveApiConfig({
      COMPACTION_API_URL: "http://127.0.0.1:1",
      COMPACTION_API_TIMEOUT_MS: "500"
    });
    await expect(apiStatus(badConfig)).rejects.toBeInstanceOf(ApiTransportError);
  });
});
