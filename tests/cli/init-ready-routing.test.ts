/**
 * Ready-summary routing wiring - pure unit tests (no React, no IO, no keys).
 *
 * The enable screen is CONCISE + tool-scoped: per enabled workflow it shows only the enabled line
 * (plan-auth default) + the run command + ONE honest Record-only boundary; the advanced routing /
 * cache-proof / apply detail is NOT inlined here (it moved to `compaction status`), pointed to by a
 * single pointer. These tests assert the concise form, that the moved detail is NOT inlined, that
 * `deriveReadyRouting` still derives the underlying capability (consumed by status), and that no
 * credential string ever appears.
 */
import { describe, expect, it } from "vitest";
import {
  computeCapabilityMatrix,
  deriveProviderCapabilities,
  type ProviderLiveVerification
} from "../../src/core/gateway/capability-matrix.js";
import { ADAPTERS } from "../../src/core/gateway/provider-adapter.js";
import { ROUTE_COMMANDS } from "../../src/cli/commands/dev.js";
import {
  deriveReadyRouting,
  buildReadySummaryLines,
  claudeRoutedConnectionLabel,
  type ClaudeRoutingState,
  type ReadyRoutingInputs,
  type ReadyToolKey
} from "../../src/cli/onboarding/model.js";

function inputs(verifications: ProviderLiveVerification[] = []): ReadyRoutingInputs {
  return {
    matrix: computeCapabilityMatrix({ verifications }),
    providerCaps: deriveProviderCapabilities(ADAPTERS, verifications),
    routeCommands: ROUTE_COMMANDS
  };
}

/**
 * The default fixture states that the native shaping hooks ARE confirmed on disk, because that is what
 * a successful connect produces and what most of these assertions are about. It is stated EXPLICITLY
 * rather than defaulted, because the opposite case is a real end state (a failed or suppressed hook
 * install) with its own, different, honest line — see the not-installed tests below.
 */
function inputsWithHooks(
  enabled: readonly ReadyToolKey[],
  verifications: ProviderLiveVerification[] = []
): ReadyRoutingInputs {
  return { ...inputs(verifications), shapingHooksInstalled: [...enabled] };
}

function readyText(enabled: ReadyToolKey[], verifications: ProviderLiveVerification[] = []): string {
  const routing = deriveReadyRouting(enabled, inputsWithHooks(enabled, verifications));
  return buildReadySummaryLines(enabled, "cache-optimize", routing).join("\n");
}

/** Ready text rendered under the cache-context-optimize (deterministic apply) mode. */
function applyModeText(enabled: ReadyToolKey[], verifications: ProviderLiveVerification[] = []): string {
  const routing = deriveReadyRouting(enabled, inputsWithHooks(enabled, verifications));
  return buildReadySummaryLines(enabled, "cache-context-optimize", routing).join("\n");
}

