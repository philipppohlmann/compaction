/**
 * Transparent capturing PATH-shim infrastructure (PUBLIC CLI/SDK code, engine-free, ships in the
 * npm package). This is the always-on mechanism for Codex and Cursor, mirroring the Claude Code
 * connect→install→RE-READ→VERIFY pattern (`src/core/claude-code-connect.ts`): a "connected/active"
 * claim may rest ONLY on a resolve-check, never on the mere act of writing a file.
 *
 * Mechanism (order: native hook → shell alias → PATH shim → else stop): a Compaction-owned
 * shim directory (`~/.compaction/shims/`, overridable via `COMPACTION_SHIM_DIR` / `COMPACTION_HOME`
 * for tests) holds a small bash shim named exactly like the tool (`codex`, `cursor-agent`, `claude`).
 * When that directory is on `PATH` AHEAD of the real binary, running the tool normally routes through
 * the shim, which TRANSPARENTLY execs the REAL binary (its absolute path resolved BEFORE install and
 * baked in so the shim can never recurse into itself) with ALL args, inherited stdio, and the
 * preserved exit code.
 *
 * Two shim kinds share this install/verify/uninstall machinery:
 * - The Codex GATEWAY-ROUTING shim routes EVERY normal `codex` invocation - interactive included -
 *   through the explicit ChatGPT-subscription Gateway envelope. Receipt consumers report only settled
 *   artifacts; the shim itself never asserts that every routed request produced one. It steps
 *   aside and runs the legacy measurable-batch-form capture path unrouted (see the Cursor bullet below
 *   for what that path does) when it detects the user's OWN route already declared - an
 *   `OPENAI_BASE_URL`/`OPENAI_API_BASE` env override; an argv `-c`/`--config`, `--oss`, or
 *   `--local-provider` route; a non-empty top-level `model_provider` in `$CODEX_HOME/config.toml` or
 *   the selected `$CODEX_HOME/<profile>.config.toml`; or an OpenAI API key present in the environment
 *   (signalling API-key auth, not the ChatGPT-subscription login this route requires).
 * - The Cursor CAPTURE shim: for the MEASURABLE batch form ONLY (`cursor-agent … --output-format json`)
 *   it tees stdout to a temp copy and, after the real binary exits, invokes the CONTENT-FREE
 *   `compaction capture <tool> --from-shim` bridge (usage token fields only; no prompt/response/message
 *   text is ever read into the event). Interactive / other invocations PASS THROUGH untouched and are
 *   honestly NOT measured (never faked). Codex's own unrouted fallback (above) reuses this same
 *   measurable-batch-form mechanism.
 * - The GATEWAY-ROUTING shim (`claude`): starts-or-reuses the persistent local RECORD-mode gateway
 *   (`compaction gateway ensure`, byte-safe; request and response forwarded unchanged; content-free
 *   receipts; the credential rides through untouched), injects ANTHROPIC_BASE_URL at it, and execs the
 *   real `claude`. FAIL-OPEN: any ensure failure, or an ANTHROPIC_BASE_URL already set, execs the
 *   real `claude` unchanged with no injection. It NEVER mutates a request (record-only by construction).
 *
 * Safety rails:
 * - NEVER overwrites or replaces the real `codex`/`cursor-agent`/`claude` binaries.
 * - NEVER edits the user's shell rc without a consent gesture (a connect/enable action with the write
 *   announced on stdout and a `--no-write-shell-config` opt-out, or an explicit `--write-shell-config`)
 *   AND a reversible `.bak` backup (see `writeShellConfigPathLine` / `removeShellConfigPathLine`).
 * - NEVER claims active without a resolve-verification (`verifyShimActive`).
 * - Local file I/O only, no network, no new dependency.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defaultManagedRoot, loadManagedInstallation } from "./update/ownership.js";

/**
 * The tools this run can shim. `cursor` installs a shim named `cursor-agent` (the installed binary);
 * `claude-code` installs the gateway-routing shim named `claude`.
 */
export type ShimTool = "codex" | "cursor" | "claude-code";

/** Capture bridge inputs retained by the capture/precall commands. */
export type CaptureShimTool = "codex" | "cursor";

/** Per-tool shim config: the on-disk shim name, the shim kind, and (capture kind) the capture surface. */
interface ShimToolConfig {
  /** The executable name the shim must masquerade as (what the user actually types / PATH resolves). */
  shimName: string;
  /** "capture" = tee + capture bridge (codex/cursor); "gateway-route" = fail-open record routing (claude). */
  kind: "capture" | "gateway-route";
  /** The `compaction capture <captureTool> --from-shim` subcommand a capture shim calls (content-free). */
  captureTool?: CaptureShimTool;
  /** Whether a capture shim forwards the ORIGINAL args to the capture bridge (Cursor needs them for the
   *  local-estimate INPUT count; Codex reads usage from output alone, so it does not). */
  forwardArgs?: boolean;
}

export const SHIM_TOOLS: Readonly<Record<ShimTool, ShimToolConfig>> = {
  codex: { shimName: "codex", kind: "gateway-route" },
  cursor: { shimName: "cursor-agent", kind: "capture", captureTool: "cursor", forwardArgs: true },
  "claude-code": { shimName: "claude", kind: "gateway-route" }
};

/** Marker line embedded in every generated shim: how verify + uninstall confirm the file is OURS. */
export const SHIM_MARKER = "COMPACTION_SHIM";

/* ------------------------------------------------------------------------------------------------
 * Paths (env-overridable so tests never touch a real ~/.compaction or real PATH).
 * ---------------------------------------------------------------------------------------------- */

export interface ShimEnv {
  COMPACTION_SHIM_DIR?: string;
  COMPACTION_HOME?: string;
  HOME?: string;
  PATH?: string;
  SHELL?: string;
}

/** The Compaction home directory: `COMPACTION_HOME` or `<home>/.compaction`. */
export function resolveCompactionHome(env: ShimEnv = process.env): string {
  if (env.COMPACTION_HOME && env.COMPACTION_HOME.trim() !== "") return env.COMPACTION_HOME;
  const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
  return path.join(home, ".compaction");
}

