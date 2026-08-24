import { describe, expect, it } from "vitest";
import { classifyClaudeSubscriptionTarget, safeClaudeSubscriptionResponseHeaders } from "../../src/core/gateway/claude-subscription-route.js";

const CAP = "A".repeat(43);

describe("Claude subscription raw request-target allowlist", () => {
  it("maps only the exact initial route table and strips the local capability", () => {
    expect(classifyClaudeSubscriptionTarget(`/__compaction/claude/${CAP}`, "HEAD", CAP)).toEqual({ route: "head", upstreamTarget: "/" });
    expect(classifyClaudeSubscriptionTarget(`/__compaction/claude/${CAP}/v1/messages?beta=true`, "POST", CAP)).toEqual({
      route: "messages",
      upstreamTarget: "/v1/messages?beta=true"
    });
    expect(classifyClaudeSubscriptionTarget(`/__compaction/claude/${CAP}/v1/messages/count_tokens`, "POST", CAP)).toEqual({
      route: "count-tokens",
      upstreamTarget: "/v1/messages/count_tokens"
    });
  });

  it.each([
    ["absolute form", `https://evil.invalid/__compaction/claude/${CAP}/v1/messages`],
    ["network-path form", `//evil.invalid/__compaction/claude/${CAP}/v1/messages`],
    ["encoded slash", `/__compaction/claude/${CAP}%2fv1/messages`],
    ["encoded backslash", `/__compaction/claude/${CAP}%5cv1/messages`],
    ["encoded dot", `/__compaction/claude/${CAP}/%2e/v1/messages`],
    ["raw backslash", `/__compaction/claude/${CAP}\\v1/messages`],
    ["dot segment", `/__compaction/claude/${CAP}/../v1/messages`],
    ["unknown capability", `/__compaction/claude/${"B".repeat(43)}/v1/messages`],
    ["auth path", `/__compaction/claude/${CAP}/api/oauth/token`],
    ["admin path", `/__compaction/claude/${CAP}/v1/admin`],
    ["unknown query", `/__compaction/claude/${CAP}/v1/messages?redirect=https://evil.invalid`]
  ])("rejects %s without producing an upstream target", (_label, target) => {
    expect(classifyClaudeSubscriptionTarget(target, "POST", CAP)).toBeNull();
  });
});

describe("Claude subscription redirect boundary", () => {
  it("relays relative and exact pinned-origin locations unchanged", () => {
    expect(safeClaudeSubscriptionResponseHeaders(307, ["Location", "/v1/messages"], "https://api.anthropic.com")).toEqual(["Location", "/v1/messages"]);
    expect(safeClaudeSubscriptionResponseHeaders(307, ["Location", "https://api.anthropic.com/v1/messages"], "https://api.anthropic.com")).toEqual([
      "Location", "https://api.anthropic.com/v1/messages"
    ]);
  });

  it.each([
    ["cross origin", "https://evil.invalid/collect"],
    ["scheme downgrade", "http://api.anthropic.com/v1/messages"],
    ["userinfo", "https://token@api.anthropic.com/v1/messages"],
    ["malformed", "http://[invalid"]
  ])("rejects %s redirects locally", (_label, location) => {
    expect(safeClaudeSubscriptionResponseHeaders(307, ["Location", location], "https://api.anthropic.com")).toBeNull();
  });
});
