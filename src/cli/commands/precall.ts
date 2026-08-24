/**
 * `compaction precall <tool> [--interactive 0|1] -- <commandParts…>` (PUBLIC CLI, engine-free).
 *
 * The BEFORE-CALL step the persistent Codex/Cursor PATH shim invokes IMMEDIATELY BEFORE the real binary
 * runs. It is a FAIL-OPEN, CONTENT-FREE side effect that decides what argv the shim should run:
 *
 *  1. Locate the prompt in the tool's argv (conservative, fail-closed, see `locatePromptArg`) and run
 *     the deterministic before-call analysis (`analyzeBeforeCall`) IN-PROCESS.
 *  2. Decide whether an APPROVED mutation is even POSSIBLE via the STRICT whitelist gate
 *     `resolveSafeMutation`. Apply is available ONLY when the prompt is the value of a known value-taking
 *     prompt flag AND every other argv token is known, for the REAL Codex/Cursor CLIs (whose prompt is
 *     a bare positional) this is NEVER true, so apply is never offered and the ORIGINAL always runs. The
 *     apply path below is DORMANT for the real tools by construction.
 *  3. When there is avoidable context:
 *      - apply-available + interactive TTY → show the recommendation + `[y] apply · [n] no · [v] view`.
 *        `y` → retain the ORIGINAL locally (recoverable) and emit the COMPACTED argv (ONLY the prompt
 *        argument replaced). `n`/anything-else/`[v]`-then-decline → emit the ORIGINAL.
 *      - apply-NOT-available (real tools) → recommendation + `[v]` details only; emit the ORIGINAL.
 *      - no interactive TTY → NEVER ask; emit the ORIGINAL.
 *     Record ONE content-free activity event with the honest outcome (applied / declined / not-asked).
 *  4. ALWAYS emit some argv (NUL-delimited) to stdout and exit 0, the ORIGINAL unless the operator
 *     EXPLICITLY approved a whitelist-safe compaction on a TTY.
 *
 * SAFETY (binding): NEVER mutate an ambiguous/unknown/bare-positional form; NEVER without explicit
 * per-invocation approval on a TTY; NO auto-apply / no default yes / no global preference;
 * no-TTY/decline/error/uncertain → ORIGINAL unchanged (fail-closed to original). Every failure mode
 * falls open to the original, so this step can never break or block the wrapped tool. The interaction
 * (and only the interaction) uses `/dev/tty`; stdout carries ONLY the machine argv.
 */
import { closeSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  analyzeBeforeCall,
  locatePromptArg,
  resolveSafeMutation,
  resolveStdinPromptBoundary,
  type BeforeCallRecommendation,
  type BeforeCallTool
} from "../../core/before-call.js";
import { planStdinApply } from "../../core/before-call-stdin.js";
import { buildBeforeCallActivityEvent } from "../../core/before-call-activity.js";
import { retainOriginalPrompt } from "../../core/before-call-recovery.js";
import { appendActivityEvent, DEFAULT_ACTIVITY_DIRECTORY } from "../../core/activity-store.js";
import type { ActivityApprovalStatus } from "../../core/activity-event.js";

interface PrecallOptions {
  /** "1" when the shim's REAL stdio was an interactive TTY; anything else → non-interactive. */
  interactive?: string;
  /**
   * STDIN-BOUNDARY probe: parse ARGV ONLY (reads NO stdin) and exit 0 iff stdin is the safe prompt
   * boundary for this invocation, else exit 1. The shim runs this BEFORE buffering stdin, so it never
   * buffers (and never risks blocking) when stdin is not the prompt.
   */
  stdinBoundaryCheck?: boolean;
  /**
   * STDIN-BOUNDARY apply mode: a path to the file into which the shim buffered the tool's stdin. When
   * set, precall analyzes THAT (not argv) as the prompt and, ONLY for the safe Codex stdin boundary +
   * explicit approval, writes the compacted stdin to `--compacted-out`.
   */
  stdinFile?: string;
  /** Where to write the compacted stdin when (and only when) an apply is approved. */
  compactedOut?: string;
}

function activityDir(cwd?: string): string {
  return cwd ? path.join(cwd, ".compaction", "activity") : DEFAULT_ACTIVITY_DIRECTORY;
}

/** Emit the argv NUL-delimited (each element terminated by a NUL) so ANY prompt content is byte-safe. */
function emitArgv(argv: string[]): void {
  process.stdout.write(argv.map((a) => `${a}\u0000`).join(""));
}

