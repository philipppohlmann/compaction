import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureClaudeCodeFromHook } from "../../src/cli/commands/capture-claude-code.js";
import { createUsageMetadata, missingUsageMetadata } from "../../src/core/usage-metadata.js";
import { readActivityEvents } from "../../src/core/activity-store.js";
import { validateActivityEventForStore } from "../../src/core/activity-store.js";

/**
 * `capture claude-code --from-hook` behavior (deps injected). Covers: missing transcript_path (no-op),
 * content-free record written, idempotent dedup (second identical Stop does not double-record), missing
 * usage (null tokens, not 0), and fail-open (a normalize crash never throws).
 */
async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cc-hook-"));
}

const NOW = () => "2026-06-29T00:00:00.000Z";
const noHosted = () => false;

const providerUsage = createUsageMetadata({
  inputTokens: 1000,
  outputTokens: 200,
  totalTokens: 1200,
  providerReportedTokens: true,
  estimatedTokens: false,
  model: "claude-x",
  provider: "anthropic"
});

afterEach(() => vi.restoreAllMocks());

async function recordsIn(cwd: string): Promise<string[]> {
  try {
    return await readdir(path.join(cwd, ".compaction", "hooks", "claude-code", "records"));
  } catch {
    return [];
  }
}

describe("captureClaudeCodeFromHook", () => {
  it("missing transcript_path → records nothing", async () => {
    const cwd = await tempCwd();
    await captureClaudeCodeFromHook({}, {
      cwd,
      now: NOW,
      hostedConfigured: noHosted,
      readStdin: async () => JSON.stringify({ session_id: "s1", hook_event_name: "Stop" }),
      normalize: async () => {
        throw new Error("should not be called");
      }
    });
    expect(await recordsIn(cwd)).toHaveLength(0);
  });

  it("writes a content-free record (no message content, no last_assistant_message)", async () => {
    const cwd = await tempCwd();
    await captureClaudeCodeFromHook({}, {
      cwd,
      now: NOW,
      hostedConfigured: noHosted,
      readStdin: async () => JSON.stringify({ session_id: "s1", transcript_path: "/x/y.jsonl", last_assistant_message: "SECRET ANSWER TEXT" }),
      normalize: async () => ({ usage: providerUsage, messageCount: 8, fingerprint: "fp-abc" })
    });
    const files = await recordsIn(cwd);
    expect(files).toHaveLength(1);
    const body = await readFile(path.join(cwd, ".compaction", "hooks", "claude-code", "records", files[0]), "utf8");
    expect(body).not.toMatch(/SECRET ANSWER TEXT/);
    expect(body).not.toMatch(/last_assistant_message/);
    const rec = JSON.parse(body);
    expect(rec.providerReported).toBe(true);
    expect(rec.tokenSource).toBe("provider-reported");
    expect(rec.inputTokens).toBe(1000);
  });

  it("idempotent: a second identical Stop does not double-record", async () => {
    const cwd = await tempCwd();
    const deps = {
      cwd,
      now: NOW,
      hostedConfigured: noHosted,
      readStdin: async () => JSON.stringify({ session_id: "s1", transcript_path: "/x/y.jsonl" }),
      normalize: async () => ({ usage: providerUsage, messageCount: 8, fingerprint: "fp-abc" })
    };
    await captureClaudeCodeFromHook({}, deps);
    await captureClaudeCodeFromHook({}, deps);
    expect(await recordsIn(cwd)).toHaveLength(1);
    const ledger = JSON.parse(await readFile(path.join(cwd, ".compaction", "hooks", "claude-code", "ledger.json"), "utf8"));
    expect(ledger.entries).toHaveLength(1);
  });

  it("a new turn (changed state) records a new entry", async () => {
    const cwd = await tempCwd();
    const base = { cwd, now: NOW, hostedConfigured: noHosted, readStdin: async () => JSON.stringify({ session_id: "s1", transcript_path: "/x/y.jsonl" }) };
    await captureClaudeCodeFromHook({}, { ...base, normalize: async () => ({ usage: providerUsage, messageCount: 8, fingerprint: "fp-abc" }) });
    await captureClaudeCodeFromHook({}, { ...base, normalize: async () => ({ usage: providerUsage, messageCount: 12, fingerprint: "fp-def" }) });
    expect(await recordsIn(cwd)).toHaveLength(2);
  });

  it("missing usage → token counts null, providerReported false (still records)", async () => {
    const cwd = await tempCwd();
    await captureClaudeCodeFromHook({}, {
      cwd,
      now: NOW,
      hostedConfigured: noHosted,
      readStdin: async () => JSON.stringify({ session_id: "s2", transcript_path: "/x/z.jsonl" }),
      normalize: async () => ({ usage: missingUsageMetadata({ model: "claude-x", provider: "anthropic" }), messageCount: 4, fingerprint: "fp-z" })
    });
    const files = await recordsIn(cwd);
    expect(files).toHaveLength(1);
    const rec = JSON.parse(await readFile(path.join(cwd, ".compaction", "hooks", "claude-code", "records", files[0]), "utf8"));
    expect(rec.inputTokens).toBeNull();
    expect(rec.outputTokens).toBeNull();
    expect(rec.providerReported).toBe(false);
  });

  it("dry-run writes nothing", async () => {
    const cwd = await tempCwd();
    await captureClaudeCodeFromHook({ dryRun: true }, {
      cwd,
      now: NOW,
      hostedConfigured: noHosted,
      readStdin: async () => JSON.stringify({ session_id: "s1", transcript_path: "/x/y.jsonl" }),
      normalize: async () => ({ usage: providerUsage, messageCount: 8, fingerprint: "fp-abc" })
    });
    expect(await recordsIn(cwd)).toHaveLength(0);
  });

  it("fail-open: a normalize crash never throws", async () => {
    const cwd = await tempCwd();
    await expect(
      captureClaudeCodeFromHook({}, {
        cwd,
        now: NOW,
        hostedConfigured: noHosted,
        readStdin: async () => JSON.stringify({ session_id: "s1", transcript_path: "/x/y.jsonl" }),
        normalize: async () => {
          throw new Error("boom");
        }
      })
    ).resolves.toBeUndefined();
    expect(await recordsIn(cwd)).toHaveLength(0);
  });
});

