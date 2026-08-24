/**
 * OSC 8 terminal hyperlinks (PUBLIC CLI/SDK core, dependency-free).
 *
 * A terminal that speaks OSC 8 renders `ESC ] 8 ; ; <url> BEL <label> ESC ] 8 ; ; BEL` as CLICKABLE
 * LABEL TEXT. One that does not speak it either ignores the sequence (leaving a bare label, which
 * silently drops the destination) or prints the escape bytes as garbage. Neither is acceptable for a
 * call to action, so this module makes the choice EXPLICIT: when support is not established, callers
 * get a plain-text rendering that still carries the URL.
 *
 * NO DEPENDENCY. `terminal-link` / `supports-hyperlinks` would do this, but the per-turn line is on
 * the hot path of every turn and the whole detection is twenty lines. Adding two packages to the
 * published CLI for that is the wrong trade.
 *
 * FAIL-CLOSED. An unrecognized terminal is NOT supported and gets plain text. A false positive prints
 * escape bytes into a user's status line; a false negative prints a URL. Only one of those is a defect.
 */

/** Explicit per-deployment override (`1/true/on/yes/force/always` on, `0/false/off/no/never` off). */
export const HYPERLINKS_ENV = "COMPACTION_HYPERLINKS";

const TRUTHY = new Set(["1", "true", "on", "yes", "force", "always"]);
const FALSY = new Set(["0", "false", "off", "no", "never"]);

/**
 * Terminal emulators whose `TERM_PROGRAM` is known to render OSC 8. Deliberately a list of PROVEN
 * ones rather than "anything not on a denylist" - see the fail-closed note above. Apple Terminal is
 * absent on purpose: it prints the escape bytes rather than linking them.
 */
const OSC8_TERM_PROGRAMS = new Set([
  "iTerm.app",
  "WezTerm",
  "vscode",
  "Hyper",
  "ghostty",
  "rio",
  "Tabby",
  "WarpTerminal"
]);

/** VTE (GNOME Terminal, Tilix, ...) gained OSC 8 in 0.50, reported as `VTE_VERSION=5000`. */
const MIN_VTE_VERSION = 5000;

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Whether OSC 8 hyperlinks may be emitted for this environment.
 *
 * Order matters: the explicit override wins over everything (including CI), because a deployment that
 * says "yes" has more information than this heuristic does. `NO_COLOR` and `TERM=dumb` are respected
 * as "plain output please". CI is off by default: a captured log is read as text, and escape bytes in
 * it are noise.
 */
export function supportsHyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = (env[HYPERLINKS_ENV] ?? "").trim().toLowerCase();
  if (TRUTHY.has(override)) return true;
  if (FALSY.has(override)) return false;

  const forced = (env.FORCE_HYPERLINK ?? "").trim().toLowerCase();
  if (isSet(forced) && !FALSY.has(forced)) return true;

  if (env.NO_COLOR !== undefined) return false;
  if ((env.TERM ?? "") === "dumb") return false;
  if (isSet(env.CI)) return false;

  if (OSC8_TERM_PROGRAMS.has((env.TERM_PROGRAM ?? "").trim())) return true;
  if (isSet(env.WT_SESSION)) return true; // Windows Terminal
  if (isSet(env.KITTY_WINDOW_ID) || (env.TERM ?? "") === "xterm-kitty") return true;
  if (isSet(env.DOMTERM)) return true;

  const vte = Number.parseInt((env.VTE_VERSION ?? "").trim(), 10);
  if (Number.isFinite(vte) && vte >= MIN_VTE_VERSION) return true;

  return false;
}

/** Written as escapes, not literal bytes, so the sequence stays greppable and diff-safe in source. */
const ESC = "\u001B";
const BEL = "\u0007";

/**
 * C0 controls (including ESC, BEL, CR and LF), DEL, and the C1 range that carries the 8-bit forms of
 * the same sequences (CSI, OSC, and the string terminator).
 *
 * These bytes are what an OSC 8 sequence is MADE of, which is why they cannot be allowed to travel
 * inside one: a BEL closes the destination early, so everything after it is read by the terminal as a
 * fresh command rather than as part of the link. `hyperlinkTarget` reads back only the prefix before
 * that BEL, so an inspection of the rendered bytes reports the benign half and sees nothing wrong.
 */
