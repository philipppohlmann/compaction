import { describe, expect, it } from "vitest";
import {
  READY_PER_TURN_HEADER,
  READY_PER_TURN_EXAMPLE_GATEWAY,
  READY_PER_TURN_EXAMPLE_HOOK_ONLY,
  READY_PER_TURN_LINES,
  readyPerTurnLinesForTools
} from "../../src/cli/onboarding/ready-metrics.js";
import type { ReadyToolKey } from "../../src/cli/onboarding/model.js";
import { formatReceiptLine } from "../../src/core/gateway/receipt-line.js";

/**
 * The Ready page must describe EXACTLY what prints per turn:
 * a per-turn line for Claude Code / Codex on the Gateway route, the honest session-level statement for
 * Cursor, and NO per-turn output-reduction %.
 */
describe("onboarding Ready - per-turn receipt-line copy matches the canonical format", () => {
  it("the Gateway example IS the canonical formatter output (cannot drift)", () => {
    expect(READY_PER_TURN_EXAMPLE_GATEWAY).toBe(
      formatReceiptLine({
        inputBefore: 41210,
        inputAfter: 21876,
        outputTokens: 412,
        costReductionUsd: 0.14,
        shortReceiptId: "8f4c2f6e"
      })
    );
    // Apply route: input before→after (−PP%) + the COMPUTED provider-priced cost clause −$X (list price).
    expect(READY_PER_TURN_EXAMPLE_GATEWAY).toBe(
      "compaction · input 41,210→21,876 (−47%) · output 412 · −$0.14 (list price) · id 8f4c2f6e"
    );
    // No standalone mode/source label, no provider-cached clause, no `compaction` word in the input clause.
    expect(READY_PER_TURN_EXAMPLE_GATEWAY).not.toContain("provider-cached");
    expect(READY_PER_TURN_EXAMPLE_GATEWAY).not.toContain("record");
    expect(READY_PER_TURN_EXAMPLE_GATEWAY).not.toContain("% compaction");
  });

  it("the hook-only example IS the canonical output-only line", () => {
    expect(READY_PER_TURN_EXAMPLE_HOOK_ONLY).toBe(formatReceiptLine({ outputTokens: 412 }));
    expect(READY_PER_TURN_EXAMPLE_HOOK_ONLY).toBe("compaction · output 412");
    expect(READY_PER_TURN_EXAMPLE_HOOK_ONLY).not.toContain("shaping on");
  });

  it("scopes the static Gateway APPLY example to Claude Code, states Codex's evidence boundary, and the Cursor session-level exception", () => {
    const joined = READY_PER_TURN_LINES.join("\n");
    expect(joined).toContain(READY_PER_TURN_HEADER);
    expect(joined).toMatch(/Claude Code \(Gateway route\)/);
    // Codex is NOT lumped onto the APPLY-style Gateway example: the reduction + cost clause are real
    // only for an APPLY turn backed by settled evidence, which this static Codex block does not have.
    expect(joined).not.toMatch(/Claude Code \/ Codex \(Gateway route\)/);
    expect(joined).toContain(
      `Codex (hook, if your build displays it; settled evidence only when recorded):  ${READY_PER_TURN_EXAMPLE_HOOK_ONLY}`
    );
    // Codex DOES have a Gateway route now (every normal invocation, interactive included) - the copy
    // states that plainly, without attaching a reduction/cost figure it cannot back.
    expect(joined).toMatch(/every normal invocation also routes through the local Gateway/);
    expect(joined).not.toMatch(/produces a receipt|receipt is produced|is measured \(a receipt/i);
    // Cursor: honest session-level exception, explicitly NOT a per-turn line.
    expect(joined).toMatch(/Cursor: no inline line/);
  });

  it("promises NO per-turn output-reduction % and documents the kill switch", () => {
    const joined = READY_PER_TURN_LINES.join("\n");
    // No output clause anywhere carries a percentage.
    expect(joined).not.toMatch(/output[^\n·]*%/);
    expect(joined).toMatch(/output is a count, never a per-turn reduction/);
    expect(joined).toContain("COMPACTION_RECEIPT_LINE=0");
  });

  it("is content-free copy: no prompt/code/response placeholders implied", () => {
    const joined = READY_PER_TURN_LINES.join("\n");
    expect(joined).toMatch(/never your prompt, code, or response/);
  });
});

/**
 * The tool-scoped per-turn block: `readyPerTurnLinesForTools` shows ONLY the enabled tools' example
 * line(s), so enabling one tool never prints every tool's variant. Examples still come from the real
 * `formatReceiptLine` (via the exported constants), so they cannot drift into an over-claim.
 */
describe("onboarding Ready - per-turn block is tool-scoped to the enabled set", () => {
  /**
   * WHAT THE CODEX PATH ACTUALLY PRODUCES. `compaction init` connects Codex with a Gateway-routing
   * PATH shim (`core/tool-shim.ts`, `kind: "gateway-route"`) plus the tool's native shaping hooks: EVERY
   * normal invocation - interactive included - routes through the local Gateway unless Compaction
   * detects the user's own route or an API key. Settled evidence is reported only when recorded. The APPLY-style Gateway example (an
   * input `−NN%` AND a `−$0.14 (list price)` cost clause) is still never attached to Codex, because
   * those figures are real only for an APPLY turn and this static screen has no settled request evidence.
   *
   * This pin is REWRITTEN, not loosened: the exact-string assertion still exists, it now pins the
   * hook-only inline-display shape, the Gateway-route statement, and the ABSENCE of an APPLY-style
   * reduction/cost figure.
   */
  it("enabling ONLY Codex prints the hook-only inline example plus the Gateway-route statement - never the APPLY-style Gateway example", () => {
    const joined = readyPerTurnLinesForTools(["codex"], ["codex"]).join("\n");
    // The header follows the same UNPROVEN-rendering boundary this test's last assertion pins: a flat
    // "you'll see one line" above the "if your Codex build displays it" hedge below would contradict it.
    expect(joined).not.toContain(READY_PER_TURN_HEADER);
    expect(joined).toContain("Per-turn receipt line - what this setup does and does not print:");
    // The hook-only example line, using the real formatter output (a count, nothing more).
    expect(joined).toContain(
      `Codex (hook installed - if your Codex build displays it, settled evidence only when recorded):  ${READY_PER_TURN_EXAMPLE_HOOK_ONLY}`
    );
    expect(joined).not.toMatch(/one line per turn|after each turn.*Codex/i);
    // NEVER the APPLY-style Gateway example: no input reduction or cost figure without settled Codex
    // request evidence.
    expect(joined).not.toContain(READY_PER_TURN_EXAMPLE_GATEWAY);
    expect(joined).not.toMatch(/\$\d/);
    expect(joined).not.toMatch(/−\d+%/);
    // Codex DOES have a Gateway route (every normal invocation, interactive included) - stated plainly,
    // with the override exception named.
    expect(joined).toContain(
      "Codex: every normal `codex` invocation - interactive included - routes through the local Gateway unless Compaction detects your own model-provider route or an OpenAI API key. Settled receipt evidence is shown only when recorded; nothing is inferred for a request without one."
    );
    // RENDERING IS UNPROVEN: the copy must be conditional, never "you'll see a line after each turn".
    expect(joined).toContain("if your Codex build displays it");
    expect(joined).not.toMatch(/you'll see a line after each turn/i);
    // `compaction watch` shows these Gateway-routed turns, interactive sessions included - the override
    // exception living on the line above, not folded into a blanket "not measured" claim.
    expect(joined).toContain("`compaction watch` shows settled Gateway evidence when recorded, including interactive Codex sessions.");
    expect(joined).not.toContain("interactive sessions are not measured");
    expect(joined).not.toContain("it installs hooks, not a Gateway route");
    expect(joined).not.toContain("Guaranteed either way");
    // NOT the Cursor session-level line, NOT the Claude Code hook-only line.
    expect(joined).not.toMatch(/Cursor: no inline line/);
    expect(joined).not.toMatch(/Claude Code/);
    // Content-free + silence lines always close the block.
    expect(joined).toMatch(/never your prompt, code, or response/);
    expect(joined).toContain("COMPACTION_RECEIPT_LINE=0");
    // The dropped meta line is no longer present.
    expect(joined).not.toContain("Input reduction is shown only on the Gateway route");
  });

  it("Cursor's block says session-level, once per session - never per turn / per prompt", () => {
    const joined = readyPerTurnLinesForTools(["cursor"], ["cursor"]).join("\n");
    expect(joined).toContain("Session-level only (one instruction per session, not per turn)");
    expect(joined).toContain("local-estimate");
    expect(joined).not.toMatch(/per prompt/i);
  });

  it("enabling ONLY Claude Code prints the Gateway + hook-only lines and NOT the Cursor line", () => {
    const joined = readyPerTurnLinesForTools(["claude-code"]).join("\n");
    expect(joined).toContain(`Claude Code (Gateway route):  ${READY_PER_TURN_EXAMPLE_GATEWAY}`);
    expect(joined).toContain(`Claude Code (hook only, no Gateway):  ${READY_PER_TURN_EXAMPLE_HOOK_ONLY}`);
    expect(joined).not.toMatch(/Cursor: no inline line/);
    expect(joined).not.toMatch(/Codex \(Gateway route\)/);
  });

  it("enabling ONLY Cursor prints the session-level-only line and NO Gateway/hook example", () => {
    const joined = readyPerTurnLinesForTools(["cursor"], ["cursor"]).join("\n");
    expect(joined).toMatch(/Cursor: no inline line/);
    expect(joined).not.toContain(READY_PER_TURN_EXAMPLE_GATEWAY);
    expect(joined).not.toContain(READY_PER_TURN_EXAMPLE_HOOK_ONLY);
    expect(joined).not.toMatch(/Gateway route/);
  });

  it("no per-turn output-reduction % in any tool-scoped block, hooks installed or not", () => {
    for (const set of [["codex"], ["claude-code"], ["cursor"], ["claude-code", "codex", "cursor"]] as const) {
      for (const installed of [[], [...set]] as const) {
        const joined = readyPerTurnLinesForTools([...set], [...installed]).join("\n");
        expect(joined).not.toMatch(/output[^\n·]*%/);
      }
    }
  });
});

/**
 * THE PER-TURN BLOCK MAY NOT CLAIM A HOOK THAT IS NOT ON DISK.
 *
 * `readyPerTurnLinesForTools` stated the Codex per-turn hook was installed UNCONDITIONALLY, so a run
 * whose hook install was refused, failed verification, or was suppressed by `COMPACTION_SHAPING_HOOKS=0`
 * / `compaction stop` printed "Codex (hook installed …)" directly beside the routing subsection that
 * #882 had just taught to read the confirmed state off disk — two contradictory claims, one screen.
 *
 * The confirmed set is the SECOND argument, and its default is EMPTY: a caller that cannot say a hook
 * is present must never be rendered as though it is. The honest boundaries #882 established are kept
 * in both variants — Codex is never promised to RENDER the line, Cursor stays session-level, and no
 * Gateway `−NN%` / `−$` figure appears on this path.
 */
describe("onboarding Ready - the per-turn block follows the CONFIRMED hook state", () => {
  it("Codex with NO confirmed hook: says the hooks are not confirmed, never 'hook installed'", () => {
    const joined = readyPerTurnLinesForTools(["codex"], []).join("\n");
    expect(joined).not.toContain("Codex (hook installed");
    expect(joined).not.toContain(READY_PER_TURN_EXAMPLE_HOOK_ONLY);
    expect(joined).toContain("this setup's Codex hooks are NOT confirmed on disk");
    // The recovery command, and only the honest one (never a Gateway figure on this path).
    expect(joined).toContain("compaction hooks install --tool codex");
    expect(joined).not.toMatch(/\$\d/);
    expect(joined).not.toMatch(/−\d+%/);
  });

  it("the default (no second argument) is the NOT-confirmed variant - a caller that cannot say never claims", () => {
    expect(readyPerTurnLinesForTools(["codex"]).join("\n")).toContain("NOT confirmed on disk");
  });

  it("Cursor with NO confirmed hook: no session-level instruction is claimed", () => {
    const joined = readyPerTurnLinesForTools(["cursor"], []).join("\n");
    expect(joined).not.toContain("Session-level only (one instruction per session, not per turn)");
    expect(joined).toContain("this setup's Cursor session hook is NOT confirmed on disk");
    expect(joined).toContain("compaction hooks install --tool cursor");
    // Still honest about the display channel, which is a vendor fact and not a hook-state fact.
    expect(joined).toMatch(/Cursor: no inline line/);
  });

  it("a mixed set follows each tool's OWN state (codex confirmed, cursor not)", () => {
    const joined = readyPerTurnLinesForTools(["codex", "cursor"], ["codex"]).join("\n");
    expect(joined).toContain("Codex (hook installed");
    expect(joined).toContain("this setup's Cursor session hook is NOT confirmed on disk");
    expect(joined).not.toContain("this setup's Codex hooks are NOT confirmed on disk");
  });

  it("Claude Code's lines are unaffected by the Codex/Cursor hook axis", () => {
    const off = readyPerTurnLinesForTools(["claude-code"], []).join("\n");
    const on = readyPerTurnLinesForTools(["claude-code"], ["claude-code"]).join("\n");
    expect(off).toBe(on);
    expect(off).toContain(`Claude Code (Gateway route):  ${READY_PER_TURN_EXAMPLE_GATEWAY}`);
  });

  it("both variants keep the content-free + silence closers", () => {
    for (const installed of [[], ["codex"]] as const) {
      const joined = readyPerTurnLinesForTools(["codex"], [...installed]).join("\n");
      expect(joined).toMatch(/never your prompt, code, or response/);
      expect(joined).toContain("COMPACTION_RECEIPT_LINE=0");
      expect(joined).not.toMatch(/you'll see a line after each turn/i);
    }
  });
});

/**
 * THE HEADER MAY NOT PROMISE A LINE THE BODY DENIES.
 *
 * The block opened with "After each turn you'll see one content-free receipt line:" unconditionally,
 * while the no-hook variants #884 introduced say, two lines later, that there is no per-turn receipt
 * line at all. A Cursor-only setup - which can NEVER have an inline line, because Cursor has no display
 * channel for one - read as a promise followed by its own denial inside one screen.
 *
 * Only Claude Code has an UNHEDGED per-turn line, so the header is resolved from the ENABLED SET ALONE:
 *  - Claude Code is the whole enabled set  -> the unscoped promise, which is then true;
 *  - Claude Code plus others               -> the promise scoped to the workflows below that print one;
 *  - Claude Code absent (or nothing on)    -> a neutral label, never a promise.
 *
 * Codex does NOT earn the promise even with its hooks confirmed on disk: `core/codex-turn-line-hook.ts`
 * records that only a live run proves Codex RENDERS `systemMessage`, and the Codex body line is hedged
 * to match ("if your Codex build displays it"). A flat promise above that hedge would re-create, at the
 * header, exactly the defect this block fixes.
 */
const PER_TURN_TOOL_KEYS = ["claude-code", "codex", "cursor"] as const;

/** Every (enabled, confirmed-hooks) pair the two arguments can take - the whole state space, 64 cases. */
function everyPerTurnState(): { enabled: ReadyToolKey[]; installed: ReadyToolKey[] }[] {
  const subsets: ReadyToolKey[][] = [];
  for (let mask = 0; mask < 1 << PER_TURN_TOOL_KEYS.length; mask += 1) {
    subsets.push(PER_TURN_TOOL_KEYS.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return subsets.flatMap((enabled) => subsets.map((installed) => ({ enabled, installed })));
}

/** A body line that denies a per-turn line exists - the exact thing the promise header contradicts. */
const DENIES_A_PER_TURN_LINE = /no per-turn receipt line|no inline line/;

describe("onboarding Ready - the per-turn header follows whether any enabled workflow prints a line", () => {
  it("NEVER renders the unscoped promise header together with a body line denying a per-turn line", () => {
    for (const { enabled, installed } of everyPerTurnState()) {
      const lines = readyPerTurnLinesForTools(enabled, installed);
      if (lines[0] !== READY_PER_TURN_HEADER) continue;
      expect(
        lines.slice(1).join("\n"),
        `enabled=[${enabled.join(",")}] hooks=[${installed.join(",")}] opened with the unscoped promise`
      ).not.toMatch(DENIES_A_PER_TURN_LINE);
    }
  });

  it("Cursor-only never promises a per-turn line - hook state cannot give Cursor a display channel", () => {
    for (const installed of [[], ["cursor"]] as const) {
      const lines = readyPerTurnLinesForTools(["cursor"], [...installed]);
      expect(lines[0]).not.toBe(READY_PER_TURN_HEADER);
      expect(lines[0]).not.toMatch(/you'll see/i);
      // Still labelled as the per-turn subject, so the block is not headerless.
      expect(lines[0]).toMatch(/receipt line/i);
    }
  });

  it("Codex with hooks NOT confirmed does not promise a line the very next line withdraws", () => {
    const lines = readyPerTurnLinesForTools(["codex"], []);
    expect(lines[0]).not.toBe(READY_PER_TURN_HEADER);
    expect(lines[0]).not.toMatch(/you'll see/i);
    expect(lines.join("\n")).toContain("this setup's Codex hooks are NOT confirmed on disk");
  });

  it("a MIXED set scopes the promise to the workflows that print one, never universally", () => {
    const lines = readyPerTurnLinesForTools(["claude-code", "cursor"], []);
    expect(lines[0]).not.toBe(READY_PER_TURN_HEADER);
    expect(lines[0]).toMatch(/receipt line/i);
    // The half that DOES print one is still shown, and the Cursor exception still closes it out.
    expect(lines.join("\n")).toContain(`Claude Code (Gateway route):  ${READY_PER_TURN_EXAMPLE_GATEWAY}`);
    expect(lines.join("\n")).toMatch(/Cursor: no inline line/);
  });

  it("Codex WITH its hooks confirmed still does not get the flat promise - its own body line is hedged", () => {
    const lines = readyPerTurnLinesForTools(["codex"], ["codex"]);
    expect(lines[0]).not.toBe(READY_PER_TURN_HEADER);
    expect(lines[0]).not.toMatch(/you'll see/i);
    expect(lines[0]).toMatch(/receipt line/i);
    // The hedge the header would otherwise have contradicted is still the body's own wording.
    expect(lines.join("\n")).toContain("if your Codex build displays it");
  });

  it("Claude-Code-only keeps today's promise header on both hook states (unchanged state)", () => {
    expect(readyPerTurnLinesForTools(["claude-code"], [])[0]).toBe(READY_PER_TURN_HEADER);
    expect(readyPerTurnLinesForTools(["claude-code"], ["claude-code"])[0]).toBe(READY_PER_TURN_HEADER);
  });

  it("every header state still closes with the content-free scope and silence lines", () => {
    for (const { enabled, installed } of everyPerTurnState()) {
      const joined = readyPerTurnLinesForTools(enabled, installed).join("\n");
      expect(joined).toMatch(/never your prompt, code, or response/);
      expect(joined).toContain("COMPACTION_RECEIPT_LINE=0");
    }
  });

  /**
   * The predicate itself, over the whole state space: the flat promise belongs to exactly one setup,
   * and no confirmed-hook state anywhere can hand it to another. Appended rather than folded into the
   * pins above, so an exact-string failure can never report first and leave this property dead.
   */
  it("renders the unscoped promise header ONLY when Claude Code is the sole enabled workflow", () => {
    for (const { enabled, installed } of everyPerTurnState()) {
      const soleClaudeCode = enabled.length === 1 && enabled[0] === "claude-code";
      expect(
        readyPerTurnLinesForTools(enabled, installed)[0] === READY_PER_TURN_HEADER,
        `enabled=[${enabled.join(",")}] hooks=[${installed.join(",")}]`
      ).toBe(soleClaudeCode);
    }
  });
});

/**
 * THE OFF SWITCH NAMED IN THE CONSENT SCREEN MUST ACTUALLY WORK.
 *
 * Output shaping ships default-ON once a tool's hook is installed, so the onboarding screen that
 * describes it is a consent surface. It used to name `compaction mode observe` as the way to turn
 * shaping off. That is false — `decideShaping` consults only the `COMPACTION_SHAPING_HOOKS` kill
 * switch and the persisted `compaction stop` state, and nothing in the hook path reads `product_mode`.
 * A consent screen naming a switch that does nothing is worse than naming none.
 *
 * This is pinned rather than left to review because nothing caught it for the entire life of the copy.
 */
import { ONBOARDING_PLAN_OPTIONS } from "../../src/cli/onboarding/model.js";
import { decideShaping } from "../../src/core/subscription-shaping-runtime.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as joinPath } from "node:path";

describe("onboarding names a shaping off switch that works", () => {
  const openCard = ONBOARDING_PLAN_OPTIONS.find((c) => c.key === "open");

  it("names `compaction stop`, not `compaction mode observe`", () => {
    const copy = (openCard?.effects ?? []).join(" ");
    expect(copy).toContain("compaction stop");
    expect(copy, "the hook path never reads product_mode").not.toContain("compaction mode observe");
  });

  it("and that claim is TRUE: `mode observe` does not stop shaping, `COMPACTION_SHAPING_HOOKS=0` does", async () => {
    const dir = mkdtempSync(joinPath(osTmpdir(), "offswitch-"));
    try {
      // Mode observe set, shaping NOT stopped → the hook still injects. This is the defect the copy
      // used to paper over; asserting it here keeps the copy honest if the behaviour ever changes.
      const { writeProductMode } = await import("../../src/core/onboarding-preferences.js");
      const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
      writeProductMode("observe", env);
      const stillShapes = await decideShaping("cursor", "", env);
      expect(stillShapes.outcome).toBe("shape");

      // The switch the copy now names does work.
      const stopped = await decideShaping("cursor", "", { ...env, COMPACTION_SHAPING_HOOKS: "0" });
      expect(stopped.outcome).not.toBe("shape");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