describe("Enable screen - concise, tool-scoped per-workflow lines", () => {
  /**
   * THE RECORD-ONLY LINE IS FALSE FOR CODEX ON THIS PATH, in both of its clauses: there is no gateway
   * route (the connect installs a capture shim + the tool's native hooks), and the hooks exist to
   * attach an instruction to what the model sees. A user who read the plan consent copy ("Adds that
   * instruction to what the model sees"), pressed Enable, and landed two screens later on a line
   * denying it would be reading one flow contradict itself. The pin is REWRITTEN, not loosened.
   */
  it("Codex: concise enabled line + run command + the honest per-tool boundary (never the Record-only line)", () => {
    const text = readyText(["codex"]);
    // Concise header carries the keyless plan-auth default once.
    expect(text).toContain("Per workflow - enabled on the plan-auth default (no API key):");
    // The one concise enabled line + run command.
    expect(text).toContain("Codex → ✓ Enabled (plan-auth, default):  codex");
    // The honest boundary: what is captured, what is attached, and what is absent.
    expect(text).toContain("a concise-response instruction is attached before generation, every prompt");
    expect(text).toContain("No Gateway route from this setup.");
    expect(text).not.toContain("Record-only - your input is not compacted or edited.");
    expect(text).not.toContain("Routed automatically through the local gateway");
    expect(text).toContain("content-free receipts");
    // A single pointer moves the advanced detail to `compaction status`.
    expect(text).toContain("Advanced routing, cache proof, and per-workflow detail:  compaction status");
    // The advanced detail is NOT inlined on the enable screen (it moved to status).
    expect(text).not.toContain("Optional (Advanced) - provider cache proof:");
    expect(text).not.toContain("verify-cache");
    expect(text).not.toContain("live-verified");
  });

  it("Claude Code: concise enabled line + run command; keyless-subscription + cache-proof detail NOT inlined", () => {
    const text = readyText(["claude-code"]);
    expect(text).toContain("Claude Code → ✓ Enabled (plan-auth, default):  claude");
    expect(text).toContain("Advanced routing, cache proof, and per-workflow detail:  compaction status");
    // The keyless subscription route + not-yet-live-proven detail moved to `compaction status`.
    expect(text).not.toContain("Keyless subscription route (explicit opt-in, never automatic)");
    expect(text).not.toContain("--subscription");
    expect(text).not.toContain("not yet live-proven");
    expect(text).not.toContain("Optional (Advanced) - provider cache proof:");
  });

  /**
   * F65. This assertion used to read `toContain("Record-only - nothing the model sees is mutated.")`
   * against the hooks-INSTALLED fixture, so the suite enforced the defect: it demanded that the final
   * onboarding screen deny output shaping in exactly the state where the shaping hook is on disk and
   * attaching an instruction to every shapeable turn. Same class as F58 - the guard pinned the false
   * sentence, so the copy could not be corrected without the test going red.
   *
   * It now mirrors the Codex/Cursor template already used above: the state selects the line, and the
   * line for the OTHER state is pinned ABSENT so the two can never be rendered together.
   */
  it("Claude Code with shaping hooks CONFIRMED on disk: names the attached instruction, and does not deny it", () => {
    const text = readyText(["claude-code"]);
    expect(text).toContain(
      "Routed automatically through the local gateway; content-free receipts; Output shaping: on - " +
        "a concise-response instruction is attached before each shapeable turn. Your input is not compacted or edited."
    );
  });

  it("Claude Code with shaping ON never also asserts the record-only boundary (no self-contradicting screen)", () => {
    const text = readyText(["claude-code"]);
    expect(text).not.toContain("Record-only - your input is not compacted or edited.");
    // The collapsed model-visible claim is gone from this surface in EITHER state.
    expect(text).not.toContain("nothing the model sees is mutated");
  });

  it("Claude Code with shaping hooks NOT confirmed on disk: record-only, stated on the input axis", () => {
    const text = buildReadySummaryLines(
      ["claude-code"],
      "cache-optimize",
      // No `shapingHooksInstalled` at all: the honest unknown, which must understate.
      deriveReadyRouting(["claude-code"], inputs())
    ).join("\n");
    expect(text).toContain(
      "Routed automatically through the local gateway; content-free receipts; Record-only - your input is not compacted or edited."
    );
  });

  it("Claude Code with shaping OFF never claims an attached instruction", () => {
    const text = buildReadySummaryLines(
      ["claude-code"],
      "cache-optimize",
      deriveReadyRouting(["claude-code"], inputs())
    ).join("\n");
    expect(text).not.toContain("Output shaping: on");
    expect(text).not.toContain("is attached before each shapeable turn");
    expect(text).not.toContain("nothing the model sees is mutated");
  });

  it("Cursor: concise enabled line + run command; SESSION-LEVEL wording, never per-turn; detail NOT inlined", () => {
    const text = readyText(["cursor"]);
    expect(text).toContain("Cursor → ✓ Enabled (plan-auth, default):  cursor-agent");
    // Session-level, once per session — the authority is core/subscription-shaping-hooks.ts.
    expect(text).toContain("ONE session-level instruction per session - not per turn");
    expect(text).toContain("local-estimate only");
    // The honest unmeasured boundary rides the ready screen too, not only the informational screen.
    expect(text).toContain("Output effect is not yet measured on Cursor.");
    expect(text).not.toContain("Record-only - your input is not compacted or edited.");
    expect(text).not.toContain("Routed automatically through the local gateway");
    expect(text).not.toMatch(/per prompt/i);
    // No inlined vendor-gap cache-proof detail on the enable screen (it moved to status).
    expect(text).not.toContain("verify-cache");
    expect(text).not.toContain("emits no provider usage (vendor gap)");
    expect(text.toLowerCase()).not.toContain("cache proof available");
  });

  /**
   * THE HOLD IS PROBED, NEVER ASSUMED. The classifier that holds planning/reasoning turns is PUBLIC
   * and ships in the npm package, so the probe answers a PER-BUILD
   * question — "can this build reach it" — not a per-tier one, and an account changes nothing. A build
   * that cannot reach it shapes every turn. Whichever build this is, the ready screen has to say the
   * same thing `compaction hooks install --tool codex` says about the very same hook, so both forms
   * are pinned here with the condition that selects them.
   */
  it("Codex turn-scope follows the PROBED classifier state (no hold ⇒ 'every prompt'; hold ⇒ 'held')", () => {
    const withoutHold = buildReadySummaryLines(
      ["codex"],
      "cache-optimize",
      deriveReadyRouting(["codex"], { ...inputsWithHooks(["codex"]), shapingPerTurnHold: false })
    ).join("\n");
    expect(withoutHold).toContain("attached before generation, every prompt");
    expect(withoutHold).not.toContain("are held");

    const withHold = buildReadySummaryLines(
      ["codex"],
      "cache-optimize",
      deriveReadyRouting(["codex"], { ...inputsWithHooks(["codex"]), shapingPerTurnHold: true })
    ).join("\n");
    expect(withHold).toContain("on each shapeable turn (planning/reasoning/extended-thinking turns are held)");
    expect(withHold).not.toContain("every prompt");
  });

  it("Cursor IGNORES the hold flag entirely (session-level shaping runs before any classification)", () => {
    for (const shapingPerTurnHold of [false, true]) {
      const text = buildReadySummaryLines(
        ["cursor"],
        "cache-optimize",
        deriveReadyRouting(["cursor"], { ...inputsWithHooks(["cursor"]), shapingPerTurnHold })
      ).join("\n");
      expect(text).toContain("ONE session-level instruction per session - not per turn");
      expect(text).not.toContain("are held");
    }
  });

  /**
   * THE READY LINE MAY NOT CLAIM A SHAPING EFFECT THAT IS NOT WIRED. Reproduced by the trust review in
   * ONE uninterrupted run: the connect block printed the honest hook-install failure, and the ready
   * summary twenty-five lines later said the instruction is attached before generation. The capture
   * half still stands (a hook failure never un-connects the shim), so the line says exactly that.
   */
  it("hooks NOT confirmed on disk ⇒ the line says shaping is NOT active, and never claims an attached instruction", () => {
    for (const key of ["codex", "cursor"] as const) {
      const text = buildReadySummaryLines(
        [key],
        "cache-optimize",
        // No `shapingHooksInstalled` at all: the honest unknown, which must understate.
        deriveReadyRouting([key], { ...inputs(), shapingPerTurnHold: true })
      ).join("\n");
      expect(text).toContain("output shaping is NOT active");
      expect(text).toContain("nothing is attached to what the model sees");
      expect(text).toContain(`compaction hooks install --tool ${key}`);
      expect(text).not.toContain("is attached before generation");
      expect(text).not.toContain("ONE session-level instruction per session");
      // The CAPTURE half is unaffected - the shim really did connect.
      expect(text).toContain("Captured locally");
      expect(text).toContain(`✓ Enabled (plan-auth, default)`);
    }
  });

  it("tool-scoped: enabling ONLY Codex shows Codex's line and NOT Claude Code's or Cursor's line", () => {
    const text = readyText(["codex"]);
    expect(text).toContain("Codex → ✓ Enabled (plan-auth, default):  codex");
    expect(text).not.toContain("Claude Code → ✓ Enabled");
    expect(text).not.toContain("Cursor → ✓ Enabled");
  });

  it("the enable screen NEVER asks for or stores an API key (plan-auth is keyless)", () => {
    for (const key of ["codex", "claude-code", "cursor"] as const) {
      const text = readyText([key]);
      expect(text).not.toMatch(/enter (your )?api key/i);
      expect(text).not.toMatch(/api[_-]?key/i); // no api-key/api_key token
      // The concise header states the keyless default.
      expect(text).toContain("(no API key)");
    }
  });

  it("no routing argument → byte-identical to before the section existed (regression guard)", () => {
    const withoutArg = buildReadySummaryLines(["codex", "claude-code"], "cache-optimize");
    expect(withoutArg.join("\n")).not.toContain("Per workflow - enabled on the plan-auth default");
    expect(withoutArg.join("\n")).not.toContain("✓ Enabled (plan-auth, default)");
    // The bare run commands + existing sections are unchanged.
    expect(withoutArg).toContain("    codex");
    expect(withoutArg).toContain("    claude");
  });

  it("content-free: no provider key/credential ever appears in the enable-screen lines", () => {
    const text = readyText(["codex", "claude-code", "cursor"]).toLowerCase();
    for (const secret of ["api_key", "openai_api_key", "anthropic_api_key", "authorization", "bearer", "sk-"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("the concise enable screen is byte-identical across modes (advanced/apply detail is no longer inlined)", () => {
    // The apply/advanced detail moved to `compaction status`, so the enable screen no longer varies by mode.
    const def = readyText(["codex", "claude-code", "cursor"]);
    const apply = applyModeText(["codex", "claude-code", "cursor"]);
    // Only the "Mode:" line differs; the per-workflow section is identical.
    expect(apply).not.toContain("Full optimization (deterministic context apply):");
    expect(apply).not.toContain("then start apply mode:");
    // Extract the enable section (from its header to the pointer) and assert it matches across modes.
    const section = (t: string): string => {
      const lines = t.split("\n");
      const start = lines.findIndex((l) => l.includes("Per workflow - enabled on the plan-auth default"));
      const end = lines.findIndex((l) => l.includes("Advanced routing, cache proof"));
      return lines.slice(start, end + 1).join("\n");
    };
    expect(section(apply)).toBe(section(def));
  });
});

describe("deriveReadyRouting - underlying capability still derived (consumed by `compaction status`)", () => {
  it("apply support is DERIVED (routed apply-capable provider), not hardcoded", () => {
    // Codex/Claude Code have route commands to apply-capable providers → contextApplySupported true; Cursor has
    // none → false. Assert via the derived capability (the SAME signal status renders from).
    const routing = deriveReadyRouting(["codex", "claude-code", "cursor"], inputs());
    const byKey = Object.fromEntries(routing.map((r) => [r.key, r.contextApplySupported]));
    expect(byKey["codex"]).toBe(true);
    expect(byKey["claude-code"]).toBe(true);
    expect(byKey["cursor"]).toBe(false);
  });

  it("liveVerified is derived from a real passing record; a failing record does NOT flip it", () => {
    const passing = deriveReadyRouting(["codex"], inputs([{ providerId: "openai", liveVerified: true }]));
    expect(passing.find((r) => r.key === "codex")?.liveVerified).toBe(true);
    const failing = deriveReadyRouting(["codex"], inputs([{ providerId: "openai", liveVerified: false }]));
    expect(failing.find((r) => r.key === "codex")?.liveVerified).toBe(false);
    const none = deriveReadyRouting(["codex"], inputs());
    expect(none.find((r) => r.key === "codex")?.liveVerified).toBe(false);
  });
});

describe("Ready connection label - transparent Claude Code route is record-only (captures, never optimizes)", () => {
  const state = (over: Partial<ClaudeRoutingState>): ClaudeRoutingState => ({
    installed: true,
    onPath: false,
    shellConfigured: false,
    exportLine: 'export PATH="$HOME/.compaction/shims:$PATH"',
    ...over
  });

  /**
   * F65. `expect(label).toContain("nothing the model sees is mutated")` pinned the collapsed claim on
   * this label too: the tail is rendered on the SAME ready screen as the per-workflow boundary line, so
   * leaving it unconditional would have re-introduced the contradiction one line above the fixed one.
   * The label is now state-aware and the two states are asserted separately.
   */
  it("active (on PATH), shaping OFF: routed + captured, record-only on the INPUT axis", () => {
    const label = claudeRoutedConnectionLabel(state({ onPath: true }));
    expect(label).toContain("routed through the local Compaction gateway and captured");
    expect(label).toContain("Record-only: your input is not compacted or edited");
    expect(label).toContain("Full optimization is the next increment");
  });

  it("active (on PATH), shaping ON: names the attached instruction instead of denying it", () => {
    const label = claudeRoutedConnectionLabel(state({ onPath: true }), true);
    expect(label).toContain("routed through the local Compaction gateway and captured");
    expect(label).toContain(
      "Output shaping: on - a concise-response instruction is attached before each shapeable turn. " +
        "Your input is not compacted or edited"
    );
  });

  it("no routed-connection label state ever collapses the two axes into one model-visible claim", () => {
    for (const shapingOn of [false, true]) {
      for (const s of [state({ onPath: true }), state({ shellConfigured: true }), state({})]) {
        const label = claudeRoutedConnectionLabel(s, shapingOn);
        expect(label).not.toContain("nothing the model sees is mutated");
        // Exactly one of the two boundary forms is ever present.
        expect(label.includes("Record-only: your input is not compacted or edited")).toBe(!shapingOn);
        expect(label.includes("Output shaping: on")).toBe(shapingOn);
      }
    }
  });

  it("installed, active in new shells: same routed/captured + record-only framing", () => {
    const label = claudeRoutedConnectionLabel(state({ shellConfigured: true }));
    expect(label).toContain("open a NEW shell");
    expect(label).toContain("routed through the local Compaction gateway and captured");
    expect(label).toContain("Full optimization is the next increment");
  });

  it("installed, not on PATH: same routed/captured + record-only framing with the one manual line", () => {
    const label = claudeRoutedConnectionLabel(state({}));
    expect(label).toContain("NOT yet on PATH");
    expect(label).toContain('export PATH="$HOME/.compaction/shims:$PATH"');
    expect(label).toContain("routed through the local Compaction gateway and captured");
    expect(label).toContain("Full optimization is the next increment");
  });

  it("GUARD: no routed-connection label state ever claims optimization on the record-only route", () => {
    const labels = [
      claudeRoutedConnectionLabel(state({ onPath: true })),
      claudeRoutedConnectionLabel(state({ shellConfigured: true })),
      claudeRoutedConnectionLabel(state({})),
      claudeRoutedConnectionLabel(undefined)
    ];
    for (const label of labels) {
      expect(label).not.toContain("optimized per your mode");
      expect(label).not.toContain("and optimized");
    }
  });
});