const TERMINAL_CONTROL_BYTES = /[\u0000-\u001F\u007F-\u009F]/;

/** Whether a string carries any byte a terminal would interpret rather than display. */
export function hasTerminalControlBytes(value: string): boolean {
  return TERMINAL_CONTROL_BYTES.test(value);
}

/** The same string with every such byte removed, for the plain-text rendering. */
function stripTerminalControlBytes(value: string): string {
  return value.replace(new RegExp(TERMINAL_CONTROL_BYTES.source, "g"), "");
}

/** Beyond this, a printed field is not informative, only loud. */
const MAX_SERVER_TEXT = 200;

/**
 * A value that arrived over the network, rendered safe to PRINT.
 *
 * Error codes, device names and status labels come off the wire and end up interpolated into lines
 * this CLI writes to a terminal. A hostile origin - a user pointed at one with `COMPACTION_API_URL`,
 * or a compromised one - could otherwise answer with escape bytes and have the terminal execute them
 * as commands rather than show them. So the bytes go, and the length is bounded: a megabyte of
 * `error` is a denial of the surrounding message, not information.
 *
 * Sanitize the COPY THAT IS PRINTED, never the value a decision is made on. Callers keep comparing
 * the raw string against their known codes; only the human-facing rendering passes through here.
 */
export function terminalSafeText(value: unknown, maxLength = MAX_SERVER_TEXT): string {
  if (typeof value !== "string") return "";
  const stripped = stripTerminalControlBytes(value);
  return stripped.length <= maxLength ? stripped : `${stripped.slice(0, maxLength)}...`;
}

/**
 * The raw OSC 8 payload for a label + URL. Exported so a test can assert the ENCODED DESTINATION of a
 * rendered call to action rather than re-deriving the escape syntax - the point of that proof is that
 * the bytes a terminal would follow resolve to the canonical URL.
 *
 * FAIL-CLOSED ON CONTROL BYTES, in BOTH arguments, regardless of caller. The callers in this repo pass
 * a resolver-produced URL and a compiled label, so in-tree this guard should never fire - and that is
 * precisely the argument for putting it here rather than at each call site: the moment some future
 * surface links a value that came off disk or off the wire, the escape syntax must not be
 * constructible from it. A rejected pair degrades to the plain `label: url` form with the offending
 * bytes removed, so the destination survives and nothing executes.
 */
export function osc8(label: string, url: string): string {
  if (hasTerminalControlBytes(label) || hasTerminalControlBytes(url)) {
    return `${stripTerminalControlBytes(label)}: ${stripTerminalControlBytes(url)}`;
  }
  return `${ESC}]8;;${url}${BEL}${label}${ESC}]8;;${BEL}`;
}

/** Matches an OSC 8 opener, capturing the destination. Used to READ a rendered link back. */
const OSC8_TARGET = new RegExp(`${ESC}\\]8;;([^${BEL}]*)${BEL}`);

/**
 * Extract the destination a rendered OSC 8 hyperlink points at, or undefined when the string carries
 * no hyperlink. The read-back half of `osc8`, so the CTA proof asserts against the emitted bytes.
 */
export function hyperlinkTarget(rendered: string): string | undefined {
  const match = OSC8_TARGET.exec(rendered);
  return match && match[1] !== "" ? match[1] : undefined;
}

/**
 * Render `label` as a clickable link to `url` when the terminal supports it, and as `label: url` when
 * it does not - so the destination is never lost, only less convenient. Never throws.
 */
export function terminalHyperlink(label: string, url: string, env: NodeJS.ProcessEnv = process.env): string {
  if (supportsHyperlinks(env)) return osc8(label, url);
  // The plain branch prints its arguments too, so disabling hyperlinks must not re-open what the
  // OSC 8 branch just closed: escape bytes are as interpretable in `label: url` as they are in a link.
  return `${stripTerminalControlBytes(label)}: ${stripTerminalControlBytes(url)}`;
}
