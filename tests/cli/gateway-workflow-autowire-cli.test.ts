/**
 * Gateway `--workflow` auto-wiring CLI, the flag's SOURCE comes from the connect-once choice.
 *
 * HERMETIC: tmp HOME / COMPACTION_CONFIG_DIR (the preferences file is written directly, enum-only)
 * and a tmp cwd per test; no network call is made (the gateway binds locally and is killed after the
 * banner; no request is ever sent upstream).
 *
 * Proven here (safety framing, only the flag's source changed, not what it arms):
 * - `gateway start` with the flag OMITTED + a persisted provider-matched connect choice announces the
 *   auto-selected workflow honestly and runs with that identity (same banner line as an explicit flag);
 * - `--workflow none` disables the default (no workflow line, no auto note);
 * - with NOTHING persisted the omitted flag stays workflow-less (record semantics, unchanged behavior);
 * - an unknown `--workflow` value still fails closed with the clean flag error;
 * - `gateway run` with a generic (non-tool) command NEVER inherits the persisted identity.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLI = resolve("dist/cli/index.js");
const NODE_DIR = dirname(process.execPath);

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  dir = "";
});

function setupDir(connected?: string[]): { cwd: string; env: NodeJS.ProcessEnv } {
  dir = mkdtempSync(join(tmpdir(), "gw-autowire-"));
  const configDir = join(dir, ".compaction-home");
  mkdirSync(configDir, { recursive: true });
  if (connected) {
    writeFileSync(join(configDir, "preferences.json"), JSON.stringify({ connected_workflows: connected }, null, 2), "utf8");
  }
  const cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: dir,
    COMPACTION_CONFIG_DIR: configDir,
    PATH: `${NODE_DIR}${delimiter}/usr/bin${delimiter}/bin`,
    NO_COLOR: "1"
  };
  return { cwd, env };
}

/** Start `gateway start`, capture output until the end of the banner, then kill. Local bind only. */
async function startAndCaptureBanner(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn("node", [CLI, "gateway", "start", ...args], { cwd, env });
  let out = "";
  const banner = await new Promise<string>((resolveBanner) => {
    const onData = (d: Buffer): void => {
      out += d.toString();
      if (out.includes("Ctrl-C")) resolveBanner(out);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => resolveBanner(out));
    setTimeout(() => resolveBanner(out), 20000);
  });
  child.kill("SIGKILL");
  return banner;
}

