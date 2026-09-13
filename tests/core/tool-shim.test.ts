import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installToolShim,
  uninstallToolShim,
  verifyShimActive,
  resolveExecutableOnPath,
  generateShimScript,
  shimExportLine,
  writeShellConfigPathLine,
  removeShellConfigPathLine,
  fileIsCompactionShim,
  SHIM_MARKER,
  type ShimEnv
} from "../../src/core/tool-shim.js";

/**
 * Synthetic-only: every test uses a tmp HOME/PATH via the env override, it NEVER touches the real
 * ~/.compaction or a real shell rc.
 */
let root: string;
let realBinDir: string;
let home: string;
let compactionHome: string;

function makeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, "#!/usr/bin/env bash\necho real\n", "utf8");
  chmodSync(p, 0o755);
  return p;
}

function envWith(pathValue: string): ShimEnv {
  return { HOME: home, COMPACTION_HOME: compactionHome, PATH: pathValue, SHELL: "/bin/zsh" };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "shim-test-"));
  realBinDir = path.join(root, "realbin");
  home = path.join(root, "home");
  compactionHome = path.join(home, ".compaction");
  mkdirSync(home, { recursive: true });
  makeExecutable(realBinDir, "codex");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("tool-shim install → verify → uninstall", () => {
  it("resolveExecutableOnPath finds the real binary and EXCLUDES the shim dir (no self-recursion)", () => {
    const env = envWith(realBinDir);
    const shimDir = path.join(compactionHome, "shims");
    const resolved = resolveExecutableOnPath("codex", env, [shimDir]);
    expect(resolved).toBe(path.resolve(realBinDir, "codex"));
  });

  it("install without the shim dir on PATH is 'installed-not-on-path' - NEVER claimed active", () => {
    const env = envWith(realBinDir); // shim dir NOT on PATH
    const result = installToolShim("codex", env);
    expect(result.status).toBe("installed-not-on-path");
    expect(result.verification.active).toBe(false);
    expect(result.verification.installed).toBe(true);
    // The exact one line to add is surfaced, and it prepends the shim dir.
    expect(result.exportLine).toContain(".compaction/shims");
    expect(result.exportLine.startsWith("export PATH=")).toBe(true);
    // The shim baked the REAL binary path (never itself).
    expect(result.realBin).toBe(path.resolve(realBinDir, "codex"));
    const contents = readFileSync(result.shimPath, "utf8");
    expect(contents).toContain(`${SHIM_MARKER}: codex`);
    expect(contents).toContain(path.resolve(realBinDir, "codex"));
    expect(contents).not.toContain(result.shimPath); // never execs itself
  });

  it("install becomes 'installed-active' once the shim dir is on PATH ahead of the real binary", () => {
    const shimDir = path.join(compactionHome, "shims");
    // First install (dir not yet on PATH).
    installToolShim("codex", envWith(realBinDir));
    // Now the shim dir is first on PATH → resolve-verify says active.
    const activeEnv = envWith(`${shimDir}${path.delimiter}${realBinDir}`);
    const v = verifyShimActive("codex", activeEnv);
    expect(v.active).toBe(true);
    expect(path.resolve(v.resolvedPath ?? "")).toBe(path.resolve(shimDir, "codex"));
    // Re-install is idempotent → already-active.
    expect(installToolShim("codex", activeEnv).status).toBe("already-active");
  });

  it("a shim dir AFTER the real binary on PATH is NOT active (honest: appended PATH does not shadow)", () => {
    const shimDir = path.join(compactionHome, "shims");
    installToolShim("codex", envWith(realBinDir));
    const appendedEnv = envWith(`${realBinDir}${path.delimiter}${shimDir}`);
    expect(verifyShimActive("codex", appendedEnv).active).toBe(false);
  });

  it("no real binary on PATH → 'no-real-binary', nothing written (never shim a missing command)", () => {
    const env = envWith(path.join(root, "empty")); // no codex anywhere
    const result = installToolShim("codex", env);
    expect(result.status).toBe("no-real-binary");
    expect(existsSync(result.shimPath)).toBe(false);
  });

  it("uninstall removes the shim and never touches the real binary (reversible)", () => {
    const env = envWith(realBinDir);
    const install = installToolShim("codex", env);
    expect(existsSync(install.shimPath)).toBe(true);
    const un = uninstallToolShim("codex", env);
    expect(un.status).toBe("removed");
    expect(existsSync(install.shimPath)).toBe(false);
    // The real binary is untouched.
    expect(existsSync(path.join(realBinDir, "codex"))).toBe(true);
    expect(fileIsCompactionShim(path.join(realBinDir, "codex"))).toBe(false);
    // Second uninstall is a clean no-op.
    expect(uninstallToolShim("codex", env).status).toBe("not-installed");
  });
});

describe("tool-shim reversible shell-rc editing (opt-in only)", () => {
  it("writeShellConfigPathLine backs up (.bak) then appends; removeShellConfigPathLine restores it", () => {
    const env = envWith(realBinDir);
    const rcPath = path.join(home, ".zshrc");
    writeFileSync(rcPath, "# my existing rc\nexport FOO=1\n", "utf8");
    const original = readFileSync(rcPath, "utf8");

    const wrote = writeShellConfigPathLine(env);
    expect(wrote.status).toBe("appended");
    expect(wrote.backupPath).toBe(`${rcPath}.compaction.bak`);
    expect(existsSync(wrote.backupPath!)).toBe(true);
    expect(readFileSync(rcPath, "utf8")).toContain(shimExportLine(env));
    // The user's original content is preserved (append, never overwrite).
    expect(readFileSync(rcPath, "utf8")).toContain("export FOO=1");

    // Idempotent: a second write is a no-op.
    expect(writeShellConfigPathLine(env).status).toBe("already-present");

    // Reverse: restores the pre-edit file byte-for-byte and drops the backup.
    const removed = removeShellConfigPathLine(env);
    expect(removed.status).toBe("removed");
    expect(readFileSync(rcPath, "utf8")).toBe(original);
    expect(existsSync(wrote.backupPath!)).toBe(false);
  });
});

describe("generateShimScript honesty", () => {
  it("routes normal Codex exactly once through the ChatGPT-subscription gateway and preserves override bypass", () => {
    const script = generateShimScript("codex", "/abs/real/codex");
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain(`${SHIM_MARKER}: codex`);
    expect(script).toContain("/abs/real/codex");
    expect(script).toContain("gateway run --provider openai --workflow codex --subscription --");
    expect(script).toContain('exec "$REAL_BIN" "$@"');
    expect(script).toContain('${OPENAI_BASE_URL:-}');
    expect(script).toContain('${OPENAI_API_BASE:-}');
    expect(script).toContain("model_provider=*");
    expect(script).toContain("model_providers.*.base_url=*");
    // Legacy tee/capture remains inside the explicit-override/fail-open function only; the routed
    // branch names the Gateway receipt as its sole post-call measurement.
    expect(script).toContain('tee "$__tmp"');
    expect(script).toContain("capture codex");
    expect(script).toContain("Gateway receipt replaces ONLY the post-hoc tee/capture bridge");
  });

  it("the cursor shim forwards the original invocation for a LOCAL-ESTIMATE input count", () => {
    const script = generateShimScript("cursor", "/abs/real/cursor-agent");
    expect(script).toContain("--output-format");
    expect(script).toContain('capture cursor --from-shim "$__tmp" -- cursor-agent "$@"');
  });
});
