/**
 * The command identity of every Compaction-owned native integration entry (Claude Code hooks and
 * `statusLine`, Codex hooks, Cursor hooks). PURE, engine-free, content-free.
 *
 * An owned entry runs `compaction <args>` in exactly one of two forms:
 *  - BARE:     `compaction <args>`, resolved through PATH when the tool runs it.
 *  - LAUNCHER: `<absolute path>/compaction <args>`, naming the managed launcher that owns the install.
 *
 * The bare form is only as reliable as PATH order: an older npm-global `compaction` earlier on PATH
 * serves the hook instead of the install the user is running. A managed installation therefore writes
 * the launcher form. The launcher path is stable across version swaps (it selects the current verified
 * release itself), so the command never has to change on update.
 *
 * Ownership remains an EXACT match. The bare form is always ours; the launcher form is ours only for the
 * installation's own launcher (or a launcher that no longer exists, a stranded prefix). A user's own
 * `compaction` at another present path is theirs. A command that merely wraps or contains ours
 * (`echo compaction statusline`, `my-status && /x/bin/compaction statusline`) is never ours.
 */
import path from "node:path";

const EXECUTABLE = "compaction";
const SHELL_SAFE_PATH = /^[A-Za-z0-9._/+@%=:,~-]+$/;

/** Shell-quote a launcher path only when it needs it; owned paths almost never do. */
function quoteLauncher(launcher: string): string {
  return SHELL_SAFE_PATH.test(launcher) ? launcher : `'${launcher}'`;
}

/** A launcher path an owned entry may name: absolute, normalized, and named `compaction`. */
function isLauncherPath(candidate: string): boolean {
  return path.isAbsolute(candidate)
    && path.normalize(candidate) === candidate
    && path.basename(candidate) === EXECUTABLE;
}

/** True when `launcher` can be written into an owned entry (see `isLauncherPath`). */
export function isWritableLauncher(launcher: string | undefined): launcher is string {
  return typeof launcher === "string" && isLauncherPath(launcher) && !launcher.includes("'");
}

/**
 * The command an owned entry runs for `args`: the launcher form when a valid managed launcher is given,
 * otherwise the bare form.
 */
export function compactionCommand(args: string, launcher?: string): string {
  return isWritableLauncher(launcher) ? `${quoteLauncher(launcher)} ${args}` : `${EXECUTABLE} ${args}`;
}

/** The leading launcher token of a command and the text after it, or undefined. */
function splitLauncher(command: string): { launcher: string; rest: string } | undefined {
  if (command.startsWith("'")) {
    const close = command.indexOf("'", 1);
    if (close < 0) return undefined;
    return { launcher: command.slice(1, close), rest: command.slice(close + 1) };
  }
  const space = command.indexOf(" ");
  if (space < 0) return undefined;
  const launcher = command.slice(0, space);
  return SHELL_SAFE_PATH.test(launcher) ? { launcher, rest: command.slice(space) } : undefined;
}

/** Decides whether an absolute launcher named by an entry belongs to Compaction's own installation. */
export type LauncherOwnership = (launcher: string) => boolean;

/** The form an owned-shaped command takes, or undefined when it is not shaped like an entry we write. */
export type ParsedCompactionCommand = { form: "bare" } | { form: "launcher"; launcher: string };

/** Classify `command` as the bare or launcher form of `compaction <args>`, without deciding ownership. */
export function parseCompactionCommand(command: string | undefined, args: string): ParsedCompactionCommand | undefined {
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  if (trimmed === `${EXECUTABLE} ${args}`) return { form: "bare" };
  const split = splitLauncher(trimmed);
  return split && isLauncherPath(split.launcher) && split.rest === ` ${args}` ? { form: "launcher", launcher: split.launcher } : undefined;
}

/**
 * True when `command` is Compaction's own entry for `args`. The bare form always is. The launcher form is
 * ours only when `owns` says that launcher belongs to Compaction's installation (the managed receipt's
 * launcher, or a launcher file that no longer exists); a present `compaction` elsewhere is the user's
 * own and is never claimed. Surrounding whitespace is tolerated because a hand-edited config often carries it.
 */
export function isCompactionCommand(command: string | undefined, args: string, owns: LauncherOwnership): boolean {
  const parsed = parseCompactionCommand(command, args);
  return !!parsed && (parsed.form === "bare" || owns(parsed.launcher));
}
