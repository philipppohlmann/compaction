import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProductMode } from "../../src/core/onboarding-preferences.js";
import { computeStatusLine, STATUS_LINE_PLACEHOLDER } from "../../src/cli/commands/statusline.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";

/**
 * `compaction statusline` core (`computeStatusLine`). This is the Claude Code status-line surface - the
 * ONLY per-turn VISIBLE surface for Claude Code. Contract: reads the session JSON on stdin, prints ONE
 * content-free canonical line from the latest gateway receipt; falls back to an output-only line from the
 * stdin token counts; else a quiet placeholder. Fail-open, content-free, kill-switch honored.
 */

/**
 * An EMPTY config dir, so these cases read no local state at all.
 *
 * `env: ISOLATED` is NOT isolation: `compactionConfigDir` falls through `COMPACTION_CONFIG_DIR` then `HOME`
 * to `homedir()`, so a bare `{}` made these assertions read the DEVELOPER'S real `~/.compaction`. A
 * real shaped turn on the machine writes `last-shaping-decision.json`, and for the 5 minutes it stays
 * fresh the suite went red on tests that had asserted "no local state" all along. Pin the dir instead.
 */
const ISOLATED = { COMPACTION_CONFIG_DIR: mkdtempSync(join(tmpdir(), "statusline-isolated-")) };

function receipt(overrides: Partial<GatewayReceipt> = {}): GatewayReceipt {
  return {
    receipt_id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    captured_at: "2026-07-30T10:00:00.000Z",
    provider: "anthropic",
    model: "claude-opus-4",
    endpoint: "/v1/messages",
    mode: "record",
    upstream_status: 200,
    model_visible_bytes_changed: false,
    tokens: { prompt_input: 22012, output: 412 },
    fresh_billed_input_reduction: { available: false, note: "x" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "x" },
    claim_scope: "run-scoped",
    approval_status: "not-required",
    sync_status: "local-only",
    content_uploaded: false,
    label: "x",
    ...overrides
  };
}

/** The content-free shape: a canonical line carries only the prefix, count/label clauses, and a short id. */
const CONTENT_FREE_LINE = /^compaction( · [^·]+)+$/;

describe("computeStatusLine", () => {
  it("renders the input+output line from a gateway receipt", async () => {
    const line = await computeStatusLine('{"cwd":"/some/proj"}', {
      readReceipt: async () => receipt(),
      // Pin an empty config dir so the product mode resolves to the default `observe` hermetically.
      env: { COMPACTION_CONFIG_DIR: "/nonexistent-compaction-statusline-test" }
    });
    // Open-core grammar: default product mode is `observe`, so the gateway line reads `observed input N`
    // (Open never compacts input) with the `apply off` tier label.
    expect(line).toBe("compaction · observed input 22,012 · output 412 · apply off · id a1b2c3d4");
  });

  it("prefers the stdin cwd for the receipt lookup", async () => {
    let seen: string | undefined;
    await computeStatusLine('{"cwd":"/from/stdin"}', {
      readReceipt: async (cwd) => {
        seen = cwd;
        return undefined;
      },
      cwd: "/fallback",
      env: ISOLATED
    });
    expect(seen).toBe("/from/stdin");
  });

  it("falls back to an output-only line from stdin tokens when no receipt exists", async () => {
    const line = await computeStatusLine('{"cwd":"/x","usage":{"output_tokens":88,"provider_reported":true}}', {
      readReceipt: async () => undefined,
      env: ISOLATED
    });
    // Open-core grammar: on the hook-only fallback, shaping is active by default (no kill switch), so the
    // honest per-turn label is `basic shaping`. The source label is not rendered.
    expect(line).toBe("compaction · output 88 · basic shaping");
  });

  it("labels the stdin fallback local-estimate unless the payload says provider_reported", async () => {
    const line = await computeStatusLine('{"cwd":"/x","output_tokens":50}', {
      readReceipt: async () => undefined,
      env: ISOLATED
    });
    expect(line).toBe("compaction · output 50 · basic shaping");
  });

  it("hook-only fallback with shaping OFF (kill switch) → `apply off` label", async () => {
    const line = await computeStatusLine('{"cwd":"/x","output_tokens":50}', {
      readReceipt: async () => undefined,
      env: { COMPACTION_SHAPING_HOOKS: "0" }
    });
    expect(line).toBe("compaction · output 50 · apply off");
  });

  it("prints a quiet placeholder when there is nothing to report", async () => {
    const line = await computeStatusLine('{"cwd":"/x"}', { readReceipt: async () => undefined, env: ISOLATED });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
  });

  it("COMPACTION_RECEIPT_LINE=0 → prints nothing (undefined)", async () => {
    const line = await computeStatusLine('{"cwd":"/x"}', {
      readReceipt: async () => receipt(),
      env: { COMPACTION_RECEIPT_LINE: "0" }
    });
    expect(line).toBeUndefined();
  });

  it("malformed stdin → safe placeholder, never throws", async () => {
    const line = await computeStatusLine("not json at all {{{", { readReceipt: async () => undefined, env: ISOLATED });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
  });

  it("empty stdin → safe placeholder", async () => {
    const line = await computeStatusLine("", { readReceipt: async () => undefined, env: ISOLATED });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
  });

  it("a throwing receipt reader is swallowed (fail-open → placeholder)", async () => {
    const line = await computeStatusLine('{"cwd":"/x"}', {
      readReceipt: async () => {
        throw new Error("disk exploded");
      },
      env: ISOLATED
    });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
  });

  it("output is content-free-shaped: no path, prompt, or response bytes leak", async () => {
    // Feed a payload whose fields would leak content IF the code ever echoed stdin. It must not.
    const stdin = JSON.stringify({
      cwd: "/secret/project/path",
      transcript: "user asked to delete prod database",
      last_assistant_message: "here is your AWS key AKIASECRET",
      usage: { output_tokens: 412 }
    });
    const line = await computeStatusLine(stdin, {
      readReceipt: async () => receipt(),
      env: { COMPACTION_CONFIG_DIR: "/nonexistent-compaction-statusline-test" }
    });
    expect(line).toBeDefined();
    expect(line!).toMatch(CONTENT_FREE_LINE);
    // No content from stdin appears in the line.
    expect(line!).not.toContain("secret");
    expect(line!).not.toContain("prod");
    expect(line!).not.toContain("AKIA");
    expect(line!).not.toContain("/");
  });
});