describe("gateway start - workflow auto-wiring from the connect-once choice", () => {
  it("omitted --workflow + persisted codex (openai route) → announced auto-selection + workflow banner line", async () => {
    const { cwd, env } = setupDir(["codex"]);
    const banner = await startAndCaptureBanner(["--mode", "record", "--listen", "http://127.0.0.1:8796"], cwd, env);
    expect(banner).toContain("workflow 'codex' selected automatically from your connected setup");
    expect(banner).toMatch(/--workflow none disables/);
    expect(banner).toMatch(/workflow: {2}codex/);
    expect(banner).toMatch(/stored scoped authorizations for this tool are honored/i);
  }, 30000);

  it("--workflow none disables the default (no workflow identity, no auto note)", async () => {
    const { cwd, env } = setupDir(["codex"]);
    const banner = await startAndCaptureBanner(
      ["--mode", "record", "--listen", "http://127.0.0.1:8797", "--workflow", "none"],
      cwd,
      env
    );
    expect(banner).toContain("Gateway running at");
    expect(banner).not.toContain("selected automatically");
    expect(banner).not.toMatch(/workflow: {2}/);
  }, 30000);

  it("nothing persisted → omitted flag stays workflow-less (record semantics unchanged)", async () => {
    const { cwd, env } = setupDir();
    const banner = await startAndCaptureBanner(["--mode", "record", "--listen", "http://127.0.0.1:8798"], cwd, env);
    expect(banner).toContain("Gateway running at");
    expect(banner).not.toContain("selected automatically");
    expect(banner).not.toMatch(/workflow: {2}/);
  }, 30000);

  it("unknown --workflow fails closed with the clean flag error", () => {
    const { cwd, env } = setupDir(["codex"]);
    const r = spawnSync("node", [CLI, "gateway", "start", "--workflow", "cursor"], { cwd, env, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--workflow 'cursor' is not implemented \(codex \| claude-code \| auto \| none\)/);
  });
});

describe("gateway run - the executable gate on the auto default", () => {
  it("a generic command NEVER inherits the persisted workflow identity (fail-safe to record)", () => {
    const { cwd, env } = setupDir(["codex"]);
    const r = spawnSync("node", [CLI, "gateway", "run", "--", "node", "-e", "process.exit(0)"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30000
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("selected automatically");
    expect(r.stderr).toContain("started a local gateway");
    expect(r.stderr).not.toMatch(/workflow codex/);
  }, 40000);

  it("launching the connected tool's own binary on its provider route announces the auto-selection", () => {
    const { cwd, env } = setupDir(["codex"]);
    // A stub `codex` binary on PATH: exits 0 immediately; no request is ever made.
    const stubDir = join(dir, "stubbin");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "codex");
    writeFileSync(stub, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    spawnSync("chmod", ["+x", stub]);
    const r = spawnSync("node", [CLI, "gateway", "run", "--", "codex"], {
      cwd,
      env: { ...env, PATH: `${stubDir}${delimiter}${env.PATH}` },
      encoding: "utf8",
      timeout: 30000
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("workflow 'codex' selected automatically from your connected setup");
    expect(r.stderr).toMatch(/workflow codex/);
  }, 40000);
});

describe("gateway start - provider inference (no more silent openai gateway for Claude Code)", () => {
  it("--workflow claude-code (no --provider) → anthropic provider + anthropic upstream, announced", async () => {
    const { cwd, env } = setupDir();
    const banner = await startAndCaptureBanner(
      ["--mode", "record", "--listen", "http://127.0.0.1:8791", "--workflow", "claude-code"],
      cwd,
      env
    );
    expect(banner).toContain("provider 'anthropic' selected for --workflow claude-code");
    expect(banner).toMatch(/provider: {2}anthropic {2}→ {2}upstream https:\/\/api\.anthropic\.com/);
    expect(banner).not.toContain("api.openai.com");
  }, 30000);

  it("no flags + connected claude-code → anthropic by default, announced from the connect-once choice", async () => {
    const { cwd, env } = setupDir(["claude-code"]);
    const banner = await startAndCaptureBanner(["--mode", "record", "--listen", "http://127.0.0.1:8792"], cwd, env);
    expect(banner).toContain("provider 'anthropic' selected from your connected 'claude-code' workflow");
    expect(banner).toMatch(/provider: {2}anthropic {2}→ {2}upstream https:\/\/api\.anthropic\.com/);
    // The provider-matched workflow identity auto-wires too (existing behavior, now reachable by default).
    expect(banner).toContain("workflow 'claude-code' selected automatically from your connected setup");
  }, 30000);

  it("no signal → openai fallback (historical default unchanged); explicit --provider always wins", async () => {
    const { cwd, env } = setupDir();
    const fallback = await startAndCaptureBanner(["--mode", "record", "--listen", "http://127.0.0.1:8793"], cwd, env);
    expect(fallback).toMatch(/provider: {2}openai {2}→ {2}upstream https:\/\/api\.openai\.com\/v1/);
    expect(fallback).not.toContain("selected for --workflow");
    const explicit = await startAndCaptureBanner(
      ["--mode", "record", "--listen", "http://127.0.0.1:8794", "--provider", "openai", "--workflow", "claude-code"],
      cwd,
      env
    );
    expect(explicit).toMatch(/provider: {2}openai {2}→ {2}upstream https:\/\/api\.openai\.com\/v1/);
    expect(explicit).not.toContain("provider 'anthropic'");
  }, 60000);
});
