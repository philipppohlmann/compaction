/**
 * Shared BEFORE-CALL recommendation core (PUBLIC CLI/SDK code, engine-free, ships in the npm package).
 * Observes the tool's input BEFORE the real binary runs and, when the input carries avoidable duplicated
 * context, surfaces a recommendation (never a silent mutation). DETERMINISTIC and CONTENT-FREE by
 * construction: it reads the prompt IN-PROCESS to detect avoidable context, but the caller only ever
 * persists COUNTS / policy / labels (never the prompt text).
 *
 * It reuses the existing deterministic waste detection (`detectWaste` / `getCompactedMessageIds`) by
 * shaping the single input prompt into a block-trace: the prompt is split on blank-line boundaries into
 * blocks, each block becomes one synthetic `tool` message, and the SAME repeated-content detector that
 * powers trace compaction finds exact (whitespace-normalized) duplicate blocks. Removing the later
 * duplicate copies (the first copy is always kept) yields the compacted input. There is NO scoring,
 * weight, relevance, or learned logic, only deterministic duplicate-block equality above a conservative
 * min-duplicate size floor, exactly like the trace-level policy.
 *
 * HONESTY (binding):
 * - The input token counts are a LOCAL-ESTIMATE (chars/4) computed at PRE-CALL time. Provider usage
 *   does not exist until AFTER the call, so the input reduction is a local-estimate delta for BOTH
 *   Codex and Cursor, NEVER billing-confirmed, NEVER provider-reported, NEVER called a "saving".
 * - When there is no avoidable context, `has_avoidable_context` is `false` and `compacted_input`
 *   equals the original, the caller proceeds untouched (honest; value is never faked).
 * - `compacted_input` is produced IN-PROCESS and is only ever used if the operator explicitly approves;
 *   the ORIGINAL is never destroyed or overwritten by this module (it returns a new string).
 */
import { createUsageMetadata } from "./usage-metadata.js";
import { estimateTextTokens } from "./token-estimator.js";
import { detectWaste, getCompactedMessageIds } from "./waste-detector.js";
import type { AgentTrace, TraceMessage } from "./types.js";

/** The two persistent PATH-shim tools this before-call layer covers (Claude Code is deferred). */
export type BeforeCallTool = "codex" | "cursor";

/** The deterministic policy this layer applies, exact-duplicate context-block removal. */
export const BEFORE_CALL_POLICY_NAME = "repeated_context_block_dedup";

/** The honest evidence label for every pre-call figure this layer produces (both tools). */
export const BEFORE_CALL_EVIDENCE_LABEL = "local-estimate (pre-call)";

/** The honest reduction label, spelled out so no reader upgrades it to a saving/provider figure. */
export const BEFORE_CALL_REDUCTION_LABEL =
  "local-estimate input-token delta (chars/4, pre-call); NOT billing-confirmed; NOT provider-reported " +
  "(provider usage does not exist until after the call); NOT a realized saving";

/**
 * A duplicate context block must be at least this many characters to be worth recommending removal of.
 * Conservative: tiny repeated fragments (blank lines, short markers) are never flagged, the same
 * spirit as the trace-level min-duplicate thresholds. This is a size floor, NOT a scoring heuristic.
 */
export const MIN_DUPLICATE_BLOCK_CHARS = 40;

/**
 * The TOOL-AGNOSTIC result of the deterministic avoidable-context analysis (the pure core reused by
 * every before-call surface, Codex/Cursor argv+stdin, and the Claude Code UserPromptSubmit hook). It
 * carries counts, policy, honest labels, and the compacted input, but NO tool tag: the surface adds its
 * own tag/activity framing. Content-free-by-contract (never persist `compacted_input`).
 */