/** Open the controlling terminal for read+write, or return null when there is none (never throws). */
function openTty(): number | null {
  try {
    return openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
}

function ttyWrite(fd: number, text: string): void {
  try {
    writeSync(fd, text);
  } catch {
    /* best-effort; a display failure must never break the tool */
  }
}

/** Read a single line from the tty (blocking, one byte at a time). Empty string on EOF/error. */
function ttyReadLine(fd: number): string {
  const buf = Buffer.alloc(1);
  let line = "";
  for (;;) {
    let n = 0;
    try {
      n = readSync(fd, buf, 0, 1, null);
    } catch {
      break;
    }
    if (n === 0) break;
    const ch = buf.toString("utf8");
    if (ch === "\n") break;
    if (ch !== "\r") line += ch;
  }
  return line.trim();
}

/** Content-free recommendation lines (counts/policy/labels ONLY - never the prompt text). */
function recommendationLines(rec: BeforeCallRecommendation): string[] {
  return [
    "",
    "compaction before-call recommendation (recommendation-only - nothing is applied automatically):",
    `  policy: ${rec.policy}`,
    `  input tokens (local-estimate, pre-call): ${rec.input_tokens_before} → ${rec.input_tokens_after_estimate}` +
      ` (−${rec.reduction_tokens_estimate})`,
    `  evidence: ${rec.evidence_label}`,
    `  ${rec.reduction_label}`,
    "  This is a local-estimate delta, NOT a saving and NOT provider-reported.",
    "  To apply this before-call compaction, run:  compaction apply-context <your-trace> --approve-in-workflow-use",
    "  Your command will now run UNCHANGED (the original input is passed through).",
    ""
  ];
}

/** Content-free detail lines for `[v] view` (counts/policy ONLY - never a dump of the prompt). */
function detailLines(rec: BeforeCallRecommendation): string[] {
  return [
    "",
    "  details (content-free - no prompt text is shown or stored):",
    `    context blocks in input: ${rec.blocks_total}`,
    `    exact-duplicate blocks that would be removed: ${rec.blocks_removed}`,
    `    policy: ${rec.policy}`,
    `    input tokens (local-estimate): ${rec.input_tokens_before} → ${rec.input_tokens_after_estimate}`,
    ""
  ];
}

/** The input-boundary an approved apply would mutate (drives the honest UX + activity wording). */
export type ApplyBoundary = "prompt-flag" | "stdin";

/** Content-free reduction percentage string (e.g. "33.8%"), or "0.0%" when the base is zero. */
function reductionPercent(rec: BeforeCallRecommendation): string {
  if (rec.input_tokens_before <= 0) return "0.0%";
  return `${((rec.reduction_tokens_estimate / rec.input_tokens_before) * 100).toFixed(1)}%`;
}

/** Content-free recommendation lines for the APPROVED-APPLY path ([y/n/v] - apply is available). */
function applyRecommendationLines(rec: BeforeCallRecommendation, boundary: ApplyBoundary = "prompt-flag"): string[] {
  const whatChanges =
    boundary === "stdin"
      ? "  Applying replaces the stdin prompt STREAM with the compacted input; every command-line argument is"
      : "  Applying replaces ONLY the prompt argument with the compacted input; every other argument is";
  return [
    "",
    "compaction found avoidable context before this call.",
    `  input context: ${rec.input_tokens_before} → ${rec.input_tokens_after_estimate} tokens (−${rec.reduction_tokens_estimate})`,
    `  estimated reduction: ${reductionPercent(rec)}`,
    `  policy: ${rec.policy}`,
    `  evidence: ${rec.evidence_label}`,
    "  original retained: yes    recoverability: pass",
    "  This is a LOCAL-ESTIMATE delta, NOT a saving and NOT provider-reported.",
    `${whatChanges} byte-for-byte unchanged, and the ORIGINAL is retained locally (recoverable). Auto-apply is OFF.`,
    ""
  ];
}

/** A minimal injectable terminal I/O surface (so the [y/n/v] decision is unit-testable off /dev/tty). */
export interface PrecallTty {
  write(text: string): void;
  /** Read one trimmed line; empty string on EOF. */
  readLine(): string;
}

export type ApplyChoice = "apply" | "decline";

/**
 * Drive the interactive `[y] apply · [n] no · [v] view details` decision on `io`. FAIL-CLOSED to
 * DECLINE: `y` (and only `y`) approves; `v` shows content-free details then re-prompts; `n`, empty
 * (Enter), EOF, or ANY other input declines (the original runs unchanged). No default yes. This is the
 * function the PTY/`[v]` test drives directly with a fake tty stream.
 */
export function runApplyDecision(io: PrecallTty, rec: BeforeCallRecommendation, boundary: ApplyBoundary = "prompt-flag"): ApplyChoice {
  for (const line of applyRecommendationLines(rec, boundary)) io.write(`${line}\n`);
  for (;;) {
    io.write("  apply this compaction now? [y] yes · [n] no (run original) · [v] view details: ");
    const answer = io.readLine().trim().toLowerCase();
    if (answer === "y") return "apply";
    if (answer === "v") {
      for (const line of detailLines(rec)) io.write(`${line}\n`);
      continue; // back to the [y/n/v] choice - viewing details never approves
    }
    return "decline"; // n / Enter / EOF / anything else → fail-closed to the original
  }
}

/** Atomically write `content` to `target` (write a sibling `.part`, then rename - no partial reads). */
function atomicWriteFile(target: string, content: string): void {
  const tmp = `${target}.part`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);
}

