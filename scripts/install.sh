#!/bin/sh
# compaction.dev installer
# ---------------------------------------------------------------------------
# Install:  curl -fsSL https://cli.compaction.dev/install | sh
# (Hosted path is /install with no extension; this file is scripts/install.sh.)
#
# This script is intentionally SHORT, READABLE, and TRANSPARENT. Read it before
# piping it to a shell. Properties:
#
#   * POSIX sh — portable; does not require bash.
#   * NO sudo by default — installs into a user-writable prefix. A system prefix
#     is only ever used if you explicitly request one (and you run sudo, not us).
#   * NO telemetry — public npm metadata, package, and signature verification.
#     Managed installs check about daily; no work content or provider credentials.
#     Entitled accounts may also acquire the signed engine after EULA acceptance.
#   * Fail-safe — set -e/-u, a trap on error, required-tool checks up front,
#     and clear messages.
#   * Honest about publish state — the package (`@compaction/cli`) is published
#     to npm. A real run installs it via the npm step below; if npm cannot find
#     it, the run FAILS with a clear message and never fakes success.
#   * --dry-run prints exactly what it WOULD do without installing.
#
# Env overrides:
#   COMPACTION_PACKAGE  package name to install     (default: @compaction/cli)
#   COMPACTION_VERSION  version / dist-tag           (default: latest)
#   COMPACTION_PREFIX   npm global prefix to use     (default: $HOME/.local)
#   COMPACTION_DRY_RUN  set to 1 for dry-run         (same as --dry-run)
#
# Flags:
#   --dry-run   print the resolved package/version/prefix and the npm command,
#               then exit WITHOUT installing.
#   -h|--help   print usage.
# ---------------------------------------------------------------------------

set -eu

# --- defaults (override via env; see header) -------------------------------
COMPACTION_PACKAGE="${COMPACTION_PACKAGE:-@compaction/cli}"
COMPACTION_VERSION="${COMPACTION_VERSION:-latest}"
COMPACTION_PREFIX="${COMPACTION_PREFIX:-$HOME/.local}"
COMPACTION_DRY_RUN="${COMPACTION_DRY_RUN:-0}"

# The binary the package exposes (package.json "bin"). Used only for guidance.
BIN_NAME="compaction"

# --- tiny output helpers ---------------------------------------------------
info() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
err()  { printf 'error: %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
compaction.dev installer

Usage:
  install.sh [--dry-run]
  curl -fsSL https://cli.compaction.dev/install | sh
  curl -fsSL https://cli.compaction.dev/install | sh -s -- --dry-run

Options:
  --dry-run     Print the resolved package/version/prefix and the npm command
                that WOULD run, then exit without installing.
  -h, --help    Show this help.

Environment overrides:
  COMPACTION_PACKAGE   package name      (default: @compaction/cli)
  COMPACTION_VERSION   version/dist-tag  (default: latest)
  COMPACTION_PREFIX    npm prefix        (default: $HOME/.local)
  COMPACTION_DRY_RUN   1 = dry-run       (default: 0)
  COMPACTION_AUTO_UPDATE  0 = persist automatic-update opt-out
  COMPACTION_LOCAL_ARTIFACT + COMPACTION_LOCAL_SHA256 + exact COMPACTION_VERSION
                      explicitly reviewed local release (automatic updates off)

Managed installation requires Node.js >= 18 and npm >= 8.15.
This installer uses NO sudo by default and collects NO telemetry. Official
managed installs verify public npm releases and check about daily for updates.
An entitled account may acquire a signed engine after exact EULA acceptance.
Use compaction update --auto off to opt out. Exact-version installs are pinned.
Direct npm and custom-package installs remain package-manager-owned.
See https://compaction.dev.
EOF
}

# --- failure trap (clear partial-failure message) --------------------------
# Set a flag once we reach a clean, intended exit so the trap stays quiet then.
COMPACTION_DONE=0
bootstrap_scratch=""
on_exit() {
  status=$?
  if [ -n "$bootstrap_scratch" ]; then rm -rf "$bootstrap_scratch"; fi
  if [ "$COMPACTION_DONE" -eq 0 ] && [ "$status" -ne 0 ]; then
    err "installation did not complete (exit ${status})."
    err "A failed managed stage does not replace the active release. Re-run to resume."
    if [ "$COMPACTION_PACKAGE" != "@compaction/cli" ]; then
      err "For a partial custom global install: npm --prefix \"${COMPACTION_PREFIX}\" uninstall -g \"${COMPACTION_PACKAGE}\""
    fi
    err "Then re-run, or see https://compaction.dev."
  fi
}
trap on_exit EXIT

