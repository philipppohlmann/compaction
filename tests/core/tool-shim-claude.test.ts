import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SHIM_TOOLS,
  generateShimScript,
  installToolShim,
  uninstallToolShim,
  verifyShimActive,
  type ShimEnv
} from "../../src/core/tool-shim.js";

/**
 * The `claude-code` gateway-routing shim: script invariants (fail-open structure, record-only, no
 * capture/mutation machinery) and the shared install → RE-READ → verify → uninstall lifecycle.
 */

let root: string;
let realBinDir: string;
let home: string;

function env(pathValue: string): ShimEnv {
  return { HOME: home, COMPACTION_HOME: path.join(home, ".compaction"), PATH: pathValue };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "claude-shim-"));
  realBinDir = path.join(root, "realbin");
  home = path.join(root, "home");
  mkdirSync(realBinDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const claude = path.join(realBinDir, "claude");
  writeFileSync(claude, "#!/usr/bin/env bash\necho real claude\n", "utf8");
  chmodSync(claude, 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("claude-code shim tool config", () => {
  it("is the gateway-route kind, installs as `claude`, and has no capture bridge config", () => {
    expect(SHIM_TOOLS["claude-code"].kind).toBe("gateway-route");
    expect(SHIM_TOOLS["claude-code"].shimName).toBe("claude");
    expect(SHIM_TOOLS["claude-code"].captureTool).toBeUndefined();
  });
});

describe("claude routing shim script generation", () => {
  const script = generateShimScript("claude-code", "/opt/real/claude");

  it("carries the marker, the baked real binary, and the compaction-bin override seam", () => {
    expect(script).toContain("COMPACTION_SHIM: claude-code");
    expect(script).toContain("REAL_BIN='/opt/real/claude'");
    expect(script).toContain('COMPACTION_BIN="${COMPACTION_BIN:-compaction}"');
  });

  it("routes via `gateway ensure --provider anthropic` and injects ONLY a loopback base", () => {
    expect(script).toContain("gateway ensure --provider anthropic");
    expect(script).toContain("http://127.0.0.1:[0-9]*");
    expect(script).toContain('ANTHROPIC_BASE_URL="$__base" exec "$REAL_BIN" "$@"');
  });

  it("is fail-open by structure: the unrouted exec of the real binary is the fallthrough", () => {
    // Any ensure failure leaves __base empty → the case does not match → the final exec runs.
    expect(script).toContain('__base=""');
    expect(script.trimEnd().endsWith('exec "$REAL_BIN" "$@"')).toBe(true);
  });

  it("never clobbers an existing ANTHROPIC_BASE_URL (no double-route, no override)", () => {
    expect(script).toContain('if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then');
    // The passthrough branch execs the real binary with no injection.
    const idx = script.indexOf('if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then');
    const branch = script.slice(idx, script.indexOf("fi", idx));
    expect(branch).toContain('exec "$REAL_BIN" "$@"');
  });

  it("stale-baked-path FAIL-OPEN: re-resolves claude from PATH with the shim's own dir removed (exact physical-dir match, no self-recursion)", () => {
    const idx = script.indexOf('if [ ! -x "$REAL_BIN" ]; then');
    expect(idx).toBeGreaterThan(-1);
    const block = script.slice(idx, script.indexOf("\nfi\n", idx));
    // PATH re-resolution happens INSIDE the stale-path branch, against a PATH stripped of the
    // shim's own directory, compared as resolved physical dirs, never as substrings.
    expect(block).toContain('pwd -P');
    expect(block).toContain('[ "$__abs" = "$__self_dir" ]');
    expect(block).toContain('PATH="$__clean_path" command -v claude');
    // Belt-and-braces: even a resolved candidate is refused if it IS this very file.
    expect(block).toContain('! [ "$__fallback" -ef "$0" ]');
    // The fallback exec is UNROUTED (plain exec, no ANTHROPIC_BASE_URL assignment on that line).
    expect(block).toContain('exec "$__fallback" "$@"');
    expect(block).not.toContain('ANTHROPIC_BASE_URL="$__base" exec "$__fallback"');
    // Only when nothing resolves does it error honestly.
    expect(block).toContain("no other claude is on PATH");
    expect(block).toContain("re-run 'compaction init --connect claude-code'");
    expect(block).toContain("exit 127");
  });

  it("contains NO capture/mutation machinery (record-only by construction)", () => {
    expect(script).not.toContain("precall");
    expect(script).not.toContain("capture");
    expect(script).not.toContain("tee ");
    expect(script).not.toContain("--stdin-file");
    expect(script).not.toContain("--mode apply");
  });
});

describe("claude-code shim install/verify/uninstall lifecycle (shared machinery)", () => {
  it("installs the `claude` shim, resolves the real binary, and verifies honestly", () => {
    const e = env(realBinDir);
    const install = installToolShim("claude-code", e);
    expect(install.status).toBe("installed-not-on-path"); // shim dir not on PATH yet, never 'active'
    expect(install.shimName).toBe("claude");
    expect(install.realBin).toBe(path.join(realBinDir, "claude"));
    expect(existsSync(install.shimPath)).toBe(true);
    expect(readFileSync(install.shimPath, "utf8")).toContain("COMPACTION_SHIM: claude-code");

    // With the shim dir ahead on PATH the resolve-verification flips active.
    const activeEnv = env(`${install.shimDir}${path.delimiter}${realBinDir}`);
    expect(verifyShimActive("claude-code", activeEnv).active).toBe(true);
    expect(installToolShim("claude-code", activeEnv).status).toBe("already-active");
  });

  it("never shims a missing claude binary", () => {
    const e = env("/nonexistent-dir");
    const install = installToolShim("claude-code", e);
    expect(install.status).toBe("no-real-binary");
    expect(existsSync(install.shimPath)).toBe(false);
  });

  it("uninstall removes the shim and never touches the real binary", () => {
    const e = env(realBinDir);
    const install = installToolShim("claude-code", e);
    const result = uninstallToolShim("claude-code", e);
    expect(result.status).toBe("removed");
    expect(existsSync(install.shimPath)).toBe(false);
    expect(existsSync(path.join(realBinDir, "claude"))).toBe(true);
  });
});