/** Best-effort one-line note on the controlling terminal (never throws; a display failure is a no-op). */
function ttyNote(text: string): void {
  const fd = openTty();
  if (fd === null) return;
  try {
    ttyWrite(fd, text);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * STDIN-BOUNDARY apply path. The shim buffered the tool's stdin into `stdinFile` and
 * (when an apply is approved) reads the compacted stream back from `compactedOut`. This handler:
 *  1. reads the buffered stdin,
 *  2. plans the decision via `planStdinApply` (safe only for the Codex `exec` stdin boundary; the
 *     `[y/n/v]` approval runs on `/dev/tty`),
 *  3. on approval ONLY: retains the ORIGINAL stdin locally FIRST (fail-closed if retention fails), then
 *     atomically writes the compacted stdin to `compactedOut` (the shim's apply channel),
 *  4. records ONE content-free activity event with the honest outcome.
 * It emits NOTHING on stdout - the compacted channel is the file. Leaving `compactedOut` empty means the
 * shim feeds the ORIGINAL stdin unchanged (the fail-closed default for every non-approved path).
 */
async function handleStdinBoundary(opts: {
  tool: BeforeCallTool;
  argv: string[];
  interactive: boolean;
  stdinFile: string;
  compactedOut?: string;
  cwd: string;
}): Promise<void> {
  let stdinContent: string;
  try {
    stdinContent = readFileSync(opts.stdinFile, "utf8");
  } catch {
    return; // cannot read the buffered stdin → do nothing → the shim feeds the original unchanged
  }

  const plan = planStdinApply({
    tool: opts.tool,
    argv: opts.argv,
    stdinContent,
    interactive: opts.interactive,
    decide: (rec) => {
      const fd = openTty();
      if (fd === null) return "decline"; // no terminal to ask on → fail-closed to the original
      try {
        const io: PrecallTty = { write: (t) => ttyWrite(fd, t), readLine: () => ttyReadLine(fd) };
        return runApplyDecision(io, rec, "stdin");
      } finally {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  });

  if (!plan.boundary.safe) {
    // stdin is NOT the prompt boundary (e.g. a positional prompt is present, so Codex would append stdin
    // as a <stdin> block). Fall back to the ARGV-prompt recommendation behavior and feed the ORIGINAL
    // stdin unchanged (emit nothing to compactedOut). stdin is piped here, so the argv recommendation is
    // NON-interactive (no new blocking prompt).
    await runArgvPrecall(opts.tool, opts.argv, false, opts.cwd);
    return;
  }

  let { approvalStatus, applied } = plan;
  let recoveryPointer: string | undefined;
  let notAvailableReason = plan.notAvailableReason;

  if (plan.emit === "compacted" && plan.compacted !== undefined && !opts.compactedOut) {
    // Approved, but there is NO compacted-out channel to write to (only possible via direct-CLI misuse -
    // the shim always passes --compacted-out) → NOTHING was applied. Record the truth, not applied:true.
    applied = false;
    notAvailableReason = "approved, but no --compacted-out channel - nothing was applied (ran the original unchanged)";
  } else if (plan.emit === "compacted" && plan.compacted !== undefined && opts.compactedOut) {
    // Retain the ORIGINAL stdin FIRST - an un-recoverable mutation is NEVER performed (fail-closed).
    try {
      const retained = retainOriginalPrompt(stdinContent, { cwd: opts.cwd });
      atomicWriteFile(opts.compactedOut, plan.compacted); // the shim reads this → feeds the compacted stdin
      recoveryPointer = retained.pointer;
      ttyNote("  applied the compacted stdin (original retained locally, recoverable).\n");
    } catch {
      // Retention or the compacted write failed → run the ORIGINAL stdin unchanged; keep compactedOut empty.
      applied = false;
      approvalStatus = "asked-approved";
      notAvailableReason =
        "approved, but retaining the original / writing the compacted stdin failed - ran the original unchanged (fail-closed)";
      try {
        rmSync(`${opts.compactedOut}.part`, { force: true });
        writeFileSync(opts.compactedOut, "");
      } catch {
        /* the shim treats an empty/missing compacted file as "feed the original" */
      }
      ttyNote("  could not apply safely - running the ORIGINAL stdin unchanged.\n");
    }
  }

  if (plan.record && plan.recommendation) {
    try {
      const event = buildBeforeCallActivityEvent({
        tool: opts.tool,
        recommendation: plan.recommendation,
        approvalStatus,
        applied,
        ...(recoveryPointer ? { recoveryPointer } : {}),
        ...(notAvailableReason ? { notAvailableReason } : {}),
        boundary: "stdin"
      });
      await appendActivityEvent(event, activityDir(opts.cwd));
    } catch {
      /* fail-open: activity is a side effect, never a blocker */
    }
  }
  // stdin mode emits NOTHING on stdout - the compacted channel is the file; the shim ignores our stdout.
}

/**
 * The ARGV recommendation / whitelist-apply flow: locate the prompt in `argv`, analyze
 * it, and - ONLY for a proven whitelist-safe prompt-flag form explicitly approved on a TTY - return the
 * compacted argv; every other case returns the ORIGINAL argv. Records ONE content-free activity event
 * when there is avoidable context. For the real Codex/Cursor CLIs the apply is dormant (bare-positional
 * prompt), so this is recommendation-only there. Returns the argv the shim should run.
 */
async function runArgvPrecall(tool: BeforeCallTool, argv: string[], interactive: boolean, cwd: string): Promise<string[]> {
  const mutation = resolveSafeMutation(tool, argv);
  // The prompt to analyze: the safe-mutation prompt when apply is available (so the compacted input maps
  // to exactly the token we would rewrite); otherwise the best-effort recommendation locator.
  const promptValue = mutation.applyAvailable ? mutation.originalPrompt : locatePromptArg(tool, argv)?.value;
  if (promptValue === undefined) return argv; // no prompt confidently located → original through
  const rec = analyzeBeforeCall(tool, promptValue);
  if (!rec.has_avoidable_context) return argv; // honest no-op → original through, no activity noise

  let emitted = argv;
  let approvalStatus: ActivityApprovalStatus = "not-asked";
  let applied = false;
  let recoveryPointer: string | undefined;
  let notAvailableReason: string | undefined = mutation.applyAvailable
    ? "no interactive TTY - apply not offered (fail-closed to the original)"
    : mutation.reason;

  if (interactive) {
    const fd = openTty();
    if (fd !== null) {
      try {
        if (mutation.applyAvailable) {
          // APPROVED-APPLY path (dormant for the real tools; only reachable for a proven prompt-flag form).
          const io: PrecallTty = { write: (t) => ttyWrite(fd, t), readLine: () => ttyReadLine(fd) };
          const choice = runApplyDecision(io, rec);
          if (choice === "apply") {
            // Retain the ORIGINAL locally FIRST - if retention fails we do NOT apply (fail-closed).
            try {
              const retained = retainOriginalPrompt(mutation.originalPrompt, { cwd });
              emitted = mutation.rebuild(rec.compacted_input);
              approvalStatus = "asked-approved";
              applied = true;
              recoveryPointer = retained.pointer;
              notAvailableReason = undefined;
              ttyWrite(fd, "  applied the compacted input (original retained locally, recoverable).\n");
            } catch {
              emitted = argv;
              approvalStatus = "asked-approved";
              applied = false;
              notAvailableReason = "approved, but retaining the original failed - ran the original unchanged (fail-closed)";
              ttyWrite(fd, "  could not retain the original safely - running the ORIGINAL unchanged.\n");
            }
          } else {
            approvalStatus = "asked-declined";
            notAvailableReason = undefined;
            ttyWrite(fd, "  declined - running the ORIGINAL input unchanged.\n");
          }
        } else {
          // Apply NOT available (the real Codex/Cursor case): recommendation + [v] details only.
          for (const line of recommendationLines(rec)) ttyWrite(fd, `${line}\n`);
          ttyWrite(fd, "  [v] view details  ·  [Enter] continue (run unchanged): ");
          const answer = ttyReadLine(fd).toLowerCase();
          if (answer === "v") {
            for (const line of detailLines(rec)) ttyWrite(fd, `${line}\n`);
            ttyWrite(fd, "  continuing with the ORIGINAL input (apply is not available for this command form).\n");
          }
        }
      } finally {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  try {
    const event = buildBeforeCallActivityEvent({
      tool,
      recommendation: rec,
      approvalStatus,
      applied,
      ...(recoveryPointer ? { recoveryPointer } : {}),
      ...(notAvailableReason ? { notAvailableReason } : {})
    });
    await appendActivityEvent(event, activityDir(cwd));
  } catch {
    /* fail-open: activity is a side effect, never a blocker */
  }

  return emitted;
}

export function registerPrecallCommand(program: Command): void {
  program
    .command("precall")
    .description(
      "INTERNAL (used by the Codex/Cursor PATH shims before the real binary runs): observe the input, " +
        "surface a CONTENT-FREE before-call recommendation when it carries avoidable duplicated context, " +
        "record ONE metrics-only activity event, and emit the argv the shim should run. Mutation happens " +
        "ONLY for a whitelist-safe prompt-flag form OR the safe Codex stdin boundary, explicitly approved " +
        "on a TTY; every other case runs the ORIGINAL unchanged. Fail-open, no-TTY → no prompt, no auto-apply."
    )
    .argument("<tool>", "codex | cursor")
    .option("--interactive <state>", 'Set "1" only when the shim saw an interactive TTY; anything else → non-interactive', "0")
    .option("--stdin-boundary-check", "STDIN-boundary probe: exit 0 iff stdin is the safe prompt boundary for this argv (reads no stdin)")
    .option("--stdin-file <path>", "STDIN-boundary mode: the file the shim buffered the tool's stdin into")
    .option("--compacted-out <path>", "STDIN-boundary mode: where to write the compacted stdin when apply is approved")
    .argument("[commandParts...]", "The tool argv after -- (e.g. -- exec --json \"do X\")")
    .allowUnknownOption(true)
    .action(async (tool: string, commandPartsRaw: string[], options: PrecallOptions) => {
      // FAIL-OPEN by contract: on ANY unexpected error, emit the original argv unchanged and exit 0 so
      // the shim can never be broken by this step.
      const argv = commandPartsRaw ?? [];
      try {
        if (tool !== "codex" && tool !== "cursor") {
          emitArgv(argv);
          return;
        }
        const beforeCallTool = tool as BeforeCallTool;

        // STDIN-BOUNDARY probe: argv-only, reads NO stdin. Exit 0 iff stdin is the safe prompt
        // boundary; else exit 1. FAIL-SAFE: any error → exit 1 (the shim then does NOT buffer/mutate).
        if (options.stdinBoundaryCheck) {
          try {
            process.exit(resolveStdinPromptBoundary(beforeCallTool, argv).safe ? 0 : 1);
          } catch {
            process.exit(1);
          }
        }

        // STDIN-BOUNDARY apply mode: the shim buffered stdin and wants a decision about the
        // stdin prompt stream. This path emits nothing on stdout (the compacted channel is the file).
        if (options.stdinFile) {
          await handleStdinBoundary({
            tool: beforeCallTool,
            argv,
            interactive: options.interactive === "1",
            stdinFile: options.stdinFile,
            ...(options.compactedOut ? { compactedOut: options.compactedOut } : {}),
            cwd: process.cwd()
          });
          return;
        }

        // ARGV recommendation / whitelist-apply flow. Emits the argv the shim should run.
        emitArgv(await runArgvPrecall(beforeCallTool, argv, options.interactive === "1", process.cwd()));
      } catch {
        emitArgv(argv);
      }
    });
}
