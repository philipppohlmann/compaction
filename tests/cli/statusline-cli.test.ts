import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProductMode } from "../../src/core/onboarding-preferences.js";
import { seedOutputCalibration, TEST_OUTPUT_POLICY_VERSION } from "../helpers/output-calibration-fixture.js";
import { computeStatusLine, STATUS_LINE_PLACEHOLDER } from "../../src/cli/commands/statusline.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { recordShapingOutcome } from "../../src/core/output-shaping-turn-state.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";

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
 * real shaped turn on the machine writes a shaping record, and while it stayed valid the suite went red
 * on tests that had asserted "no local state" all along. Pin the dir instead.
 */
const ISOLATED = { COMPACTION_CONFIG_DIR: mkdtempSync(join(tmpdir(), "statusline-isolated-")) };

/**
 * Fold a real provider-reported A/B (1000 → 600 output tokens, a measured 40%) into `env`'s calibration
 * store, so the device has EARNED an output arrow.
 *
 * The output figure is gated on the device's OWN measurement — the shipped default prior renders none —
 * so a test about WHICH TURN may draw an arrow needs a device that is allowed to draw one at all.
 * Without this, every `toContain("→")` below would fail and every `not.toContain("→")` would pass for
 * the wrong reason, which is the more dangerous half.
 */
