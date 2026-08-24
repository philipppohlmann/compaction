/**
 * Attach the output-shaping instruction block to a wrapped CLI command's prompt BEFORE generation
 * (PUBLIC CLI/SDK code, engine-free). Increment 3 of the output-shaping policy family, wiring the
 * deterministic policies (`output-shaping.ts`) into the live wrappers (`capture codex`/`capture cursor`).
 *
 * Mechanism honesty: output-token reduction requires shaping the request BEFORE generation. This prepends
 * the instruction block to the prompt argument the wrapper is about to run. It is OPT-IN, the original
 * command is preserved by the caller, and it surfaces NO output-savings number (a savings figure requires
 * the private measured-A/B + short-but-sufficient eval gate, `src/engine/output-shaping-verification.ts`).
 */
import { buildOutputShapingPolicy, type BuildOutputShapingOptions, type OutputShapingAttribution } from "./output-shaping.js";

// Boolean flags take no value, so the token after them is still a positional (the prompt).
const BOOLEAN_FLAGS = new Set(["-p", "--print", "--force", "--json", "--quiet", "-q", "--yes", "-y"]);
const SUBCOMMAND_KEYWORDS = new Set(["cursor", "cursor-agent", "codex", "agent", "chat", "exec", "run"]);

/**
 * Index of the last positional (prompt) argument in a wrapped command, skipping the executable, flags,
 * value-taking flags' values, and known subcommand keywords. Returns -1 when no prompt arg is found.
 */
export function findPromptArgIndex(commandParts: string[]): number {
  let last = -1;
  let skipNext = false;
  for (let i = 1; i < commandParts.length; i++) {
    const part = commandParts[i];
    if (skipNext) {
      skipNext = false; // value of a preceding value-taking flag (e.g. `--output-format json`)
      continue;
    }
    if (part.startsWith("-")) {
      if (!BOOLEAN_FLAGS.has(part) && !part.includes("=")) skipNext = true;
      continue;
    }
    if (SUBCOMMAND_KEYWORDS.has(part)) continue;
    last = i;
  }
  return last;
}

export interface AttachOutputShapingResult {
  /** The command to run (a COPY; the original is untouched). When not attached, equals the input. */
  commandParts: string[];
  /** The output-shaping policies applied (content-free attribution); empty when not attached. */
  applied: OutputShapingAttribution[];
  attached: boolean;
  /** Why attachment did not happen (e.g. no prompt arg, no matching policies). */
  reason?: string;
}

/**
 * Prepend the output-shaping instruction block to the prompt argument of `commandParts`. Returns a COPY
 * (never mutates the input). When no prompt arg is found, or no policies match, returns `attached: false`
 * with the original command + a reason, never silently shapes the wrong argument.
 */
export function attachOutputShapingToCommand(commandParts: string[], opts: BuildOutputShapingOptions = {}): AttachOutputShapingResult {
  const { instructions, applied } = buildOutputShapingPolicy(opts);
  if (instructions === "" || applied.length === 0) {
    return { commandParts: [...commandParts], applied: [], attached: false, reason: "no matching output-shaping policies" };
  }
  const idx = findPromptArgIndex(commandParts);
  if (idx === -1) {
    return { commandParts: [...commandParts], applied: [], attached: false, reason: "no prompt argument found to attach the output-shaping policy to" };
  }
  const next = [...commandParts];
  next[idx] = `${instructions}\n\n${next[idx]}`;
  return { commandParts: next, applied, attached: true };
}