export interface AvoidableContextResult {
  /** True only when ≥1 exact-duplicate context block (≥ the size floor) was found in the input. */
  has_avoidable_context: boolean;
  /** The deterministic policy that would act (content-free identifier). */
  policy: string;
  /** LOCAL-ESTIMATE (chars/4) token count of the original input, pre-call. */
  input_tokens_before: number;
  /** LOCAL-ESTIMATE (chars/4) token count of the compacted input, pre-call. */
  input_tokens_after_estimate: number;
  /** `input_tokens_before - input_tokens_after_estimate`, a local-estimate delta, never a saving. */
  reduction_tokens_estimate: number;
  /** The honest reduction label (never billing-confirmed / provider-reported). */
  reduction_label: string;
  /** The honest evidence label for the figures above. */
  evidence_label: string;
  /** Content-free count: total blocks the input was split into. */
  blocks_total: number;
  /** Content-free count: how many duplicate blocks would be removed (0 when none). */
  blocks_removed: number;
  /**
   * The compacted input, produced IN-PROCESS. Equals the original when `has_avoidable_context` is
   * false. Used ONLY if the operator explicitly approves; the original is never mutated here.
   */
  compacted_input: string;
}

/** A tool-tagged before-call recommendation = the tool-agnostic analysis + the surface tag. */
export interface BeforeCallRecommendation extends AvoidableContextResult {
  tool: BeforeCallTool;
}

/**
 * Split an input prompt into blocks on blank-line boundaries, PRESERVING the exact separators so the
 * kept blocks can be rejoined byte-for-byte (minus removed duplicate blocks). `split` with a capturing
 * group yields `[block0, sep0, block1, sep1, …]`: even indices are blocks, odd indices are the verbatim
 * separators between them.
 */
function splitPreservingSeparators(input: string): string[] {
  return input.split(/(\n[ \t]*\n[\s]*)/);
}

/** Shape the input blocks into a synthetic block-trace the existing waste detector understands. */
function shapeBlockTrace(blocks: string[]): { trace: AgentTrace; blockIdByIndex: Map<number, string> } {
  const blockIdByIndex = new Map<number, string>();
  const messages: TraceMessage[] = [];
  for (let i = 0; i < blocks.length; i += 2) {
    const id = `block-${i}`;
    blockIdByIndex.set(i, id);
    messages.push({ id, role: "tool", content: blocks[i], timestamp: "1970-01-01T00:00:00.000Z", toolName: "context_block" });
  }
  const trace: AgentTrace = {
    id: "before-call-input",
    title: "before-call input",
    artifactVersion: "before-call-v0",
    source: "manual",
    createdAt: "1970-01-01T00:00:00.000Z",
    generatedAt: "1970-01-01T00:00:00.000Z",
    model: "unknown",
    messages
  };
  return { trace, blockIdByIndex };
}

/**
 * The TOOL-AGNOSTIC pure core: analyze one input for avoidable duplicated context. Deterministic +
 * content-free-by-contract (the caller must not persist `compacted_input`). When the input has fewer
 * than two blocks, or no duplicate block meets the size floor, returns `has_avoidable_context: false`
 * with `compacted_input === input` (honest no-op). Reused by every before-call surface.
 */