/**
 * THE GATEWAY IS A SHAPING SURFACE TOO (Open `basic` gateway wiring).
 *
 * The status line is the ONLY per-turn surface Claude Code actually renders, and its shaped-turn
 * evidence used to come solely from `lastTurnWasShaped` — a file only the tool's PROMPT HOOK writes.
 * So on a gateway-routed device with no hooks installed (exactly the device Open basic gateway shaping
 * exists to serve) the gateway would shape the turn and this line would still show a plain `output N`,
 * making the feature look like a no-op on the one surface that matters.
 *
 * These pin that the RECEIPT is now accepted as evidence, and that the tier label describes the TURN
 * rather than the stored preference.
 */
describe("computeStatusLine — gateway-shaped turns (no hook state on disk)", () => {
  const noHookState = { COMPACTION_CONFIG_DIR: "/nonexistent-compaction-gateway-shaped-test" };

  /** A receipt for a turn the GATEWAY shaped: mutated, output-shaping applied, no input compaction. */
  function shapedReceipt(): GatewayReceipt {
    return receipt({
      mode: "apply",
      request_mutated: true,
      applied_components: ["output-shaping"],
      approval_status: "auto-applied-by-policy",
      recovery_id: "rec-1",
      model_visible_bytes_changed: true
    });
  }

  it("labels a gateway-shaped turn `basic shaping` even with no hook state", async () => {
    const line = await computeStatusLine('{"cwd":"/some/proj"}', {
      readReceipt: async () => shapedReceipt(),
      env: { ...noHookState, COMPACTION_PRODUCT_MODE_TEST_ONLY: "" }
    });
    // The default persisted mode in an empty config dir is `observe`, and the turn WAS shaped, so the
    // honest rendering is to omit the label rather than assert `apply off` against the evidence.
    expect(line).not.toContain("apply off");
    expect(line).toContain("22,012");
    // The shipped prior renders the arrow even on a fresh device with no hook state — and, per G7, the
    // statusline carries the SAME `est. · default prior` provenance the receipt line does (E4/E5:
    // the same turn cannot read as measured on one surface and a prior on another).
    expect(line).toMatch(/output [\d,]+→412 \(−\d+%, est\. · default prior\)/);
    // KNOWN VOCABULARY INCONSISTENCY, pinned deliberately rather than quietly fixed. Suppressing the
    // tier label also drops the Open `observed input` prefix, because the shared renderer derives the
    // input vocabulary from the same `tier` argument as the label. So a labelled line reads
    // `observed input N` and an unlabelled one reads `input N`. Both are plain counts and neither
    // claims a reduction, so this is a wording question, not a claim defect — and changing shared
    // shared user-facing vocabulary is a deliberate product decision, not one to make inside a test.
    expect(line).toContain("input 22,012");
  });

  it("does NOT claim `basic shaping` on a turn the receipt shows was not shaped", async () => {
    // THE PRECISE OVERCLAIM THIS CHANGE REMOVES. The label used to come from the stored preference, so
    // a user whose persisted mode is `basic` saw `basic shaping` on EVERY turn — including turns that
    // nothing had shaped (a held planning turn, an unsupported request shape, a record-mode turn).
    // The mode must genuinely be `basic` here or the test proves nothing: with the default `observe`
    // it would pass against the old code too.
    const dir = mkdtempSync(join(tmpdir(), "statusline-basic-"));
    try {
      const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
      writeProductMode("basic", env);
      const line = await computeStatusLine('{"cwd":"/some/proj"}', {
        readReceipt: async () => receipt(), // plain record turn: nothing applied, nothing mutated
        env
      });
      expect(line, "no per-turn evidence ⇒ no shaping claim").not.toContain("basic shaping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DOES claim `basic shaping` for a basic-mode user when the receipt proves the gateway shaped it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "statusline-basic-shaped-"));
    try {
      const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
      writeProductMode("basic", env);
      const line = await computeStatusLine('{"cwd":"/some/proj"}', {
        readReceipt: async () => shapedReceipt(),
        env
      });
      expect(line).toContain("basic shaping");
      expect(line).toContain("observed input 22,012"); // Open vocabulary: a count, never a reduction
      // Anchored to the INPUT clause: the old `/input .*→/` spanned into the output arrow.
      expect(line).not.toMatch(/observed input [\d,]+→/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps `apply off` for an observe turn with no shaping anywhere (the honest observe label)", async () => {
    const line = await computeStatusLine('{"cwd":"/some/proj"}', {
      readReceipt: async () => receipt(),
      env: noHookState
    });
    expect(line).toContain("apply off");
  });
});
