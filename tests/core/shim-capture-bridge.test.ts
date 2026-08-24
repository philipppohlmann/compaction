import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bridgeCodexShimActivity, bridgeCursorShimActivity } from "../../src/core/shim-capture-bridge.js";

/** Synthetic-only: every test writes into a tmp cwd's `.compaction/activity`, never a real one. */
let cwd: string;

function activityRaw(): string {
  const p = path.join(cwd, ".compaction", "activity", "activity.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "shim-bridge-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const CODEX_OUTPUT_WITH_USAGE = [
  '{"type":"item.completed","item":{"type":"agent_message","text":"SECRET_ASSISTANT_TEXT_omega"}}',
  '{"type":"turn.completed","thread_id":"th_1","model":"gpt-5-codex","usage":{"input_tokens":1000,"cached_input_tokens":100,"output_tokens":200,"reasoning_output_tokens":10}}'
].join("\n");

const CODEX_OUTPUT_NO_USAGE = '{"type":"item.completed","item":{"type":"agent_message","text":"no usage block here"}}';

const CURSOR_OUTPUT = '{"type":"result","session_id":"cur_1","result":"SECRET_CURSOR_ANSWER_psi the answer"}';
const CURSOR_OUTPUT_NO_RESULT = '{"type":"other","session_id":"cur_2"}';

describe("codex shim → activity bridge (provider-reported honesty)", () => {
  it("records provider-reported input/output as COUNTS, content-free, measure-only", async () => {
    const { result, tokenMetadataStatus } = await bridgeCodexShimActivity({ rawOutput: CODEX_OUTPUT_WITH_USAGE, cwd });
    expect(result.appended).toBe(true);
    expect(tokenMetadataStatus).toBe("present");

    const event = JSON.parse(activityRaw().trim());
    expect(event.surface).toBe("codex");
    expect(event.provider).toBe("openai");
    expect(event.token_source.input.source).toBe("provider-reported");
    expect(event.token_source.output.source).toBe("provider-reported");
    expect(event.input_before).toBe(1000);
    expect(event.output_before).toBe(200);
    // measure-only + auto-apply OFF.
    expect(event.approval_status).toBe("not-required");
    expect(event.auto_apply).toEqual({ eligible: false, preference: "ask-each-time", applied_automatically: false });
    expect(event.recovery.original_retained).toBe(false);
    expect(event.sync_status).toBe("local-only");
    // CONTENT-FREE: the assistant text never reaches the store.
    expect(activityRaw()).not.toContain("SECRET_ASSISTANT_TEXT_omega");
  });

  it("missing turn.completed.usage → unavailable-with-reason, no silent zero, never invented", async () => {
    const { result, tokenMetadataStatus } = await bridgeCodexShimActivity({ rawOutput: CODEX_OUTPUT_NO_USAGE, cwd });
    expect(result.appended).toBe(true);
    expect(tokenMetadataStatus).toBe("missing");
    const event = JSON.parse(activityRaw().trim());
    expect(event.token_source.input.source).toBe("unavailable");
    expect(event.token_source.output.source).toBe("unavailable");
    expect(event.token_source.input.unavailable_reason).toContain("turn.completed.usage");
    expect(event.input_before).toBeUndefined();
    expect(event.output_before).toBeUndefined();
  });

  it("dedupes a re-parse of the SAME run (deterministic id) - one line, reported no-op", async () => {
    const first = await bridgeCodexShimActivity({ rawOutput: CODEX_OUTPUT_WITH_USAGE, cwd });
    const second = await bridgeCodexShimActivity({ rawOutput: CODEX_OUTPUT_WITH_USAGE, cwd });
    expect(first.result.appended).toBe(true);
    expect(second.result.appended).toBe(false);
    expect(activityRaw().trim().split("\n")).toHaveLength(1);
  });
});

describe("cursor shim → activity bridge (local-estimate only)", () => {
  it("output is LOCAL-ESTIMATE from the result field - NEVER provider-reported; content-free", async () => {
    const { result, outputStatus } = await bridgeCursorShimActivity({
      rawOutput: CURSOR_OUTPUT,
      commandParts: ["cursor-agent", "-p", "SECRET_CURSOR_PROMPT_tau improve", "--output-format", "json"],
      cwd
    });
    expect(result.appended).toBe(true);
    expect(outputStatus).toBe("present");
    const event = JSON.parse(activityRaw().trim());
    expect(event.surface).toBe("cursor");
    expect(event.provider).toBe("cursor");
    expect(event.token_source.input.source).toBe("local-estimate");
    expect(event.token_source.output.source).toBe("local-estimate");
    // A local-estimate output is an ESTIMATE (never a provider-reported count).
    expect(event.output_estimate).toBeGreaterThan(0);
    expect(event.output_before).toBeUndefined();
    expect(event.input_before).toBeGreaterThan(0);
    // CONTENT-FREE: neither the prompt nor the result text reaches the store.
    expect(activityRaw()).not.toContain("SECRET_CURSOR_ANSWER_psi");
    expect(activityRaw()).not.toContain("SECRET_CURSOR_PROMPT_tau");
  });

  it("no separable result → output unavailable-with-reason (never a silent zero, never provider-reported)", async () => {
    const { result, outputStatus } = await bridgeCursorShimActivity({
      rawOutput: CURSOR_OUTPUT_NO_RESULT,
      commandParts: ["cursor-agent", "-p", "hi", "--output-format", "json"],
      cwd
    });
    expect(result.appended).toBe(true);
    expect(outputStatus).toBe("unavailable");
    const event = JSON.parse(activityRaw().trim());
    expect(event.token_source.output.source).toBe("unavailable");
    expect(event.token_source.output.unavailable_reason).toBeTruthy();
    expect(event.token_source.output.source).not.toBe("provider-reported");
    expect(event.output_before).toBeUndefined();
    expect(event.output_estimate).toBeUndefined();
  });
});