export function detectAvoidableContext(input: string): AvoidableContextResult {
  const before = estimateTextTokens(input);
  const parts = splitPreservingSeparators(input);
  const blockCount = Math.ceil(parts.length / 2);

  const noAvoidable = (): AvoidableContextResult => ({
    has_avoidable_context: false,
    policy: BEFORE_CALL_POLICY_NAME,
    input_tokens_before: before,
    input_tokens_after_estimate: before,
    reduction_tokens_estimate: 0,
    reduction_label: BEFORE_CALL_REDUCTION_LABEL,
    evidence_label: BEFORE_CALL_EVIDENCE_LABEL,
    blocks_total: blockCount,
    blocks_removed: 0,
    compacted_input: input
  });

  if (blockCount < 2) return noAvoidable();

  const { trace, blockIdByIndex } = shapeBlockTrace(parts);
  const findings = detectWaste(trace, { minDuplicateCharacters: MIN_DUPLICATE_BLOCK_CHARS });
  const removeIds = getCompactedMessageIds(findings);
  if (removeIds.size === 0) return noAvoidable();

  // Rebuild the input from the surviving blocks. When a duplicate block is removed, also drop the
  // separator that IMMEDIATELY PRECEDES it (or, for the very first block, the separator that follows
  // it) so the rejoined text stays clean and byte-exact for every kept block.
  const removeIndexes = new Set<number>();
  for (const [index, id] of blockIdByIndex) {
    if (removeIds.has(id)) removeIndexes.add(index);
  }
  const keep: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const isBlock = i % 2 === 0;
    if (isBlock) {
      if (removeIndexes.has(i)) {
        // Removing block i: also drop the separator BEFORE it (parts[i-1]) if we already emitted it,
        // else the separator AFTER it (parts[i+1]) for the first block.
        if (keep.length > 0 && keep[keep.length - 1] === parts[i - 1]) {
          keep.pop();
        } else if (i + 1 < parts.length) {
          // First-block case: skip the following separator by advancing the loop over parts[i+1].
          i += 1;
        }
        continue;
      }
      keep.push(parts[i]);
    } else {
      keep.push(parts[i]);
    }
  }
  const compacted = keep.join("");
  const after = estimateTextTokens(compacted);

  // Defensive honesty: if the rebuild did not actually shrink the estimate, do not claim a reduction.
  if (after >= before) return noAvoidable();

  return {
    has_avoidable_context: true,
    policy: BEFORE_CALL_POLICY_NAME,
    input_tokens_before: before,
    input_tokens_after_estimate: after,
    reduction_tokens_estimate: before - after,
    reduction_label: BEFORE_CALL_REDUCTION_LABEL,
    evidence_label: BEFORE_CALL_EVIDENCE_LABEL,
    blocks_total: blockCount,
    blocks_removed: removeIndexes.size,
    compacted_input: compacted
  };
}

/**
 * Analyze one input prompt for avoidable duplicated context, returning a before-call recommendation
 * tagged with the tool. Thin wrapper over the tool-agnostic `detectAvoidableContext` core.
 */
export function analyzeBeforeCall(tool: BeforeCallTool, input: string): BeforeCallRecommendation {
  return { tool, ...detectAvoidableContext(input) };
}

/* ------------------------------------------------------------------------------------------------
 * Prompt-argument location (per-tool argv shape). Used to read the input the tool would send. This is
 * intentionally CONSERVATIVE and FAIL-CLOSED: if the single prompt element cannot be located with
 * confidence, it returns `null` and the caller treats the input as "not observable pre-call" - it
 * NEVER guesses, because a wrong guess on the mutation follow-up would corrupt the real command.
 * (This run is recommendation-only, so a `null` here simply means "nothing to recommend".)
 * ---------------------------------------------------------------------------------------------- */

export interface LocatedPrompt {
  /** Index into `argv` of the prompt element. */
  index: number;
  /** The prompt text. For `--flag=value` forms this is the value portion only. */
  value: string;
  /** True when the element is a `--prompt=value` / `-p=value` inline form (value after `=`). */
  inline: boolean;
}

/**
 * Locate the prompt element in a shim's `argv` (the args AFTER the tool name - the shim's `"$@"`).
 * - Codex (`exec --json "<prompt>"`): the prompt is the LAST element, required NOT to start with `-`.
 *   If the last element starts with `-` (an option/flag, or an option value we cannot disambiguate),
 *   returns `null` (fail-closed).
 * - Cursor (`-p "<prompt>"` / `--prompt "<prompt>"`, incl. `-p=…`/`--prompt=…`): the element right
 *   after a standalone `-p`/`--prompt`, or the value of the inline `=` form. Returns `null` when no
 *   such flag is present.
 */
