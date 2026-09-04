import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexSessionCorrelationId,
  gatewaySessionCorrelation,
  resetSessionCorrelationCache,
  sessionCorrelationId
} from "../../src/core/gateway/session-correlation.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const CLAUDE_SESSION = "claude-session-from-body";
const roots: string[] = [];

afterEach(() => {
  resetSessionCorrelationCache();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function deviceEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "gateway-codex-correlation-"));
  roots.push(root);
  return { COMPACTION_CONFIG_DIR: root } as NodeJS.ProcessEnv;
}

function requestBody(): string {
  return JSON.stringify({
    model: "gpt-test",
    metadata: { user_id: JSON.stringify({ session_id: CLAUDE_SESSION }) },
    input: "fixture-only"
  });
}

describe("gateway workflow session correlation", () => {
  it("workflow=codex accepts one valid session-id and ignores the Claude body identity", () => {
    const env = deviceEnv();
    const actual = gatewaySessionCorrelation({
      workflow: "codex",
      rawHeaders: ["Content-Type", "application/json", "Session-Id", SESSION],
      bodyText: requestBody(),
      env
    });
    expect(actual).toBe(codexSessionCorrelationId(SESSION, env));
    expect(actual).not.toBe(sessionCorrelationId(CLAUDE_SESSION, env));
  });

  it("workflow=codex fails closed on missing, malformed, and duplicate session-id headers", () => {
    const env = deviceEnv();
    for (const rawHeaders of [
      ["Content-Type", "application/json"],
      ["Content-Type", "application/json", "Session-Id", "bad value"],
      ["Content-Type", "application/json", "Session-Id", SESSION, "session-id", SESSION]
    ]) {
      expect(gatewaySessionCorrelation({
        workflow: "codex",
        rawHeaders,
        bodyText: requestBody(),
        env
      })).toBeUndefined();
    }
  });

  it("non-Codex and Claude workflows retain body correlation and never borrow the Codex header", () => {
    const env = deviceEnv();
    for (const workflow of [undefined, "claude-code"]) {
      const actual = gatewaySessionCorrelation({
        ...(workflow ? { workflow } : {}),
        rawHeaders: ["Content-Type", "application/json", "Session-Id", SESSION],
        bodyText: requestBody(),
        env
      });
      expect(actual).toBe(sessionCorrelationId(CLAUDE_SESSION, env));
      expect(actual).not.toBe(codexSessionCorrelationId(SESSION, env));
    }
  });
});
