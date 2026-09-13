import { describe, expect, it } from "vitest";
import {
  classifyCodexSubscriptionTarget,
  forwardedCodexRawRequestHeaders,
  safeCodexSubscriptionResponseHeaders
} from "../../src/core/gateway/codex-subscription-route.js";

const CAP = "C".repeat(43);
const PREFIX = `/__compaction/codex/${CAP}/backend-api/codex`;

describe("Codex ChatGPT-subscription raw route", () => {
  it("accepts only the observed bounded models and responses targets", () => {
    expect(classifyCodexSubscriptionTarget(`${PREFIX}/models?client_version=0.153.4`, "GET", CAP)).toEqual({
      route: "models", upstreamTarget: "/backend-api/codex/models?client_version=0.153.4"
    });
    expect(classifyCodexSubscriptionTarget(`${PREFIX}/responses`, "POST", CAP)).toEqual({
      route: "responses", upstreamTarget: "/backend-api/codex/responses"
    });
    for (const [target, method] of [
      [`${PREFIX}/responses?x=1`, "POST"],
      [`${PREFIX}/models`, "GET"],
      [`${PREFIX}/models?client_version=0.153.4&x=1`, "GET"],
      [`${PREFIX}/auth`, "POST"],
      [`${PREFIX}/../responses`, "POST"],
      [`${PREFIX}%2fresponses`, "POST"],
      [`/__compaction/codex/${"D".repeat(43)}/backend-api/codex/responses`, "POST"],
      [`${PREFIX}/responses`, "GET"]
    ]) expect(classifyCodexSubscriptionTarget(target, method, CAP)).toBeNull();
  });

  it("forwards only observed Codex fields, preserving raw duplicates and opaque auth", () => {
    const auth = "Bearer SENTINEL_AUTH";
    const account = "SENTINEL_ACCOUNT";
    const rawHeaders = [
      "Authorization", auth,
      "ChatGPT-Account-Id", account,
      "X-Codex-Beta-Features", "a",
      "X-Codex-Beta-Features", "b",
      "Cookie", "SENTINEL_COOKIE",
      "Proxy-Authorization", "SENTINEL_PROXY",
      "X-Compaction-Mode", "apply",
      "X-Unknown", "SENTINEL_UNKNOWN",
      "Connection", "thread-id",
      "Thread-Id", "SENTINEL_THREAD",
      "Host", "local.invalid"
    ];
    const result = forwardedCodexRawRequestHeaders({ rawHeaders }, "chatgpt.com", 4);
    expect(result).toEqual([
      "Authorization", auth,
      "ChatGPT-Account-Id", account,
      "X-Codex-Beta-Features", "a",
      "X-Codex-Beta-Features", "b",
      "Host", "chatgpt.com",
      "Content-Length", "4"
    ]);
  });

  it("rejects redirects and strips response credentials, nominated fields, and unknowns", () => {
    expect(safeCodexSubscriptionResponseHeaders(307, ["Location", "/backend-api/codex/responses"])).toBeNull();
    expect(safeCodexSubscriptionResponseHeaders(200, [
      "Content-Type", "text/event-stream",
      "Set-Cookie", "SENTINEL_RESPONSE_COOKIE",
      "Authorization", "SENTINEL_RESPONSE_AUTH",
      "X-Request-Id", "keep",
      "Connection", "x-request-id",
      "X-Unknown", "SENTINEL_RESPONSE_UNKNOWN"
    ])).toEqual(["Content-Type", "text/event-stream"]);
  });
});