export function locatePromptArg(tool: BeforeCallTool, argv: string[]): LocatedPrompt | null {
  if (tool === "cursor") {
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === "-p" || a === "--prompt") {
        if (i + 1 < argv.length) return { index: i + 1, value: argv[i + 1], inline: false };
        return null;
      }
      const inline = /^(?:-p|--prompt)=(.*)$/s.exec(a);
      if (inline) return { index: i, value: inline[1], inline: true };
    }
    return null;
  }
  // codex
  if (argv.length === 0) return null;
  const lastIndex = argv.length - 1;
  const last = argv[lastIndex];
  if (last.startsWith("-")) return null; // an option/flag or an ambiguous option value - never guess
  return { index: lastIndex, value: last, inline: false };
}

/* ------------------------------------------------------------------------------------------------
 * SAFE MUTATION - a STRICTER gate than `locatePromptArg` above. `locatePromptArg` is a best-effort
 * *recommendation* locator (a wrong guess only mis-analyzes a harmless recommendation). Mutation is a
 * different risk class: rewriting the wrong token would corrupt the user's real command. So this gate is
 * FAIL-CLOSED and whitelist-only: apply is available ONLY when the prompt is the VALUE OF A KNOWN
 * VALUE-TAKING PROMPT FLAG *and* every other argv token is a known flag (a value-flag whose value we
 * skip, or a boolean flag). ANY bare positional, ANY unknown flag, ANY ambiguity → apply NOT available
 * (the caller runs the ORIGINAL command unchanged).
 *
 * Neither real CLI has a value-taking prompt flag: Codex `exec [OPTIONS] [PROMPT]` takes the prompt as a
 * bare positional (its `-p` is `--profile`, a value flag); Cursor `agent [options] [prompt...]` takes a
 * variadic bare positional (its `-p` is `--print`, a boolean). So both ship with an EMPTY `promptFlags`
 * whitelist and `resolveSafeMutation` returns `{ applyAvailable: false }` for EVERY real invocation -
 * mutation is impossible for the real tools by construction. The machinery below is dormant (proven
 * inert by tests) and activates ONLY if/when a tool exposes a genuine `--prompt <value>` flag.
 * ---------------------------------------------------------------------------------------------- */

/** The per-tool argv shape whitelist used to decide whether a mutation is provably safe. */
export interface SafeMutationSpec {
  /**
   * Flags whose FOLLOWING TOKEN (or inline `=value`) is the prompt - the ONLY tokens this layer may
   * rewrite. EMPTY for both real tools today (their prompt is a bare positional). A non-empty entry is
   * the single extension point that would ever make apply available.
   */
  promptFlags: readonly string[];
  /** Non-prompt flags that CONSUME a following value token (whose value we skip, never mutate). */
  valueFlags: readonly string[];
  /** Boolean flags (no value). Anything not in these three sets is treated as unknown → fail-closed. */
  booleanFlags: readonly string[];
  /**
   * EXPLICIT VERSIONED ACTIVATION: the dormant apply path must NEVER activate just because a future tool
   * version adds a flag. A non-empty `promptFlags` whitelist is honored ONLY when this field pins the
   * exact tool version whose `--help` surface was verified to expose that value-taking prompt flag.
   * Absent/empty → apply stays fail-closed even if `promptFlags` is populated. Activating a tool
   * therefore requires ALL of: (1) a whitelist entry, (2) this pinned version, (3) safe-form tests, and
   * (4) flipping the dormant-guard assertion in before-call-dormant-guard.test.ts.
   */
  verifiedToolVersion?: string;
}

/**
 * Real per-tool specs. The load-bearing safety fact is `promptFlags: []` for BOTH tools - this alone
 * guarantees `resolveSafeMutation` fail-closes for every real invocation. The value/boolean tables are
 * only ever consulted on the (currently unreachable) whitelist path and are kept for documentation and
 * for the day a real prompt flag appears.
 */
