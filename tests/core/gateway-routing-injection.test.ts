import { describe, it, expect } from "vitest";
import {
  injectionEnv,
  defaultUpstreamFor,
  normalizeEffectiveUpstream,
  parseRoutedWorkflowIdentity,
  routedCommand,
  validateRoutedWorkflowProvider,
  ROUTE_COMMANDS
} from "../../src/cli/commands/dev.js";
import { adapterForUpstream } from "../../src/core/gateway/provider-adapter.js";

/**
 * Provider-aware Gateway ROUTING injection. These are pure, content-free unit
 * assertions on the env the routing path injects into a child (never a key), the workflow identity the
 * established Claude Code/Codex route implies, and the provider-aware upstream default that selects the
 * adapter. The end-to-end child/spawn behavior is covered separately in
 * tests/cli/gateway-anthropic-routing.test.ts.
 */
describe("injectionEnv - provider-aware base-url injection (base only, never a key)", () => {
  const base = "http://127.0.0.1:8787";

  it("openai (default): OPENAI_BASE_URL/OPENAI_API_BASE carry the /v1 suffix the OpenAI SDKs expect", () => {
    const env = injectionEnv(base, "openai");
    expect(env.OPENAI_BASE_URL).toBe(`${base}/v1`);
    expect(env.OPENAI_API_BASE).toBe(`${base}/v1`);
    // No key is ever injected.
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("default provider is openai (omitted arg matches the openai injection)", () => {
    expect(injectionEnv(base)).toEqual(injectionEnv(base, "openai"));
  });

  it("anthropic: ANTHROPIC_BASE_URL is the base with NO /v1 (Claude Code appends /v1/messages itself)", () => {
    const env = injectionEnv(base, "anthropic");
    expect(env.ANTHROPIC_BASE_URL).toBe(base);
    expect(env.ANTHROPIC_BASE_URL).not.toContain("/v1");
    // Anthropic routing does NOT set the OpenAI base-url envs, and never a key.
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_API_BASE).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("unknown provider falls back to the OpenAI-compatible injection (never a GUESSED env var name)", () => {
    expect(injectionEnv(base, "totally-unknown")).toEqual(injectionEnv(base, "openai"));
  });
});

describe("explicit routed workflow identity", () => {
  it("accepts only the two narrow identities and never infers from command text", () => {
    expect(parseRoutedWorkflowIdentity("codex")).toBe("codex");
    expect(parseRoutedWorkflowIdentity("claude-code")).toBe("claude-code");
    expect(parseRoutedWorkflowIdentity(undefined)).toBeUndefined();
    expect(() => parseRoutedWorkflowIdentity("cursor")).toThrow(/not implemented/);
  });

  it("binds each trusted identity to its established provider route", () => {
    expect(() => validateRoutedWorkflowProvider("codex", "openai")).not.toThrow();
    expect(() => validateRoutedWorkflowProvider("claude-code", "anthropic")).not.toThrow();
    expect(() => validateRoutedWorkflowProvider(undefined, "custom")).not.toThrow();
    expect(() => validateRoutedWorkflowProvider("codex", "anthropic")).toThrow(/requires provider 'openai'/);
    expect(() => validateRoutedWorkflowProvider("claude-code", "openai")).toThrow(/requires provider 'anthropic'/);
  });
});

describe("Codex CLI per-process routing config", () => {
  const base = "http://127.0.0.1:8787";

  it("injects the supported top-level openai_base_url override before Codex arguments", () => {
    expect(routedCommand(["codex", "exec", "--json", "hello"], base, "codex")).toEqual([
      "codex",
      "-c",
      'openai_base_url="http://127.0.0.1:8787/v1"',
      "exec",
      "--json",
      "hello"
    ]);
  });

  it("supports an absolute Codex executable path without changing user config or activating subscription routing", () => {
    const command = routedCommand(["/opt/tools/codex", "exec", "hello"], base, "codex");
    expect(command).toContain('openai_base_url="http://127.0.0.1:8787/v1"');
    expect(command.join(" ")).not.toContain("chatgpt_base_url");
  });

  it("does not alter generic commands or the Claude route", () => {
    expect(routedCommand(["node", "app.js"], base, "codex")).toEqual(["node", "app.js"]);
    expect(routedCommand(["claude"], base, "claude-code")).toEqual(["claude"]);
    expect(routedCommand(["node", "app.js"], base)).toEqual(["node", "app.js"]);
  });
});

describe("normalizeEffectiveUpstream", () => {
  it("normalizes equivalent URL spelling without collapsing distinct paths", () => {
    expect(normalizeEffectiveUpstream("HTTP://Example.COM:80/v1/")).toBe(normalizeEffectiveUpstream("http://example.com/v1"));
    expect(normalizeEffectiveUpstream("http://example.com/v1")).not.toBe(normalizeEffectiveUpstream("http://example.com/v2"));
  });
});

describe("defaultUpstreamFor - provider-aware upstream default selects the right adapter", () => {
  it("openai (default) → api.openai.com/v1 → OpenAI adapter", () => {
    expect(defaultUpstreamFor("openai")).toBe("https://api.openai.com/v1");
    expect(adapterForUpstream(defaultUpstreamFor("openai")).providerId).toBe("openai");
  });

  it("anthropic → api.anthropic.com (bare origin) → Anthropic adapter (real cache receipts path)", () => {
    expect(defaultUpstreamFor("anthropic")).toBe("https://api.anthropic.com");
    // The whole point of the bare-origin default: the gateway selects the Anthropic adapter by host.
    expect(adapterForUpstream(defaultUpstreamFor("anthropic")).providerId).toBe("anthropic");
  });
});

describe("Cursor stays BLOCKED - no fake routing is exposed (documented vendor gap)", () => {
  it("ROUTE_COMMANDS exposes codex + claude-code only, never a cursor route", () => {
    expect(ROUTE_COMMANDS.codex).toBe('compaction gateway run --workflow codex -- codex exec --json "<task>"');
    expect(ROUTE_COMMANDS["claude-code"]).toBe("compaction gateway run --provider anthropic --workflow claude-code -- claude");
    // No cursor key, and no exposed route command string mentions cursor: Cursor stays local-estimate/
    // activity-only (no base-url injection, no cache-proof claim).
    expect(Object.keys(ROUTE_COMMANDS)).not.toContain("cursor");
    for (const cmd of Object.values(ROUTE_COMMANDS)) expect(cmd.toLowerCase()).not.toContain("cursor");
  });
});