/**
 * The always-on BRIDGE: the from-hook capture ALSO appends ONE
 * metrics-only activity event to `.compaction/activity/`, this is what makes a subsequent Claude
 * Code session appear in `compaction activity` with no manual import.
 */
async function activityIn(cwd: string) {
  return readActivityEvents(path.join(cwd, ".compaction", "activity"));
}

describe("captureClaudeCodeFromHook - activity bridge", () => {
  it("writes ONE metrics-only activity event (claude_code / anthropic, provider-reported, auto-apply OFF)", async () => {
    const cwd = await tempCwd();
    await captureClaudeCodeFromHook({}, {
      cwd,
      now: NOW,
      hostedConfigured: noHosted,
      readStdin: async () => JSON.stringify({ session_id: "s1", transcript_path: "/x/y.jsonl", last_assistant_message: "SECRET" }),
      normalize: async () => ({ usage: providerUsage, messageCount: 8, fingerprint: "fp-abc" })
    });
    const { events } = await activityIn(cwd);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.surface).toBe("claude_code");
    expect(e.provider).toBe("anthropic");
    // provider-reported axes with real counts (never a silent zero).
    expect(e.token_source?.input.source).toBe("provider-reported");
    expect(e.token_source?.output.source).toBe("provider-reported");
    expect(e.input_before).toBe(1000);
    expect(e.output_before).toBe(200);
    // measure-only honesty.
    expect(e.approval_status).toBe("not-required");
    expect(e.auto_apply?.applied_automatically).toBe(false);
    expect(e.auto_apply?.preference).toBe("ask-each-time");
    expect(e.sync_status).toBe("local-only");
    expect(e.recovery?.original_retained).toBe(false);
    // deterministic id shape + validates clean against the store contract.
    expect(e.activity_event_id).toMatch(/^act-[0-9a-f]{24}$/);
    expect(validateActivityEventForStore(e).problems).toEqual([]);
    // CONTENT-FREE: the raw log carries no message/secret text.
    const raw = await readFile(path.join(cwd, ".compaction", "activity", "activity.jsonl"), "utf8");
    expect(raw).not.toContain("SECRET");
  });

  it("missing usage → activity axes UNAVAILABLE-with-reason (never provider-reported, no silent zero)", async () => {
    const cwd = await tempCwd();
    await captureClaudeCodeFromHook({}, {
      cwd,
      now: NOW,
      hostedConfigured: noHosted,
      readStdin: async () => JSON.stringify({ session_id: "s2", transcript_path: "/x/z.jsonl" }),
      normalize: async () => ({ usage: missingUsageMetadata({ model: "claude-x", provider: "anthropic" }), messageCount: 4, fingerprint: "fp-z" })
    });
    const { events } = await activityIn(cwd);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.token_source?.input.source).toBe("unavailable");
    expect(e.token_source?.output.source).toBe("unavailable");
    expect(e.token_source?.input.unavailable_reason).toBeTruthy();
    // no silent zero, an unavailable axis carries NO numeric count.
    expect(e.input_before).toBeUndefined();
    expect(e.output_before).toBeUndefined();
    expect(validateActivityEventForStore(e).problems).toEqual([]);
  });

  it("dedupe: the same session captured twice yields ONE activity event", async () => {
    const cwd = await tempCwd();
    const deps = {
      cwd,
      now: NOW,
      hostedConfigured: noHosted,
      readStdin: async () => JSON.stringify({ session_id: "s1", transcript_path: "/x/y.jsonl" }),
      normalize: async () => ({ usage: providerUsage, messageCount: 8, fingerprint: "fp-abc" })
    };
    await captureClaudeCodeFromHook({}, deps);
    await captureClaudeCodeFromHook({}, deps);
    const { events } = await activityIn(cwd);
    expect(events).toHaveLength(1);
  });

  it("dry-run writes NO activity event", async () => {
    const cwd = await tempCwd();
    await captureClaudeCodeFromHook({ dryRun: true }, {
      cwd,
      now: NOW,
      hostedConfigured: noHosted,
      readStdin: async () => JSON.stringify({ session_id: "s1", transcript_path: "/x/y.jsonl" }),
      normalize: async () => ({ usage: providerUsage, messageCount: 8, fingerprint: "fp-abc" })
    });
    const { events } = await activityIn(cwd);
    expect(events).toHaveLength(0);
  });
});