/** The Compaction-owned shim directory: `COMPACTION_SHIM_DIR`, else `<compaction-home>/shims`. */
export function resolveShimDir(env: ShimEnv = process.env): string {
  if (env.COMPACTION_SHIM_DIR && env.COMPACTION_SHIM_DIR.trim() !== "") return env.COMPACTION_SHIM_DIR;
  return path.join(resolveCompactionHome(env), "shims");
}

export function shimPathFor(tool: ShimTool, env: ShimEnv = process.env): string {
  return path.join(resolveShimDir(env), SHIM_TOOLS[tool].shimName);
}

/* ------------------------------------------------------------------------------------------------
 * Resolve the REAL binary on the current PATH, EXCLUDING our shim dir (so the shim never records or
 * execs itself). This is `which <name>` minus the shim directory.
 * ---------------------------------------------------------------------------------------------- */

function isExecutableFile(file: string): boolean {
  try {
    const st = statSync(file);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * First executable named `name` on `PATH`, skipping any directory in `excludeDirs` (the shim dir).
 * Returns the absolute path or `undefined`. Used at INSTALL time to record the real binary before the
 * shim can shadow it, and to detect "tool not installed" (never shim a command that does not exist).
 */
export function resolveExecutableOnPath(name: string, env: ShimEnv = process.env, excludeDirs: string[] = []): string | undefined {
  const pathValue = env.PATH ?? "";
  const excluded = new Set(excludeDirs.map((d) => path.resolve(d)));
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.trim() === "") continue;
    if (excluded.has(path.resolve(dir))) continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return path.resolve(candidate);
  }
  return undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Shim script generation.
 * ---------------------------------------------------------------------------------------------- */

/** Single-quote a value for safe embedding in the generated bash (no interpolation, no injection). */
function bashSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The measurable-form detector snippet per capture tool (sets `__measurable=1` only for the batch form). */
function detectorSnippet(tool: CaptureShimTool): string {
  if (tool === "codex") {
    return [
      "# Codex measurable batch form: `codex exec ... --json` (gates the extra before-call stdin step;",
      "# on the unrouted fallback path it also gates whether this run is captured at all).",
      "__has_exec=0; __has_json=0",
      'for __a in "$@"; do',
      '  case "$__a" in',
      "    exec) __has_exec=1 ;;",
      "    --json) __has_json=1 ;;",
      "  esac",
      "done",
      'if [ "$__has_exec" = "1" ] && [ "$__has_json" = "1" ]; then __measurable=1; fi'
    ].join("\n");
  }
  // cursor
  return [
    "# Cursor measurable batch form: `--output-format json` (or =json / stream-json). Interactive is NOT measured.",
    '__prev=""',
    'for __a in "$@"; do',
    '  case "$__a" in',
    "    --output-format=json|--output-format=stream-json) __measurable=1 ;;",
    '    json|stream-json) if [ "$__prev" = "--output-format" ]; then __measurable=1; fi ;;',
    "  esac",
    '  __prev="$__a"',
    "done"
  ].join("\n");
}

/**
 * STDIN-BOUNDARY apply block, the only before-call mutation surface.
 * ONLY Codex has a documented stdin prompt boundary (`codex exec` reads instructions from stdin when no
 * positional prompt is given), so this block is emitted ONLY for the codex shim; the cursor shim stays
 * byte-for-byte unchanged (recommendation-only). When stdin is PIPED, the shim buffers it, lets
 * `precall` decide (safe boundary + avoidable context + explicit `/dev/tty` approval → compacted stdin
 * written to a file; anything else → nothing written), and feeds the chosen stream to the real binary.
 * Every failure feeds the ORIGINAL buffered stdin unchanged (fail-open); the exit code is preserved via
 * PIPESTATUS. Interactive runs (stdin is a tty) skip this and use the recommendation-only path.
 */
function stdinApplyBlock(tool: CaptureShimTool): string {
  if (tool !== "codex") return ""; // Cursor: no documented stdin prompt boundary → no mediation.
  const cfg = SHIM_TOOLS[tool];
  const captureTool: CaptureShimTool = cfg.captureTool ?? tool;
  return `  # STDIN-BOUNDARY apply (Codex) - mutate the model's input ONLY here, ONLY after approval.
  # Engage ONLY when stdin is PIPED (not a tty) AND an ARGV-ONLY probe confirms stdin is the whole prompt
  # (no positional prompt). The probe reads NO stdin, so we never buffer (never risk blocking) unless
  # stdin genuinely IS the prompt. Anything else falls through to the recommendation-only path below.
  if [ ! -t 0 ] && "$COMPACTION_BIN" precall ${captureTool} --stdin-boundary-check -- "$@" </dev/null >/dev/null 2>&1; then
    __ttyavail=0; if [ -t 1 ]; then __ttyavail=1; fi
    __sfile="$(mktemp "\${TMPDIR:-/tmp}/compaction-${cfg.shimName}-stdin-XXXXXX" 2>/dev/null)"
    __cfile="$(mktemp "\${TMPDIR:-/tmp}/compaction-${cfg.shimName}-cpct-XXXXXX" 2>/dev/null)"
    if [ -n "$__sfile" ] && [ -n "$__cfile" ]; then
      cat > "$__sfile"
      # precall writes the compacted stdin to __cfile ONLY on explicit approval; its own stdin is
      # /dev/null and its stdout is discarded (the [y/n/v] prompt goes to /dev/tty). '|| true' → the
      # step can never break the tool. An empty __cfile means "feed the ORIGINAL" (the fail-closed default).
      "$COMPACTION_BIN" precall ${captureTool} --interactive "$__ttyavail" --stdin-file "$__sfile" --compacted-out "$__cfile" -- "$@" </dev/null >/dev/null 2>&1 || true
      __infile="$__sfile"
      if [ -s "$__cfile" ]; then __infile="$__cfile"; fi
      __tmp="$(mktemp "\${TMPDIR:-/tmp}/compaction-${cfg.shimName}-XXXXXX" 2>/dev/null)" || { "$REAL_BIN" "$@" < "$__infile"; __c=$?; rm -f "$__sfile" "$__cfile" >/dev/null 2>&1 || true; exit "$__c"; }
      "$REAL_BIN" "$@" < "$__infile" | tee "$__tmp"
      __code=\${PIPESTATUS[0]}
      ${captureSnippet(tool)}
      rm -f "$__tmp" "$__sfile" "$__cfile" >/dev/null 2>&1 || true
      exit "$__code"
    fi
    rm -f "$__sfile" "$__cfile" >/dev/null 2>&1 || true
  fi
`;
}

/** The content-free capture call the shim runs AFTER the real binary exits (best-effort, silenced). */
function captureSnippet(tool: CaptureShimTool): string {
  const cfg = SHIM_TOOLS[tool];
  const captureTool: CaptureShimTool = cfg.captureTool ?? tool;
  if (cfg.forwardArgs) {
    // Cursor: forward the original invocation so the bridge can LOCAL-ESTIMATE the input count
    // (content-free - only the token COUNT rides on the event; the prompt text is never stored).
    return `"$COMPACTION_BIN" capture ${captureTool} --from-shim "$__tmp" -- ${cfg.shimName} "$@" >/dev/null 2>&1 || true`;
  }
  return `"$COMPACTION_BIN" capture ${captureTool} --from-shim "$__tmp" >/dev/null 2>&1 || true`;
}

/**
 * Generate the transparent GATEWAY-ROUTING shim for `claude` (the `claude-code` shim tool).
 *
 * On every invocation it asks `compaction gateway ensure` to start-or-reuse the persistent local
 * RECORD-mode gateway (byte-safe: request AND response forwarded byte-for-byte; the credential -
 * API key or saved login - rides through untouched, never read, stored, or logged; content-free
 * receipts only) and, when ensure prints a loopback base URL, execs the REAL `claude` with
 * ANTHROPIC_BASE_URL pointed at it - all original args, inherited stdio, preserved exit code.
 *
 * FAIL-OPEN is the load-bearing property: ANY failure (compaction missing, ensure error/timeout,
 * non-loopback output) - or an ANTHROPIC_BASE_URL already set by the user or by
 * `compaction gateway run` (never clobbered, never double-routed) - execs the real `claude`
 * unchanged with NO injection. The shim contains no mutation path of any kind.
 *
 * Fail-open extends to a STALE baked path: if the recorded real binary is gone (e.g. Claude Code
 * reinstalled to a different location), the shim re-resolves `claude` from PATH with its OWN
 * directory removed (exact-dir match - it can never recurse into itself) and execs that, unrouted.
 * Only when no `claude` exists anywhere does it error with the honest re-connect message.
 */
function generateClaudeRoutingShimScript(realBin: string): string {
  return `#!/usr/bin/env bash
# ${SHIM_MARKER}: claude-code
# Compaction transparent ROUTING shim for "claude" - installed by \`compaction init --connect claude-code\`.
#
# It starts-or-reuses the persistent local Compaction gateway (RECORD mode - byte-safe: request and
# response forwarded byte-for-byte, no mutation; content-free receipts, token/cache counts only),
# points ANTHROPIC_BASE_URL at it, and execs the REAL claude below with ALL args, inherited stdio,
# and the preserved exit code. Your credential (API key or saved login) rides through to Anthropic
# untouched - never read, stored, or logged.
#
# FAIL-OPEN: if the gateway cannot start or answer - or ANTHROPIC_BASE_URL is already set (your own
# override, or an explicit 'compaction gateway run') - the REAL claude runs unchanged, with no
# injection. If the recorded binary below has moved (e.g. claude was reinstalled), the shim
# re-resolves claude from PATH - never from its own directory - and runs it unrouted, so your tool
# keeps working. Compaction never blocks or degrades your tool.
#
# The real binary path was resolved on your PATH BEFORE this shim was installed, so the shim can
# never recurse into itself. This file NEVER replaces the real binary.
# Uninstall (reversible): compaction init --disconnect claude-code
set -u

REAL_BIN=${bashSingleQuote(realBin)}
COMPACTION_BIN="\${COMPACTION_BIN:-compaction}"

if [ ! -x "$REAL_BIN" ]; then
  # The baked path went stale (claude was moved/reinstalled). FAIL-OPEN: re-resolve claude from
  # PATH with THIS shim's own directory removed - exact-dir match (each entry resolved to its
  # physical path before comparing, so trailing slashes/symlinks can't defeat it, and unrelated
  # entries are never dropped) - and exec it UNROUTED so the tool keeps working. Routing resumes
  # after 'compaction init --connect claude-code' re-records the binary.
  __self_dir="$(cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd -P)" || __self_dir=""
  __clean_path=""
  __old_ifs="$IFS"
  set -f
  IFS=':'
  for __dir in $PATH; do
    __abs="$(cd -- "$__dir" >/dev/null 2>&1 && pwd -P)" || __abs="$__dir"
    if [ -n "$__self_dir" ] && [ "$__abs" = "$__self_dir" ]; then continue; fi
    __clean_path="\${__clean_path:+$__clean_path:}$__dir"
  done
  IFS="$__old_ifs"
  set +f
  __fallback="$(PATH="$__clean_path" command -v claude 2>/dev/null)" || __fallback=""
  if [ -n "$__fallback" ] && [ -x "$__fallback" ] && ! [ "$__fallback" -ef "$0" ]; then
    exec "$__fallback" "$@"
  fi
  echo "compaction shim: the recorded claude binary was not found at $REAL_BIN and no other claude is on PATH - re-run 'compaction init --connect claude-code' to re-resolve it." 1>&2
  exit 127
fi

# Already routed / user override → pass through untouched (never clobber, never double-route).
if [ -n "\${ANTHROPIC_BASE_URL:-}" ]; then
  exec "$REAL_BIN" "$@"
fi

# Start-or-reuse the persistent local RECORD gateway. ensure prints ONLY the base URL on success;
# ANY failure (missing compaction, error, timeout) leaves __base empty → fail-open exec below.
__base="$("$COMPACTION_BIN" gateway ensure --provider anthropic </dev/null 2>/dev/null)" || __base=""
case "$__base" in
  http://127.0.0.1:[0-9]*)
    ANTHROPIC_BASE_URL="$__base" exec "$REAL_BIN" "$@"
    ;;
esac
exec "$REAL_BIN" "$@"
`;
}

/**
 * Detect a user-declared route in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) WITHOUT
 * ever reading a credential. Rule: the file declares its own route when it sets a non-empty TOP-LEVEL
 * `model_provider` key - i.e. one that appears BEFORE the first `[table]` header, which is what Codex
 * actually reads to select the active provider. A `[model_providers.*]` block that exists but is never
 * selected this way changes nothing about which provider Codex uses, so it does NOT count on its own -
 * counting it would fail open in the wrong direction (silently refusing to route users who have no
 * active override at all). Missing, unreadable, or malformed files fail open to "no override" - never
 * a crash. Only the KEY is inspected; the file is never echoed, logged, or persisted anywhere, and no
 * credential-bearing field (nothing under `~/.codex/auth.json`, no API key, no token) is ever touched.
 * A `model_provider` whose value is literally OUR OWN provider id (`compaction_subscription`) does not
 * count: Compaction never writes that id to the user's file, so its presence is not a competing route -
 * it already names this route, and routing normally is exactly correct there.
 */
function codexConfigRouteOverrideSnippet(): string {
  return [
    "__codex_cfg_override=0",
    '__codex_cfg_home_default=""',
    'if [ -n "${HOME:-}" ]; then __codex_cfg_home_default="$HOME/.codex"; fi',
    '__codex_cfg_home="${CODEX_HOME:-$__codex_cfg_home_default}"',
    "__codex_cfg_has_route() {",
    '  __codex_cfg="$1"',
    '  if ! [ -f "$__codex_cfg" ] || ! [ -r "$__codex_cfg" ]; then return 1; fi',
    '  while IFS= read -r __codex_cfg_line || [ -n "$__codex_cfg_line" ]; do',
    '    __codex_cfg_line="${__codex_cfg_line#"${__codex_cfg_line%%[![:space:]]*}"}"',
    '    case "$__codex_cfg_line" in',
    "      \\[*) break ;;",
    "      model_provider[[:space:]]*=*|model_provider=*)",
    '        __codex_cfg_val="${__codex_cfg_line#*=}"',
    "        __codex_cfg_val=\"$(printf '%s' \"$__codex_cfg_val\" | sed -e 's/#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^\"//' -e 's/\"$//')\"",
    '        if [ -n "$__codex_cfg_val" ] && [ "$__codex_cfg_val" != "compaction_subscription" ]; then return 0; fi',
    "        return 1",
    "        ;;",
    "    esac",
    '  done < "$__codex_cfg" 2>/dev/null',
    "  return 1",
    "}",
    'if [ -n "$__codex_cfg_home" ]; then',
    '  if __codex_cfg_has_route "$__codex_cfg_home/config.toml"; then __codex_cfg_override=1; fi',
    "fi"
  ].join("\n");
}

/** Generate the normal-invocation Codex ChatGPT-subscription routing shim. */
function generateCodexRoutingShimScript(realBin: string): string {
  const unroutedStdinApply = stdinApplyBlock("codex");
  const configOverride = codexConfigRouteOverrideSnippet();
  return `#!/usr/bin/env bash
# ${SHIM_MARKER}: codex
# Compaction transparent ChatGPT-subscription routing shim for "codex".
# Existing route overrides pass through unchanged - environment, argv (including selected profiles
# and local-provider flags), an existing model_provider in Codex config, or an OpenAI API key already
# in the environment. No credential is read, copied, or stored here: config files are inspected for
# their ROUTE key only, never a credential field.
set -u

REAL_BIN=${bashSingleQuote(realBin)}
COMPACTION_BIN="\${COMPACTION_BIN:-compaction}"

if [ ! -x "$REAL_BIN" ]; then
  echo "compaction shim: the recorded codex binary was not found at $REAL_BIN - re-run 'compaction init --connect' to re-resolve it." 1>&2
  exit 127
fi

# The legacy measurable path remains the fail-open/explicit-override behavior. It performs the
# recommendation/approval-gated stdin step, tees the single real invocation, and bridges its usage.
__run_unrouted() {
  __measurable=0
  ${detectorSnippet("codex")}
  if [ "$__measurable" = "1" ]; then
${unroutedStdinApply}    __itty=0
    if [ -t 0 ] && [ -t 1 ]; then __itty=1; fi
    "$COMPACTION_BIN" precall codex --interactive "$__itty" -- "$@" </dev/null >/dev/null 2>&1 || true
    __tmp="$(mktemp "\${TMPDIR:-/tmp}/compaction-codex-XXXXXX" 2>/dev/null)" || exec "$REAL_BIN" "$@"
    "$REAL_BIN" "$@" | tee "$__tmp"
    __code=\${PIPESTATUS[0]}
    ${captureSnippet("codex")}
    rm -f "$__tmp" >/dev/null 2>&1 || true
    exit "$__code"
  fi
  exec "$REAL_BIN" "$@"
}

# Environment route overrides are authoritative: never clobber or double-route them.
if [ -n "\${OPENAI_BASE_URL:-}" ] || [ -n "\${OPENAI_API_BASE:-}" ]; then
  __run_unrouted "$@"
fi

# A declared OpenAI API key variable - even empty - is a conservative read-only EXISTENCE signal
# (never the value) that this Codex may be set up for API-key auth, not the ChatGPT-subscription
# login this route requires (requires_openai_auth). Forcing the loopback route here would silently
# break that auth.
if [ -n "\${OPENAI_API_KEY+x}" ] || [ -n "\${OPENAI_KEY+x}" ]; then
  __run_unrouted "$@"
fi

# Codex command-line configuration can declare a provider/base route. Detect the supported -c/--config
# forms, selected profile, and local-provider flags without printing their values, then preserve the
# invocation byte-for-byte. A missing/invalid profile argument is ambiguous, so it stays unrouted.
__route_override=0
__expect_config=0
__expect_profile=0
__selected_profile=""
for __arg in "$@"; do
  if [ "$__expect_config" = "1" ]; then
    case "$__arg" in
      model_provider=*|openai_base_url=*|chatgpt_base_url=*|model_providers.*.base_url=*) __route_override=1 ;;
    esac
    __expect_config=0
    continue
  fi
  if [ "$__expect_profile" = "1" ]; then
    case "$__arg" in
      ""|-*) __route_override=1 ;;
      *) __selected_profile="$__arg" ;;
    esac
    __expect_profile=0
    continue
  fi
  case "$__arg" in
    -c|--config) __expect_config=1 ;;
    --config=model_provider=*|--config=openai_base_url=*|--config=chatgpt_base_url=*|--config=model_providers.*.base_url=*) __route_override=1 ;;
    model_provider=*|openai_base_url=*|chatgpt_base_url=*|model_providers.*.base_url=*) __route_override=1 ;;
    -p|--profile) __expect_profile=1 ;;
    -p=*|--profile=*)
      __selected_profile="\${__arg#*=}"
      if [ -z "$__selected_profile" ]; then __route_override=1; fi
      ;;
    --oss|--local-provider|--local-provider=*) __route_override=1 ;;
  esac
done
if [ "$__expect_profile" = "1" ]; then __route_override=1; fi
if [ "$__route_override" = "1" ]; then
  __run_unrouted "$@"
fi

# The user's OWN $CODEX_HOME/config.toml can already declare a model_provider - reading it is reading
# configuration, never a credential (see codexConfigRouteOverrideSnippet). A declared provider passes
# through unrouted rather than being silently replaced by the ChatGPT-subscription route below.
${configOverride}
if [ "$__codex_cfg_override" = "1" ]; then
  __run_unrouted "$@"
fi

# A selected profile layers $CODEX_HOME/<name>.config.toml over the base config. Inspect ONLY that
# selected file's top-level route key; dormant profile files must not disable normal subscription
# routing. Unsafe names or an unavailable selected file are ambiguous and therefore stay unrouted.
if [ -n "$__selected_profile" ]; then
  case "$__selected_profile" in
    .|..|*/*|*[!A-Za-z0-9._-]*) __run_unrouted "$@" ;;
  esac
  if [ -z "$__codex_cfg_home" ]; then __run_unrouted "$@"; fi
  __codex_profile_cfg="$__codex_cfg_home/$__selected_profile.config.toml"
  if ! [ -f "$__codex_profile_cfg" ] || ! [ -r "$__codex_profile_cfg" ]; then __run_unrouted "$@"; fi
  if __codex_cfg_has_route "$__codex_profile_cfg"; then __run_unrouted "$@"; fi
fi

# With no usable Compaction launcher, preserve the complete pre-existing fail-open capture path.
if ! command -v "$COMPACTION_BIN" >/dev/null 2>&1; then
  __run_unrouted "$@"
fi

# Routed mode retains Codex's before-call recommendation and approval-gated stdin boundary. The
# Gateway receipt replaces ONLY the post-hoc tee/capture bridge: exactly one real inference runs.
__measurable=0
${detectorSnippet("codex")}
if [ "$__measurable" = "1" ]; then
  if [ ! -t 0 ] && "$COMPACTION_BIN" precall codex --stdin-boundary-check -- "$@" </dev/null >/dev/null 2>&1; then
    __ttyavail=0; if [ -t 1 ]; then __ttyavail=1; fi
    __sfile="$(mktemp "\${TMPDIR:-/tmp}/compaction-codex-stdin-XXXXXX" 2>/dev/null)"
    __cfile="$(mktemp "\${TMPDIR:-/tmp}/compaction-codex-cpct-XXXXXX" 2>/dev/null)"
    if [ -n "$__sfile" ] && [ -n "$__cfile" ]; then
      cat > "$__sfile"
      "$COMPACTION_BIN" precall codex --interactive "$__ttyavail" --stdin-file "$__sfile" --compacted-out "$__cfile" -- "$@" </dev/null >/dev/null 2>&1 || true
      __infile="$__sfile"
      if [ -s "$__cfile" ]; then __infile="$__cfile"; fi
      "$COMPACTION_BIN" gateway run --provider openai --workflow codex --subscription -- "$REAL_BIN" "$@" < "$__infile"
      __code=$?
      rm -f "$__sfile" "$__cfile" >/dev/null 2>&1 || true
      exit "$__code"
    fi
    rm -f "$__sfile" "$__cfile" >/dev/null 2>&1 || true
  fi
  __itty=0
  if [ -t 0 ] && [ -t 1 ]; then __itty=1; fi
  "$COMPACTION_BIN" precall codex --interactive "$__itty" -- "$@" </dev/null >/dev/null 2>&1 || true
fi
exec "$COMPACTION_BIN" gateway run --provider openai --workflow codex --subscription -- "$REAL_BIN" "$@"
`;
}

/**
 * Generate the transparent shim script for `tool`, baking in the resolved absolute `realBin` path.
 *
 * Capture kind (cursor; also codex's own unrouted fallback): (1) execs the real binary with all args +
 * inherited stdio + preserved exit code; (2) for the measurable batch form ONLY, runs a FAIL-OPEN,
 * CONTENT-FREE before-call recommendation step (`compaction precall`; recommendation-only - it never
 * mutates the input), then tees stdout to a temp copy and calls the content-free capture bridge, then
 * deletes the temp; (3) passes everything else through untouched.
 *
 * Gateway-route kind (claude-code, codex): see `generateClaudeRoutingShimScript` /
 * `generateCodexRoutingShimScript`. Codex routes EVERY normal invocation, falling back to the capture
 * kind above only when the user's own route is detected (see the module doc comment).
 */
export function generateShimScript(tool: ShimTool, realBin: string, managedLauncher?: string): string {
  if (managedLauncher) {
    const script = generateShimScript(tool, realBin);
    return script.replace("set -u\n", `set -u\n# COMPACTION_MANAGED_SESSION_V1\nexec ${bashSingleQuote(managedLauncher)} --managed-session-shim "$0" -- "$@"\n`);
  }
  if (tool === "codex") return generateCodexRoutingShimScript(realBin);
  if (tool === "claude-code") return generateClaudeRoutingShimScript(realBin);
  const cfg = SHIM_TOOLS[tool];
  const captureTool: CaptureShimTool = cfg.captureTool ?? tool;
  return `#!/usr/bin/env bash
# ${SHIM_MARKER}: ${tool}
# Compaction transparent capturing shim for "${cfg.shimName}" - installed by \`compaction init --connect\`.
#
# It TRANSPARENTLY execs the REAL binary below with ALL args, inherited stdio, and the preserved exit
# code. For the MEASURABLE batch form ONLY it captures provider usage token fields as a CONTENT-FREE
# side effect (no prompt/response/message text is ever stored). Interactive / other invocations pass
# through untouched and are NOT measured (never faked).
#
# The real binary path was resolved on your PATH BEFORE this shim was installed, so the shim can never
# recurse into itself. This file NEVER replaces the real binary.
# Uninstall (reversible): compaction init --disconnect ${tool}
set -u

REAL_BIN=${bashSingleQuote(realBin)}
COMPACTION_BIN="\${COMPACTION_BIN:-compaction}"

if [ ! -x "$REAL_BIN" ]; then
  echo "compaction shim: the recorded ${cfg.shimName} binary was not found at $REAL_BIN - re-run 'compaction init --connect' to re-resolve it." 1>&2
  exit 127
fi

__measurable=0
${detectorSnippet(tool)}

if [ "$__measurable" = "1" ]; then
${stdinApplyBlock(tool)}  # BEFORE-CALL recommendation - RECOMMENDATION-ONLY, FAIL-OPEN, CONTENT-FREE.
  # 'compaction precall' is invoked purely for its side effects: when the input carries avoidable
  # duplicated context it surfaces a recommendation on /dev/tty (interactive terminals only) and records
  # ONE content-free activity event. It NEVER mutates the input - the real binary below always runs on
  # the ORIGINAL "$@". precall's stdin is /dev/null (so it can never steal the tool's stdin) and its
  # stdout/stderr are discarded (so it can never alter the tool's output); the human recommendation goes
  # to /dev/tty directly. '|| true' makes any precall failure a no-op, so this step can never break or
  # block the tool. NO-TTY / piped runs (__itty=0) get NO prompt and NO mutation.
  __itty=0
  if [ -t 0 ] && [ -t 1 ]; then __itty=1; fi
  "$COMPACTION_BIN" precall ${captureTool} --interactive "$__itty" -- "$@" </dev/null >/dev/null 2>&1 || true

  __tmp="$(mktemp "\${TMPDIR:-/tmp}/compaction-${cfg.shimName}-XXXXXX" 2>/dev/null)" || exec "$REAL_BIN" "$@"
  # Transparent: the user sees identical stdout via tee; stderr passes straight through; the real
  # binary's exit code is preserved via PIPESTATUS (never tee's or the capture call's).
  "$REAL_BIN" "$@" | tee "$__tmp"
  __code=\${PIPESTATUS[0]}
  # Content-free capture side effect - never touches the user's stdout/stderr or exit code.
  ${captureSnippet(tool)}
  rm -f "$__tmp" >/dev/null 2>&1 || true
  exit "$__code"
else
  exec "$REAL_BIN" "$@"
fi
`;
}

/** Does the file at `shimPath` look like a Compaction shim (marker present)? Content-free identity. */
export function fileIsCompactionShim(shimPath: string): boolean {
  try {
    return readFileSync(shimPath, "utf8").includes(`${SHIM_MARKER}:`);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Verify: a "connected/active" claim may rest ONLY on this resolve-check.
 * ---------------------------------------------------------------------------------------------- */

export interface ShimVerification {
  tool: ShimTool;
  /** The path the shim WOULD live at. */
  shimPath: string;
  /** Whether the shim FILE exists on disk (installed), independent of PATH. */
  installed: boolean;
  /** What the shim NAME resolves to on the CURRENT PATH (first match), or undefined. */
  resolvedPath?: string;
  /** TRUE only when the shim name resolves to OUR shim file on PATH - the sole basis for "active". */
  onPath: boolean;
  /** TRUE only when installed AND resolves to our shim on PATH. NEVER claim connected without this. */
  active: boolean;
  /** The exact one line to prepend to PATH to activate the shim (shown when not-yet-active). */
  exportLine: string;
  /** The shim directory. */
  shimDir: string;
}

/** The exact PATH line the user adds (or `--write-shell-config` appends) to activate the shim dir. */
export function shimExportLine(env: ShimEnv = process.env): string {
  const dir = resolveShimDir(env);
  // Prefer a $HOME-relative form for the default location (matches what the user will recognize).
  const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
  const defaultDir = path.join(home, ".compaction", "shims");
  const shown = path.resolve(dir) === path.resolve(defaultDir) ? '$HOME/.compaction/shims' : dir;
  return `export PATH="${shown}:$PATH"`;
}

/**
 * Resolve-verify whether the shim for `tool` is ACTIVE: the shim file exists AND the tool name
 * resolves to that shim on the current PATH (the shim dir is on PATH ahead of the real binary).
 */
export function verifyShimActive(tool: ShimTool, env: ShimEnv = process.env): ShimVerification {
  const shimDir = resolveShimDir(env);
  const shimPath = shimPathFor(tool, env);
  const installed = existsSync(shimPath) && fileIsCompactionShim(shimPath);
  // Resolve the shim NAME on the FULL PATH (do NOT exclude the shim dir - we want to know whether it
  // wins). onPath is true only when that first match IS our shim file.
  const resolvedPath = resolveExecutableOnPath(SHIM_TOOLS[tool].shimName, env);
  const onPath = installed && resolvedPath !== undefined && path.resolve(resolvedPath) === path.resolve(shimPath);
  return {
    tool,
    shimPath,
    installed,
    ...(resolvedPath !== undefined ? { resolvedPath } : {}),
    onPath,
    active: installed && onPath,
    exportLine: shimExportLine(env),
    shimDir
  };
}

/* ------------------------------------------------------------------------------------------------
 * Install (write → re-read → verify) and uninstall (reversible).
 * ---------------------------------------------------------------------------------------------- */

export type InstallShimStatus =
  | "installed-active" // shim written, re-read OK, AND resolves to our shim on PATH
  | "installed-not-on-path" // shim written + re-read OK, but the shim dir is NOT yet on PATH (not active)
  | "already-active" // shim was already present + on PATH (idempotent)
  | "no-real-binary" // the tool is not installed on PATH - nothing written (never shim a missing command)
  | "verify-failed"; // a write was attempted but the re-read did not confirm the shim (never claim active)

export interface InstallShimResult {
  tool: ShimTool;
  status: InstallShimStatus;
  shimName: string;
  shimDir: string;
  shimPath: string;
  /** The absolute real-binary path recorded in the shim (present unless status is no-real-binary). */
  realBin?: string;
  /** The resolve-verification AFTER install. */
  verification: ShimVerification;
  /** The exact PATH line to add when not-yet-active. */
  exportLine: string;
}

const RECORD_FILENAME = ".shim-record.json";

interface ShimRecord {
  version: 1;
  shims: Record<string, { shimName: string; realBin: string; installedAt: string }>;
}

function recordPath(env: ShimEnv): string {
  return path.join(resolveShimDir(env), RECORD_FILENAME);
}

function readRecord(env: ShimEnv): ShimRecord {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(env), "utf8")) as ShimRecord;
    if (parsed && typeof parsed === "object" && parsed.shims) return parsed;
  } catch {
    /* fall through to empty */
  }
  return { version: 1, shims: {} };
}