export const SAFE_MUTATION_SPECS: Readonly<Record<BeforeCallTool, SafeMutationSpec>> = {
  // codex exec [OPTIONS] [PROMPT]: prompt is a BARE POSITIONAL (or stdin). `-p`/`--profile` is a
  // config-profile VALUE flag, NOT the prompt. No value-taking prompt flag exists → apply never
  // available.
  codex: {
    promptFlags: [],
    valueFlags: [
      "-c", "--config", "--enable", "--disable", "-i", "--image", "-m", "--model",
      "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir",
      "--output-schema", "--color", "-o", "--output-last-message"
    ],
    booleanFlags: [
      "exec", "--strict-config", "--oss", "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "--ephemeral",
      "--ignore-user-config", "--ignore-rules", "--json", "-h", "--help", "-V", "--version"
    ]
  },
  // cursor `agent [options] [prompt...]`: prompt is a VARIADIC BARE POSITIONAL. `-p`/`--print` is a
  // BOOLEAN flag (print responses), NOT a prompt-value flag. No value-taking prompt flag exists → apply
  // never available.
  cursor: {
    promptFlags: [],
    valueFlags: [
      "--api-key", "-H", "--header", "--output-format", "--mode", "--model", "--sandbox",
      "--workspace", "--add-dir", "--plugin-dir", "--worktree-base"
    ],
    booleanFlags: [
      "-p", "--print", "-v", "--version", "--stream-partial-output", "--plan", "--continue",
      "-f", "--force", "--yolo", "--auto-review", "--approve-mcps", "--trust",
      "--skip-worktree-setup", "-h", "--help"
    ]
  }
};

/** Result of the safe-mutation gate: either a proven-safe rewrite, or a fail-closed reason. */
export type SafeMutation =
  | {
      applyAvailable: true;
      tool: BeforeCallTool;
      /** The prompt flag that was matched (e.g. `--prompt`). */
      promptFlag: string;
      /** True when the match was the inline `--prompt=value` form. */
      inline: boolean;
      /** Index into argv of the token that holds the prompt value (the flag index for inline forms). */
      promptIndex: number;
      /** The original prompt value. */
      originalPrompt: string;
      /** Rebuild argv with ONLY the prompt value replaced - every other token byte-for-byte + in order. */
      rebuild: (newPrompt: string) => string[];
    }
  | { applyAvailable: false; reason: string };

/** Match `flag=value` for any flag in `flags`; returns the flag + value, or null. */
function matchInlineFlag(token: string, flags: Set<string>): { flag: string; value: string } | null {
  const eq = token.indexOf("=");
  if (eq <= 0) return null;
  const flag = token.slice(0, eq);
  if (!flags.has(flag)) return null;
  return { flag, value: token.slice(eq + 1) };
}

/**
 * Decide whether the prompt in `argv` can be SAFELY and provably isolated for mutation. FAIL-CLOSED:
 * returns `{ applyAvailable: false, reason }` unless the prompt is the value of a whitelisted
 * value-taking prompt flag AND every other token is a known flag. For both real tools the `promptFlags`
 * whitelist is empty, so this ALWAYS returns not-available (the caller runs the original unchanged). The
 * `spec` parameter is injectable ONLY so tests can exercise the (dormant) whitelist path with a
 * synthetic prompt flag - production callers always use the real, empty-prompt-flag specs.
 */