async function seedMeasuredCalibration(env: NodeJS.ProcessEnv): Promise<void> {
  await seedOutputCalibration(env, { model: "claude-opus-4" });
}

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
    output_shaping_policy_version: TEST_OUTPUT_POLICY_VERSION,
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
      // A gateway-shaped turn now records the durable provenance the arrow and the label both read.
      output_shaping_state: "attached-this-pass",
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
    // NO CONFIG DIR ⇒ NO FOLDED A/B ⇒ NO OUTPUT FIGURE, but the axis still says it EXISTS. This device
    // has measured nothing, so the size of what shaping removed is unknown — and `N/A` says exactly
    // that, in the slot a count would occupy, without being a count. (The shipped prior used to render
    // `755→412 (−47%, est. · default prior)` right here, on a machine with no store at all; no digit
    // reaches the before slot on either of the two renderings that replaced it.)
    expect(line).toContain("output N/A→412 (N/A%, est.)");
    expect(line).not.toMatch(/output [\d,]+→/);
    expect(line).not.toContain("755");
    expect(line).not.toContain("−47%");
    // KNOWN VOCABULARY INCONSISTENCY, pinned deliberately rather than quietly fixed. Suppressing the
    // tier label also drops the Open `observed input` prefix, because the shared renderer derives the
    // input vocabulary from the same `tier` argument as the label. So a labelled line reads
    // `observed input N` and an unlabelled one reads `input N`. Both are plain counts and neither
    // claims a reduction, so this is a wording question, not a claim defect — and changing shared
    // shared user-facing vocabulary is a deliberate product decision, not one to make inside a test.
    expect(line).toContain("input 22,012");
  });

  it("keeps the shaped output axis N/A when a legacy receipt lacks the exact policy version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "statusline-missing-policy-version-"));
    try {
      const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
      writeProductMode("basic", env);
      await seedMeasuredCalibration(env);
      const legacy = shapedReceipt();
      delete legacy.output_shaping_policy_version;
      const line = await computeStatusLine('{"cwd":"/some/proj"}', {
        readReceipt: async () => legacy,
        env
      });
      expect(line).toContain("output N/A→412 (N/A%, est.)");
      expect(line).not.toMatch(/output [\d,]+→412/);
      expect(line).toContain("basic shaping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

/**
 * SESSION-SCOPED HOOK EVIDENCE — the defect these pin was measured, not hypothesised.
 *
 * The status line asks one question per turn: was THIS turn shaped? It used to ask a single global file
 * with a 5-minute wall-clock window, which got the answer wrong in both directions on a real machine. A
 * 21-minute agentic turn lost its own evidence 16 minutes in and rendered plain for the rest of its life.
 * And every concurrent Claude Code session wrote that one file, so a session that HELD its turn could
 * render another session's `shape` and draw a calibrated saving off a turn nothing was injected into.
 *
 * Evidence is now filed under Claude Code's own `session_id`, which it passes on this very stdin, and a
 * turn ends when its session's Stop or next prompt says so — not when a timer says so.
 */
describe("computeStatusLine — per-session shaping evidence", () => {
  const SESSION_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const SESSION_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  const stdinFor = (sessionId: string) => JSON.stringify({ cwd: "/some/proj", session_id: sessionId });

  /** A record-mode receipt: the gateway observed this turn and mutated nothing. */
  const recordModeReceipt = () => receipt();

  /**
   * A config dir of its own per case. `mode` matters: the tier label is only spelled out for a device
   * that has actually chosen `basic` — an `observe` device with a shaped turn omits the label rather
   * than asserting `apply off` against the evidence.
   */
  async function isolatedConfigDir(mode: "observe" | "basic" = "observe"): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "statusline-session-"));
    writeProductMode(mode, { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    await seedMeasuredCalibration({ COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    return dir;
  }

  /** Record an outcome for `sessionId`, dated `minutesAgo` before real now. */
  async function record(
    dir: string,
    sessionId: string,
    outcome: "shape" | "hold-planning",
    minutesAgo = 0
  ): Promise<void> {
    const at = new Date(Date.now() - minutesAgo * 60 * 1000);
    await recordShapingOutcome({ tool: "claude-code", sessionId }, outcome, { COMPACTION_CONFIG_DIR: dir }, () => at);
  }

  it("a shaped turn still renders its arrow 21 minutes in", async () => {
    // THE DEFECT, VERBATIM: a long agentic turn must not lose its own evidence because time passed.
    // 21 minutes is a real observed turn length, four times the window the old model allowed.
    const dir = await isolatedConfigDir("basic");
    try {
      await record(dir, SESSION_A, "shape", 21);
      const line = await computeStatusLine(stdinFor(SESSION_A), {
        readReceipt: async () => recordModeReceipt(),
        env: { COMPACTION_CONFIG_DIR: dir }
      });
      expect(line).toMatch(/output [\d,]+→412 \(−\d+%, est\./);
      expect(line).toContain("basic shaping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a HELD session renders no shaping delta even while another session has a live shape record", async () => {
    // The cross-attribution direction that actually overclaims: B deliberately held, A is shaping.
    const dir = await isolatedConfigDir("basic");
    try {
      await record(dir, SESSION_A, "shape");
      await record(dir, SESSION_B, "hold-planning");
      const line = await computeStatusLine(stdinFor(SESSION_B), {
        readReceipt: async () => recordModeReceipt(),
        env: { COMPACTION_CONFIG_DIR: dir }
      });
      expect(line, "a held turn must never draw an output arrow").not.toContain("→");
      expect(line).not.toContain("basic shaping");

      // CONTROL: the very same store, read as A, DOES render — so the assertion above cannot pass
      // merely because no evidence was written.
      const aLine = await computeStatusLine(stdinFor(SESSION_A), {
        readReceipt: async () => recordModeReceipt(),
        env: { COMPACTION_CONFIG_DIR: dir }
      });
      expect(aLine).toContain("→");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a session with no record of its own never inherits another session's shape", async () => {
    const dir = await isolatedConfigDir("basic");
    try {
      await record(dir, SESSION_A, "shape");
      const line = await computeStatusLine(stdinFor(SESSION_B), {
        readReceipt: async () => recordModeReceipt(),
        env: { COMPACTION_CONFIG_DIR: dir }
      });
      expect(line).not.toContain("→");
      expect(line).not.toContain("basic shaping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the stdin carries no session id", async () => {
    const dir = await isolatedConfigDir();
    try {
      await record(dir, SESSION_A, "shape");
      const line = await computeStatusLine('{"cwd":"/some/proj"}', {
        readReceipt: async () => recordModeReceipt(),
        env: { COMPACTION_CONFIG_DIR: dir }
      });
      expect(line, "unnameable turn ⇒ no claim").not.toContain("→");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hook shaping alone renders the calibrated output delta with no gateway mutation at all", async () => {
    // The whole point of the hook channel: on a subscription the gateway never mutates the request, so
    // the ONLY evidence a turn was shaped is the session's own hook decision.
    const dir = await isolatedConfigDir();
    try {
      await record(dir, SESSION_A, "shape");
      const line = await computeStatusLine(stdinFor(SESSION_A), {
        readReceipt: async () => recordModeReceipt(), // record mode: request_mutated absent
        env: { COMPACTION_CONFIG_DIR: dir }
      });
      expect(line).toMatch(/output [\d,]+→412 \(−\d+%, est\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a record-mode receipt is never itself gateway evidence", async () => {
    // Record mode observes and never mutates, so `gatewayShapedTurn` is structurally false. With the
    // session holding, there is no evidence from either channel and the line stays plain.
    const dir = await isolatedConfigDir();
    try {
      await record(dir, SESSION_A, "hold-planning");
      const line = await computeStatusLine(stdinFor(SESSION_A), {
        readReceipt: async () => recordModeReceipt(),
        env: { COMPACTION_CONFIG_DIR: dir }
      });
      expect(line).not.toContain("→");
      expect(line).not.toContain("basic shaping");
      expect(line).toContain("apply off"); // the honest observe label
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computeStatusLine — exact-turn Codex scope", () => {
  /**
   * Codex 0.153 names session+turn on both lifecycle hooks. A global tool record is unreachable;
   * only the exact pair that wrote the decision may read it.
   */
  async function isolatedConfigDir(mode: "observe" | "basic" = "basic"): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "statusline-codex-"));
    writeProductMode(mode, { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    await seedMeasuredCalibration({ COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    return dir;
  }

  const CODEX_SESSION = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const CODEX_TURN = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  const CODEX_SCOPE = { tool: "codex", sessionId: CODEX_SESSION, turnId: CODEX_TURN } as const;
  const CODEX_STDIN = JSON.stringify({ cwd: "/some/proj", session_id: CODEX_SESSION, turn_id: CODEX_TURN });

  it("reads the record `hooks shape codex` wrote and renders the arrow", async () => {
    const dir = await isolatedConfigDir();
    try {
      // The writer, verbatim: the same call `hooks shape codex` makes.
      await recordShapingOutcome(CODEX_SCOPE, "shape", { COMPACTION_CONFIG_DIR: dir });
      const line = await computeStatusLine(CODEX_STDIN, {
        shapingScope: CODEX_SCOPE,
        readReceipt: async () => receipt(),
        env: { COMPACTION_CONFIG_DIR: dir }
      });
      expect(line, "a shaped Codex turn must keep its calibrated arrow").toMatch(
        /output [\d,]+→412 \(−\d+%, est\./
      );
      expect(line).toContain("basic shaping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a HELD Codex turn still renders no arrow", async () => {
    // The scope must carry the outcome, not merely unlock the arrow.
    const dir = await isolatedConfigDir();
    try {
      await recordShapingOutcome(CODEX_SCOPE, "hold-planning", { COMPACTION_CONFIG_DIR: dir });
      const line = await computeStatusLine(CODEX_STDIN, {
        shapingScope: CODEX_SCOPE,
        readReceipt: async () => receipt(),
        env: { COMPACTION_CONFIG_DIR: dir }
      });
      expect(line).not.toContain("→");
      expect(line).not.toContain("basic shaping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a Codex record never decorates a Claude Code session, and vice versa", async () => {
    // The tool scope and the session scopes remain separate namespaces.
    const dir = await isolatedConfigDir();
    try {
      await recordShapingOutcome(CODEX_SCOPE, "shape", { COMPACTION_CONFIG_DIR: dir });
      const claudeLine = await computeStatusLine(
        JSON.stringify({ cwd: "/some/proj", session_id: "cccccccc-3333-4333-8333-cccccccccccc" }),
        { readReceipt: async () => receipt(), env: { COMPACTION_CONFIG_DIR: dir } }
      );
      expect(claudeLine, "a Claude Code session must not inherit Codex's shape").not.toContain("→");

      await recordShapingOutcome(
        { tool: "claude-code", sessionId: "dddddddd-4444-4444-8444-dddddddddddd" },
        "shape",
        { COMPACTION_CONFIG_DIR: dir }
      );
      const codexHeld = await computeStatusLine(CODEX_STDIN, {
        shapingScope: { tool: "cursor" }, // a THIRD scope with nothing written under it
        readReceipt: async () => receipt(),
        env: { COMPACTION_CONFIG_DIR: dir }
      });
      expect(codexHeld, "an unwritten scope claims nothing").not.toContain("→");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an explicit scope overrides a session id the stdin happens to carry", async () => {
    // Precedence is deliberate: the caller knows which surface it is, the payload only guesses.
    const dir = await isolatedConfigDir();
    try {
      await recordShapingOutcome(CODEX_SCOPE, "shape", { COMPACTION_CONFIG_DIR: dir });
      const line = await computeStatusLine(
        JSON.stringify({ cwd: "/some/proj", session_id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee" }),
        {
          shapingScope: CODEX_SCOPE,
          readReceipt: async () => receipt(),
          env: { COMPACTION_CONFIG_DIR: dir }
        }
      );
      expect(line).toContain("→");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * THE ALLOWANCE COUNTDOWN ON THE CLAUDE CODE STATUS LINE — the only per-turn surface a Claude Code user
 * actually reads. Both figures come off the RECEIPT, which is what keeps this render loop free of a
 * file read and a network call for the balance: the statusline runs on every turn.
 */
describe("computeStatusLine — Community allowance countdown", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  /** An entitled Community device in `full` mode — the only state that renders a Community line. */
  function communityDevice(): NodeJS.ProcessEnv {
    const dir = mkdtempSync(join(tmpdir(), "statusline-community-"));
    dirs.push(dir);
    return provisionValidLease(dir, {}, { productMode: "full" }) as NodeJS.ProcessEnv;
  }

  function fullApplyReceipt(overrides: Partial<GatewayReceipt> = {}): GatewayReceipt {
    return receipt({
      mode: "apply",
      request_mutated: true,
      model_visible_bytes_changed: true,
      tokens: { prompt_input: 75_946, output: 300 },
      estimated_input_tokens_before: 75_946,
      estimated_input_tokens_after: 51_682,
      estimated_model_visible_input_reduction_percent: 31.9,
      token_source_before: "local-estimate",
      applied_components: ["lcm-compaction", "output-shaping"],
      output_shaping_state: "attached-this-pass",
      ...overrides
    });
  }

  it("renders the countdown beside the evidence axes on a healthy Community turn", async () => {
    const line = await computeStatusLine('{"cwd":"/some/proj"}', {
      readReceipt: async () =>
        fullApplyReceipt({
          allowance_snapshot: { remaining_tokens: 1_823_400, period_total_tokens: 2_000_000, period_id: "2026-08" }
        }),
      env: communityDevice()
    });
    expect(line).toContain("full apply");
    expect(line).toContain("1.82M/2M left");
    expect(line).toMatch(CONTENT_FREE_LINE);
  });

  /**
   * THE FIGURES ARE THE RECEIPT'S, NOT THE DEVICE'S. The lease on disk here says 2,000,000; the receipt
   * says 5,000,000. The receipt wins — which is exactly what stops a replayed line from acquiring
   * today's balance, and what lets this surface render without reading entitlement state per turn.
   */
  it("renders the RECEIPT's balance even when the device's own lease says something else", async () => {
    const line = await computeStatusLine('{"cwd":"/some/proj"}', {
      readReceipt: async () =>
        fullApplyReceipt({
          allowance_snapshot: { remaining_tokens: 4_500_000, period_total_tokens: 5_000_000, period_id: "2026-08" }
        }),
      env: communityDevice()
    });
    expect(line).toContain("4.5M/5M left");
    expect(line).not.toContain("/2M left");
  });

  /**
   * THE LIVE SURFACE AND THE REPLAY SURFACE MUST NOT DISAGREE ABOUT ONE RECEIPT.
   *
   * This gate used to read `request_mutated && applied_components.includes("output-shaping")` — what
   * this pass MUTATED, not what was ACTIVE on the final request. `watch` moved to
   * `output_shaping_state`; leaving this behind meant an `already-active` turn (the ordinary LCM shape)
   * drew the arrow on replay and withheld it live.
   */
  it("renders the output arrow for an ALREADY-ACTIVE turn, matching what `watch` renders", async () => {
    // The device must be one that MAY draw an arrow: the output figure now requires this device's own
    // folded A/B, so on an unmeasured device this case would render a plain count and pass or fail for
    // a reason that has nothing to do with the `already-active` gate it is named for. The other cases
    // in this block assert on the allowance clause and need no rate.
    const env = communityDevice();
    await seedMeasuredCalibration(env);
    const line = await computeStatusLine('{"cwd":"/some/proj"}', {
      readReceipt: async () =>
        fullApplyReceipt({
          applied_components: ["lcm-compaction"],
          output_shaping_state: "already-active",
          tokens: { prompt_input: 75_946, output: 300 }
        }),
      env
    });
    // 300 + round(300 × 0.40 / 0.60) = 500, from the seeded fold above — never the shipped prior.
    expect(line).toContain("output 500→300 (−40%, est.)");
    expect(line).toContain("full apply");
  });

  it("renders NO arrow for a LEGACY receipt with no state, even though it is a real apply", async () => {
    const legacy = fullApplyReceipt() as Partial<GatewayReceipt>;
    delete legacy.output_shaping_state;
    expect(legacy.request_mutated).toBe(true);
    expect(legacy.applied_components).toContain("output-shaping");
    const line = await computeStatusLine('{"cwd":"/some/proj"}', {
      readReceipt: async () => legacy as GatewayReceipt,
      env: communityDevice()
    });
    expect(line).toContain("output 300");
    expect(line).not.toContain("→300");
    expect(line).not.toContain("est.");
  });

  it("a receipt with no snapshot renders the line unchanged, with no countdown", async () => {
    const line = await computeStatusLine('{"cwd":"/some/proj"}', {
      readReceipt: async () => fullApplyReceipt(),
      env: communityDevice()
    });
    expect(line).toContain("full apply");
    expect(line).not.toContain("left");
  });
});