# --- parse args ------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --dry-run) COMPACTION_DRY_RUN=1 ;;
    -h|--help) usage; COMPACTION_DONE=1; exit 0 ;;
    *) err "unknown argument: $arg"; usage >&2; COMPACTION_DONE=1; exit 2 ;;
  esac
done

# --- platform check --------------------------------------------------------
# Supported: macOS (Darwin) and Linux. Anything else is rejected clearly.
os="$(uname -s 2>/dev/null || echo unknown)"
case "$os" in
  Darwin) platform="macOS" ;;
  Linux)  platform="Linux" ;;
  *)
    err "unsupported platform: ${os}."
    err "compaction.dev's installer supports macOS and Linux."
    err "On Windows, use WSL, or install with npm directly:"
    err "  npm install -g ${COMPACTION_PACKAGE}@${COMPACTION_VERSION}"
    exit 1
    ;;
esac

# --- required tools --------------------------------------------------------
# We install via npm, so node + npm are required. Check up front with a clear
# message rather than failing midway.
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required tool not found on PATH: $1"
    err "compaction.dev managed installation requires Node.js >= 18 and npm >= 8.15."
    err "Install Node.js and npm from https://nodejs.org/"
    err "or your platform package manager, then re-run this installer."
    exit 1
  fi
}
need node
need npm

# --- Node.js version gate (>= 18) ------------------------------------------
# npm does NOT enforce package "engines" by default (engine-strict=false), so a
# real install can otherwise COMPLETE on Node 16/17 with only warnings, leaving
# the user on an unsupported runtime. Reject up front instead. This is a
# pre-flight rejection (nothing installed yet), so set the clean-exit flag so
# the EXIT trap's partial-install cleanup text does NOT print.
#
# POSIX sh only: parse `node -v` (format vMAJOR.MINOR.PATCH) with sed, not [[ ]].
NODE_MIN_MAJOR=18
node_version="$(env -i PATH="$PATH" node -v 2>/dev/null || echo '')"
# Strip leading 'v' and everything from the first '.' or '-', leaving the major.
node_major="$(printf '%s' "$node_version" | sed -e 's/^v//' -e 's/[.-].*$//')"
case "$node_major" in
  ''|*[!0-9]*)
    err "could not determine the Node.js version from 'node -v' (got: '${node_version:-<empty>}')."
    err "compaction.dev requires Node.js >= ${NODE_MIN_MAJOR}. Install a current"
    err "release from https://nodejs.org/ or your package manager, then re-run."
    COMPACTION_DONE=1
    exit 1
    ;;
esac
if [ "$node_major" -lt "$NODE_MIN_MAJOR" ]; then
  err "Node.js ${node_version} is too old: compaction.dev requires Node.js >= ${NODE_MIN_MAJOR}."
  err "npm will not enforce this on its own, so this installer checks it up front."
  err "Upgrade Node.js (https://nodejs.org/ or your package manager — e.g. with nvm:"
  err "  nvm install ${NODE_MIN_MAJOR} && nvm use ${NODE_MIN_MAJOR}"
  err "), then re-run this installer."
  COMPACTION_DONE=1
  exit 1
fi

# --- resolve the npm command -----------------------------------------------
# --prefix keeps the global install inside a user-writable location, so no sudo
# is required. The user-chosen COMPACTION_PREFIX is honored as-is.
pkg_spec="${COMPACTION_PACKAGE}@${COMPACTION_VERSION}"
bin_dir="${COMPACTION_PREFIX}/bin"

# --- dry-run: print intentions, do NOT install -----------------------------
if [ "$COMPACTION_DRY_RUN" = "1" ]; then
  info "compaction.dev installer — DRY RUN (nothing will be installed)"
  info "  platform:    ${platform}"
  info "  package:     ${COMPACTION_PACKAGE}"
  info "  version:     ${COMPACTION_VERSION}"
  info "  prefix:      ${COMPACTION_PREFIX}  (user-writable; no sudo)"
  info "  bin dir:     ${bin_dir}"
  if [ "$COMPACTION_PACKAGE" = "@compaction/cli" ]; then
    info "  would run:   npm install --ignore-scripts \"${pkg_spec}\" in isolated temporary storage"
    info "  then verify and bootstrap the stable managed launcher in ${bin_dir}"
  else
    info "  would run:   npm install -g --prefix \"${COMPACTION_PREFIX}\" \"${pkg_spec}\""
  fi
  info ""
  info "No network call was made. No telemetry. To actually install, re-run"
  info "without --dry-run."
  COMPACTION_DONE=1
  exit 0