export function resolveSafeMutation(
  tool: BeforeCallTool,
  argv: string[],
  spec: SafeMutationSpec = SAFE_MUTATION_SPECS[tool]
): SafeMutation {
  const promptFlags = new Set(spec.promptFlags);
  // EXPLICIT VERSIONED ACTIVATION GATE: a non-empty whitelist is honored ONLY with a pinned
  // verifiedToolVersion, so "a future tool version added a flag, so it just turns on" is impossible -
  // activation must be a deliberate, version-pinned, tested decision. Fail-closed.
  if (promptFlags.size > 0 && !spec.verifiedToolVersion) {
    return {
      applyAvailable: false,
      reason:
        `${tool}: a prompt-flag whitelist is set but no verifiedToolVersion is pinned - activation ` +
        `requires an explicit versioned whitelist + tests - fail-closed`
    };
  }
  if (promptFlags.size === 0) {
    return {
      applyAvailable: false,
      reason:
        `${tool}: no value-taking prompt flag exists (verified via --help); the prompt is a bare ` +
        `positional and cannot be isolated with high confidence - recommendation-only (fail-closed)`
    };
  }
  const valueFlags = new Set(spec.valueFlags);
  const booleanFlags = new Set(spec.booleanFlags);

  let hit: { flagIndex: number; valueIndex: number; inline: boolean; flag: string; value: string } | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];

    const inlinePrompt = matchInlineFlag(a, promptFlags);
    if (inlinePrompt) {
      if (hit) return { applyAvailable: false, reason: "multiple prompt flags - ambiguous (fail-closed)" };
      hit = { flagIndex: i, valueIndex: i, inline: true, flag: inlinePrompt.flag, value: inlinePrompt.value };
      continue;
    }
    if (promptFlags.has(a)) {
      if (hit) return { applyAvailable: false, reason: "multiple prompt flags - ambiguous (fail-closed)" };
      if (i + 1 >= argv.length) return { applyAvailable: false, reason: "prompt flag has no following value (fail-closed)" };
      const v = argv[i + 1];
      if (v.startsWith("-")) return { applyAvailable: false, reason: "prompt-flag value looks like a flag - ambiguous (fail-closed)" };
      hit = { flagIndex: i, valueIndex: i + 1, inline: false, flag: a, value: v };
      i += 1; // skip the value token - it is the prompt, already recorded
      continue;
    }

    if (matchInlineFlag(a, valueFlags)) continue; // known inline value flag (e.g. --model=x) - skip
    if (valueFlags.has(a)) {
      i += 1; // known value flag - skip ITS value token (never mutate a non-prompt value)
      continue;
    }
    if (booleanFlags.has(a)) continue;

    if (a.startsWith("-")) {
      return { applyAvailable: false, reason: `unknown flag '${a}' - cannot prove argv is safe (fail-closed)` };
    }
    // A bare positional that is NOT a prompt-flag value: could be the prompt, a subcommand, or an
    // argument - the prompt is not provably isolated. Fail-closed (this is the real-tool case).
    return { applyAvailable: false, reason: "bare positional token present - prompt not provably isolated (fail-closed)" };
  }

  if (!hit) return { applyAvailable: false, reason: "no prompt flag found in argv (fail-closed)" };

  const matched = hit;
  return {
    applyAvailable: true,
    tool,
    promptFlag: matched.flag,
    inline: matched.inline,
    promptIndex: matched.valueIndex,
    originalPrompt: matched.value,
    rebuild: (newPrompt: string): string[] => {
      const out = argv.slice();
      out[matched.valueIndex] = matched.inline ? `${matched.flag}=${newPrompt}` : newPrompt;
      return out;
    }
  };
}