function writeRecord(env: ShimEnv, record: ShimRecord): void {
  writeFileSync(recordPath(env), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export interface InstallShimOptions {
  now?: () => string;
}

/**
 * Install the shim for `tool`: resolve the real binary (excluding our shim dir so it can never point
 * at itself), write the shim script + a real-path record, then RE-READ the shim file to confirm it
 * landed with the marker and the recorded real path, and finally resolve-verify PATH activation. The
 * caller may only present "connected" for `installed-active` / `already-active` - never for
 * `installed-not-on-path` (print the export line) or `verify-failed` (nothing is claimed).
 */
export function installToolShim(tool: ShimTool, env: ShimEnv = process.env, options: InstallShimOptions = {}): InstallShimResult {
  const now = options.now ?? (() => new Date().toISOString());
  const shimDir = resolveShimDir(env);
  const shimPath = shimPathFor(tool, env);
  const shimName = SHIM_TOOLS[tool].shimName;
  const exportLine = shimExportLine(env);

  // Idempotent: already installed + active → report without rewriting.
  const before = verifyShimActive(tool, env);
  if (before.active) {
    const record = readRecord(env);
    return {
      tool,
      status: "already-active",
      shimName,
      shimDir,
      shimPath,
      ...(record.shims[tool]?.realBin ? { realBin: record.shims[tool].realBin } : {}),
      verification: before,
      exportLine
    };
  }

  // Resolve the REAL binary BEFORE (re)writing the shim, excluding the shim dir (never itself).
  const realBin = resolveExecutableOnPath(shimName, env, [shimDir]);
  if (realBin === undefined) {
    return {
      tool,
      status: "no-real-binary",
      shimName,
      shimDir,
      shimPath,
      verification: before,
      exportLine
    };
  }

  mkdirSync(shimDir, { recursive: true });
  let managedLauncher: string | undefined;
  try { managedLauncher = loadManagedInstallation(defaultManagedRoot(env as NodeJS.ProcessEnv), false).receipt.launcherPath; } catch { /* Nonmanaged installs retain their existing shim flow. */ }
  writeFileSync(shimPath, generateShimScript(tool, realBin, managedLauncher), "utf8");
  chmodSync(shimPath, 0o755);
  const record = readRecord(env);
  record.shims[tool] = { shimName, realBin, installedAt: now() };
  writeRecord(env, record);

  // RE-READ to verify the write landed (marker present + recorded real path baked in + executable).
  let reReadOk = false;
  try {
    const contents = readFileSync(shimPath, "utf8");
    const st = statSync(shimPath);
    reReadOk = contents.includes(`${SHIM_MARKER}: ${tool}`) && contents.includes(realBin) && (st.mode & 0o111) !== 0;
  } catch {
    reReadOk = false;
  }
  if (!reReadOk) {
    return { tool, status: "verify-failed", shimName, shimDir, shimPath, realBin, verification: verifyShimActive(tool, env), exportLine };
  }

  const verification = verifyShimActive(tool, env);
  return {
    tool,
    status: verification.active ? "installed-active" : "installed-not-on-path",
    shimName,
    shimDir,
    shimPath,
    realBin,
    verification,
    exportLine
  };
}

export type UninstallShimStatus = "removed" | "not-installed";

export interface UninstallShimResult {
  tool: ShimTool;
  status: UninstallShimStatus;
  shimPath: string;
  /** Whether a shell-rc backup was restored (see `removeShellConfigPathLine`). */
  shellConfigRestored?: string;
}

/** Remove the shim file + its record entry (reversible: the real binary was never touched). */
export function uninstallToolShim(tool: ShimTool, env: ShimEnv = process.env): UninstallShimResult {
  const shimPath = shimPathFor(tool, env);
  const existed = existsSync(shimPath);
  if (existed) rmSync(shimPath, { force: true });
  const record = readRecord(env);
  if (record.shims[tool]) {
    delete record.shims[tool];
    try {
      writeRecord(env, record);
    } catch {
      /* record dir may already be gone; not fatal */
    }
  }
  return { tool, status: existed ? "removed" : "not-installed", shimPath };
}

/* ------------------------------------------------------------------------------------------------
 * Reversible shell-rc editing. Consent model: the connect/enable action writes the PATH line by
 * default WITH the write announced on stdout (rc path + backup path) and a --no-write-shell-config
 * opt-out; a backup is always made first and disconnect reverses the write.
 * ---------------------------------------------------------------------------------------------- */

const RC_BLOCK_START = "# >>> compaction shim PATH (added by `compaction init --connect --write-shell-config`) >>>";
const RC_BLOCK_END = "# <<< compaction shim PATH <<<";

/** Pick the user's shell rc file from $SHELL (zsh → ~/.zshrc, else ~/.bashrc). Content-free. */
export function resolveShellRcPath(env: ShimEnv = process.env): string {
  const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
  const shell = env.SHELL ?? "";
  if (shell.includes("zsh")) return path.join(home, ".zshrc");
  return path.join(home, ".bashrc");
}

/**
 * Whether `writeShellConfigPathLine` can produce a file this shell will ACTUALLY load, in a syntax it
 * understands. Only zsh and bash qualify: the rc resolver above falls back to `~/.bashrc` for anything
 * else, and the emitted `export PATH=…` is POSIX-shell syntax. Under fish (or any other non-POSIX
 * shell) that file is never read and the line would not parse if it were, so a write there activates
 * nothing — a caller that reported it as activation would send the user into exactly the new-shell dead
 * end the write exists to remove.
 *
 * An EMPTY/absent `$SHELL` counts as supported: that is the pre-existing bash default this resolver has
 * always applied (a login shell sets `$SHELL`; a bare subprocess env is not evidence of an exotic one).
 *
 * This is an HONEST-DEGRADE predicate, not shell support: callers that see `false` must skip the write
 * and print the manual PATH line instead. It does not teach Compaction to write fish config.
 */
export function shellConfigWriteIsSupported(env: ShimEnv = process.env): boolean {
  const shell = (env.SHELL ?? "").trim();
  if (shell === "") return true;
  return shell.includes("zsh") || shell.includes("bash");
}

export interface WriteShellConfigResult {
  status: "appended" | "already-present" | "no-rc-file-created";
  rcPath: string;
  backupPath?: string;
  exportLine: string;
}

/** True iff the marked Compaction PATH block (or the exact export line) is already in the shell rc. */
export function isShellConfigPathLinePresent(env: ShimEnv = process.env): boolean {
  const rcPath = resolveShellRcPath(env);
  if (!existsSync(rcPath)) return false;
  const contents = readFileSync(rcPath, "utf8");
  return contents.includes(RC_BLOCK_START) || contents.includes(shimExportLine(env));
}

/**
 * Append the shim PATH line to the user's shell rc. Callers must pair this with a consent gesture
 * (an enable action whose output announces the write + backup and offers `--no-write-shell-config`,
 * or an explicit `--write-shell-config`). A `.compaction.bak` backup is written FIRST (reversible),
 * the block is clearly marked, and the append is idempotent (already-present → no change). Never
 * overwrites existing content.
 */
export function writeShellConfigPathLine(env: ShimEnv = process.env): WriteShellConfigResult {
  const rcPath = resolveShellRcPath(env);
  const exportLine = shimExportLine(env);
  const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
  if (existing.includes(RC_BLOCK_START) || existing.includes(exportLine)) {
    return { status: "already-present", rcPath, exportLine };
  }
  const backupPath = `${rcPath}.compaction.bak`;
  let createdBackup: string | undefined;
  if (existsSync(rcPath)) {
    copyFileSync(rcPath, backupPath);
    createdBackup = backupPath;
  }
  const block = `\n${RC_BLOCK_START}\n${exportLine}\n${RC_BLOCK_END}\n`;
  writeFileSync(rcPath, existing + block, "utf8");
  return {
    status: existing === "" ? "no-rc-file-created" : "appended",
    rcPath,
    ...(createdBackup ? { backupPath: createdBackup } : {}),
    exportLine
  };
}

export interface RemoveShellConfigResult {
  status: "removed" | "not-present" | "no-rc-file";
  rcPath: string;
  backupRestored?: string;
}

/**
 * Reverse `writeShellConfigPathLine`: strip the marked block from the rc file. When a
 * `.compaction.bak` backup exists AND the file is otherwise unchanged since the backup, the backup
 * is restored verbatim (byte-exact reversal); when the user edited the rc AFTER the write, only OUR
 * marked block is removed so their later edits are never lost. The backup is consumed either way.
 */
export function removeShellConfigPathLine(env: ShimEnv = process.env): RemoveShellConfigResult {
  const rcPath = resolveShellRcPath(env);
  if (!existsSync(rcPath)) return { status: "no-rc-file", rcPath };
  const backupPath = `${rcPath}.compaction.bak`;
  const contents = readFileSync(rcPath, "utf8");
  if (!contents.includes(RC_BLOCK_START)) return { status: "not-present", rcPath };
  const stripped = contents.replace(new RegExp(`\\n?${escapeRegExp(RC_BLOCK_START)}[\\s\\S]*?${escapeRegExp(RC_BLOCK_END)}\\n?`, "g"), "\n");
  if (existsSync(backupPath)) {
    const backup = readFileSync(backupPath, "utf8");
    // Byte-exact reversal only when nothing else changed; otherwise preserve the user's later edits.
    if (stripped === backup || stripped === `${backup}\n`) {
      copyFileSync(backupPath, rcPath);
      rmSync(backupPath, { force: true });
      return { status: "removed", rcPath, backupRestored: backupPath };
    }
    writeFileSync(rcPath, stripped, "utf8");
    rmSync(backupPath, { force: true });
    return { status: "removed", rcPath };
  }
  // No backup (block appended to a then-nonexistent file): remove the marked block only.
  writeFileSync(rcPath, stripped, "utf8");
  return { status: "removed", rcPath };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