fi

# --- real install ----------------------------------------------------------
info "compaction.dev installer"
info "  installing ${pkg_spec} into ${COMPACTION_PREFIX} (no sudo)"
info ""

# Custom package overrides retain their existing package-manager-owned installation.
if [ "$COMPACTION_PACKAGE" != "@compaction/cli" ]; then
  npm install -g --prefix "${COMPACTION_PREFIX}" "${pkg_spec}"
else
  # The bootstrap package lives only in a fresh temporary prefix: npm never owns
  # the stable launcher's destination. Inherited npm configuration is excluded.
  bootstrap_scratch="$(mktemp -d "${TMPDIR:-/tmp}/compaction-bootstrap.XXXXXXXX")"
  mkdir -p "$bootstrap_scratch/home" "$bootstrap_scratch/tmp"
  : > "$bootstrap_scratch/npmrc"
  : > "$bootstrap_scratch/global-npmrc"
  isolated_npm() (
    cd "$bootstrap_scratch"
    env -i PATH="$PATH" HOME="$bootstrap_scratch/home" TMPDIR="$bootstrap_scratch/tmp" CI=1 \
      NPM_CONFIG_USERCONFIG="$bootstrap_scratch/npmrc" NPM_CONFIG_GLOBALCONFIG="$bootstrap_scratch/global-npmrc" \
      NPM_CONFIG_REGISTRY=https://registry.npmjs.org NPM_CONFIG_CACHE="$bootstrap_scratch/cache" \
      NPM_CONFIG_IGNORE_SCRIPTS=true NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false \
      NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FETCH_RETRIES=0 NPM_CONFIG_FETCH_TIMEOUT=20000 \
      npm "$@"
  )
  local_artifact="${COMPACTION_LOCAL_ARTIFACT:-}"
  if [ -n "$local_artifact" ]; then
    local_artifact="$(env -i PATH="$PATH" node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$local_artifact")"
    env -i PATH="$PATH" node -e '
      const fs=require("node:fs"),crypto=require("node:crypto");
      const hash=crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");
      if(!/^[a-f0-9]{64}$/.test(process.argv[2]) || hash!==process.argv[2] ||
         !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(process.argv[3])) process.exit(1);
    ' "$local_artifact" "${COMPACTION_LOCAL_SHA256:-}" "$COMPACTION_VERSION" || {
      err 'Local artifact requires an exact matching SHA-256 and version.'; exit 1;
    }
    pkg_spec="$local_artifact"
  fi
  isolated_npm install --ignore-scripts --no-audit --no-fund --save-exact --workspaces=false "$pkg_spec"
  # Local artifact identity is explicitly supplied; every registry dependency still
  # needs integrity and signature verification before executing the bootstrap.
  env -i PATH="$PATH" node -e '
    const lock=require(process.argv[1]); let count=0;
    for(const [name,p] of Object.entries(lock.packages||{})) {
      if(name==="" || name==="node_modules/@compaction/cli") continue;
      if(!p.resolved || new URL(p.resolved).origin!=="https://registry.npmjs.org" || !p.integrity) process.exit(1);
      count++;
    }
    require("node:fs").writeFileSync(process.argv[2],String(count));
  ' "$bootstrap_scratch/package-lock.json" "$bootstrap_scratch/dependency-count"
  if [ -z "$local_artifact" ] || [ "$(cat "$bootstrap_scratch/dependency-count")" -gt 0 ]; then
    isolated_npm audit signatures --json --workspaces=false
  fi
  bootstrap="$bootstrap_scratch/node_modules/@compaction/cli/dist/core/update/bootstrap.js"
  [ -f "$bootstrap" ] || { err 'This release predates managed updating; rerun after upgrading to an Update-capable release.'; exit 1; }
  env -i PATH="$PATH" HOME="$HOME" \
    COMPACTION_CONFIG_DIR="${COMPACTION_CONFIG_DIR:-}" COMPACTION_HOME="${COMPACTION_HOME:-}" \
    COMPACTION_PREFIX="$COMPACTION_PREFIX" COMPACTION_VERSION="$COMPACTION_VERSION" \
    COMPACTION_LOCAL_ARTIFACT="$local_artifact" COMPACTION_LOCAL_SHA256="${COMPACTION_LOCAL_SHA256:-}" \
    COMPACTION_AUTO_UPDATE="${COMPACTION_AUTO_UPDATE:-1}" node "$bootstrap"
  rm -rf "$bootstrap_scratch"
  bootstrap_scratch=""
fi