/* ------------------------------------------------------------------------------------------------
 * SAFE STDIN PROMPT BOUNDARY. The argv route is blocked (Codex + Cursor take BARE POSITIONAL prompts,
 * so there is no flag value to rewrite); this resolver finds the other boundary: stdin. Codex documents
 * a first-class stdin prompt path - "If not provided as an argument (or if `-` is used), instructions
 * are read from stdin." So when the invocation is `codex exec [flags]` with NO positional prompt (or the
 * positional is exactly `-`), the WHOLE stdin stream IS the prompt - an explicit, unambiguous boundary:
 * buffer stdin, and ONLY after explicit per-invocation approval feed a compacted copy (original
 * retained, recoverable); on decline / no-TTY / any failure feed the ORIGINAL stream unchanged.
 *
 * FAIL-CLOSED (binding): returns `{ safe: true }` ONLY for Codex `exec` where stdin is the SOLE prompt
 * source. It is NOT safe (→ recommendation-only, original stdin unchanged) when:
 * - the tool is not Codex (Cursor documents no stdin prompt path - only a `[prompt...]` variadic
 *   positional → fail-closed);
 * - a POSITIONAL prompt is present (other than a lone `-`) - Codex then APPENDS stdin as a `<stdin>`
 *   block, so stdin is NOT the whole prompt → the boundary is ambiguous → fail-closed;
 * - any UNKNOWN flag appears (cannot prove the argv shape) - fail-closed;
 * - the `exec` subcommand is absent, or a nested subcommand (`resume`/`review`) is present - fail-closed.
 * ---------------------------------------------------------------------------------------------- */

/** Result of the stdin-boundary gate: stdin is the sole prompt (safe to mediate) or a fail-closed reason. */
export interface StdinPromptBoundary {
  /** True ONLY when stdin is provably the WHOLE prompt for this argv (Codex `exec`, no positional). */
  safe: boolean;
  /** Honest, content-free reason (used for the recommendation / activity when not safe). */
  reason: string;
}

/**
 * Decide whether stdin is the SOLE, explicit prompt boundary for `argv`. Codex-only,
 * `exec`-only, fail-closed. Reuses the Codex value/boolean flag tables (`SAFE_MUTATION_SPECS.codex`) to
 * skip flag values, so a value like `-m gpt-5` is never mistaken for a positional prompt. `-` (the
 * documented explicit stdin marker) counts as "stdin is the prompt", NOT as a positional.
 */
export function resolveStdinPromptBoundary(tool: BeforeCallTool, argv: string[]): StdinPromptBoundary {
  if (tool !== "codex") {
    return {
      safe: false,
      reason: `${tool}: no documented stdin prompt boundary (verified via --help) - recommendation-only (fail-closed)`
    };
  }
  const spec = SAFE_MUTATION_SPECS.codex;
  const valueFlags = new Set(spec.valueFlags);
  const booleanFlags = new Set(spec.booleanFlags);

  let sawExec = false;
  let positionals = 0;
  let sawDash = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "exec") {
      sawExec = true;
      continue;
    }
    if (a === "-") {
      // The documented explicit stdin marker - stdin is the prompt (NOT a positional prompt, NOT a flag).
      sawDash = true;
      continue;
    }
    if (matchInlineFlag(a, valueFlags)) continue; // known inline value flag (e.g. --model=x)
    if (valueFlags.has(a)) {
      i += 1; // known value flag - skip ITS value token (never counted as a positional)
      continue;
    }
    if (booleanFlags.has(a)) continue;
    if (a.startsWith("-")) {
      return { safe: false, reason: `unknown flag '${a}' - cannot prove the stdin boundary (fail-closed)` };
    }
    // A bare positional that is NOT `exec` and NOT `-`: a positional PROMPT (or a nested subcommand like
    // resume/review). Either way stdin is NOT the sole prompt → the boundary is ambiguous → fail-closed.
    positionals += 1;
  }

  if (!sawExec) {
    return { safe: false, reason: "not the `codex exec` batch form - no stdin prompt boundary (fail-closed)" };
  }
  if (positionals > 0) {
    return {
      safe: false,
      reason:
        "a positional prompt is present, so stdin is not the whole prompt (Codex would append it as a " +
        "<stdin> block) - the boundary is ambiguous (fail-closed to the original)"
    };
  }
  // No positional prompt (optionally a lone `-`): stdin is provably the ENTIRE prompt → safe to mediate.
  return {
    safe: true,
    reason: sawDash
      ? "codex exec with an explicit `-` - stdin is the whole prompt (safe boundary)"
      : "codex exec with no positional prompt - stdin is the whole prompt (safe boundary)"
  };
}