# --- post-install verification ---------------------------------------------
# Confirm the install actually produced a runnable binary instead of trusting
# npm's exit code alone. We invoke the freshly installed binary by its absolute
# path (${bin_dir}/${BIN_NAME}) so this works even before ${bin_dir} is on PATH.
# This is a LOCAL exec of the just-installed CLI — no network, no telemetry, no
# sudo. We try `--version` first and fall back to `--help`; if neither runs, the
# install did not yield a working command and we say so clearly (non-zero exit).
installed_bin="${bin_dir}/${BIN_NAME}"
verify_installed() {
  env -i PATH="$PATH" HOME="$HOME" COMPACTION_CONFIG_DIR="${COMPACTION_CONFIG_DIR:-}" \
    COMPACTION_HOME="${COMPACTION_HOME:-}" COMPACTION_AUTO_UPDATE=0 "${installed_bin}" "$@"
}
if [ -x "${installed_bin}" ]; then
  if verify_installed --version >/dev/null 2>&1; then
    info "Verified: ${BIN_NAME} --version runs."
  elif verify_installed --help >/dev/null 2>&1; then
    info "Verified: ${BIN_NAME} --help runs."
  else
    err ""
    err "${COMPACTION_PACKAGE} installed, but '${BIN_NAME} --version'/'--help' did"
    err "not run from ${installed_bin}. The install may be incomplete."
    err "See https://compaction.dev."
    exit 1
  fi
else
  err ""
  err "${COMPACTION_PACKAGE} reported as installed, but the '${BIN_NAME}' binary"
  err "was not found at ${installed_bin}. The install may be incomplete."
  err "See https://compaction.dev."
  exit 1
fi

# --- post-install screen ---------------------------------------------------
# A calm, branded confirmation: version, where it landed, a PATH check with the
# exact fix if needed, the one-line value promise, and the single next command.
# We DO NOT auto-run `compaction init` — we only highlight it. ANSI color is
# gated on an interactive stdout ([ -t 1 ]) so piped/redirected output stays
# plain text. This is local-only formatting: no network, no telemetry, no sudo.

# Resolve the installed version for display (best-effort, local exec only).
installed_version="$(verify_installed --version 2>/dev/null | head -n 1 || true)"
[ -n "$installed_version" ] || installed_version="${COMPACTION_VERSION}"

# Color helpers, only when stdout is a TTY. Brand accent = bold blue (#3231cd).
if [ -t 1 ]; then
  c_reset="$(printf '\033[0m')"
  c_bold="$(printf '\033[1m')"
  c_dim="$(printf '\033[2m')"
  c_accent="$(printf '\033[1m\033[38;2;50;49;205m')"
else
  c_reset=""; c_bold=""; c_dim=""; c_accent=""
fi

# Is the bin dir already on PATH? Match it as a whole :-delimited entry.
case ":${PATH}:" in
  *":${bin_dir}:"*) on_path=1 ;;
  *)                on_path=0 ;;
esac

info ""
info "${c_accent}C O M P A C T I O N${c_reset}  installed"
info ""
info "  ${c_dim}version${c_reset}   ${installed_version}"
info "  ${c_dim}prefix${c_reset}    ${COMPACTION_PREFIX}"
info "  ${c_dim}binary${c_reset}    ${installed_bin}"
if [ "$on_path" -eq 1 ]; then
  info "  ${c_dim}PATH${c_reset}      ok — ${bin_dir} is on your PATH"
else
  info "  ${c_dim}PATH${c_reset}      ${bin_dir} is NOT on your PATH yet. Add it:"
  info "            export PATH=\"${bin_dir}:\$PATH\""
fi
info ""
info "  Find and reduce avoidable context spend in real agent workflows, locally."
info ""

# Flow straight into onboarding when a real terminal is present. `curl | sh` leaves
# fd 0 on the download stream, so we reattach stdin to the controlling terminal
# (/dev/tty) to reconnect the keyboard for the interactive stepper. Onboarding is
# read-only until you explicitly enable a tool, so this writes nothing on its own.
# Skipped when non-interactive (no TTY: CI, pipes, redirected output) or opted out
# via COMPACTION_NO_ONBOARD=1; then we just print the next command.
if [ "${COMPACTION_NO_ONBOARD:-0}" != "1" ] && [ -t 1 ] && [ -r /dev/tty ]; then
  info "  ${c_dim}Starting onboarding (skip next time with COMPACTION_NO_ONBOARD=1)${c_reset}"
  info ""
  COMPACTION_DONE=1
  exec "${installed_bin}" < /dev/tty
fi

info "  Next:  ${c_bold}${BIN_NAME}${c_reset}"

COMPACTION_DONE=1
exit 0
