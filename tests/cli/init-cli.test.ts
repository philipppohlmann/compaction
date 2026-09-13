import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const pkgVersion: string = createRequire(import.meta.url)("../../package.json").version;

const exec = promisify(execFile);
const CLI = path.resolve("dist/cli/index.js");
const tmpRoots: string[] = [];

// The free, local-first commands the onboarding may feature. Anything outside
// this set (the optimization & verification engine: recommend / compact /
// inspect / approve / apply-context) must NOT be featured on the first-run
// screen, those are the opt-in Compaction API, not the free CLI.
const FREE_FOLLOW_UPS = [
  "compaction analyze",
  "compaction spend",
  "compaction summary",
  "compaction feedback --redact"
];
const ENGINE_COMMANDS = ["recommend", "compact", "approve", "apply-context", "inspect"];

afterAll(async () => {
  for (const dir of tmpRoots) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("compaction init - connect-once install onboarding", () => {
  it("renders the connect-once install screen: detection + Enable menu + Gateway-as-infra (detected case)", async () => {
    // Stub a Claude Code projects dir with one fake session so detection fires.
    const root = await mkdtemp(path.join(os.tmpdir(), "init-detect-"));
    tmpRoots.push(root);
    const proj = path.join(root, "projects", "-tmp-demo");
    await mkdir(proj, { recursive: true });
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-06-12T00:00:00Z", sessionId: "s1" });
    await writeFile(path.join(proj, "s1.jsonl"), line + "\n");

    // Pin HOME + cwd to the tmp root so hookReady is deterministically false (no ~/.claude or
    // project .claude hook here), the Claude Code row must read `found`, not `ready`.
    const { stdout } = await exec("node", [CLI, "init", "--projects-dir", path.join(root, "projects")], {
      cwd: root,
      env: { ...process.env, HOME: root }
    });

    expect(stdout).toContain("C O M P A C T I O N");
    expect(stdout).toContain("context under control");
    expect(stdout).toContain(`v${pkgVersion}`);
    expect(stdout).toContain("local-first · no prompt or code telemetry · no upload by default");
    // Install-once promise (NOT the old "find and reduce…" capture-first copy).
    expect(stdout).toContain("Install once. Make supported AI workflows context-aware, measured, and reviewable - locally.");
    expect(stdout).not.toContain("Find and reduce avoidable context spend");

    // Discovery block in the found/ready/not-found state model. Detected sessions (no verified hook)
    // read as `found` - "sessions found · enable Compaction" - NEVER as active/ready.
    expect(stdout).toContain("Found on this machine:");
    expect(stdout).toContain("Discovery is read-only. Enabling is the first write.");
    expect(stdout).toMatch(/\[x\] Claude Code\s+sessions found · enable Compaction\s+→ connect: transparent routing \+ consented Stop hook/);
    for (const t of ["Codex", "Cursor"]) expect(stdout).toContain(t);
    // OpenAI Agents + Browser are NOT discovery rows on Page 1 (dropped this cycle).
    expect(stdout).not.toContain("OpenAI Agents");
    expect(stdout).not.toMatch(/\[[ x~]\] Browser\b/);
    expect(stdout).toContain("local-estimate only");
    expect(stdout).not.toContain("recommended first run");
    expect(stdout).not.toContain("Start here");
    // `found` must never claim active; only `ready` means active-for-recording.
    expect(stdout).not.toContain("connected (shim active)");

    // Enable-once menu + named commands (no numeric connection UI).
    expect(stdout).toContain("Enable Compaction for:");
    for (const name of ["claude-code", "codex", "cursor", "all"]) {
      expect(stdout).toContain(`compaction init --connect ${name}`);
    }
    expect(stdout).not.toMatch(/compaction init --connect [1-5]\b/);

    // Gateway = infra + manual route, NOT a peer workflow card.
    expect(stdout).toContain("Gateway: local byte-safe routing layer for compatible OpenAI-style traffic");
    expect(stdout).toContain("compaction gateway run -- <command>");
    expect(stdout).toContain("compaction gateway status");
    expect(stdout).not.toContain("Gateway setup");

    // After-connect framing + manual tools line.
    expect(stdout).toContain("After connect: supported runs route or capture automatically; only recorded evidence is reported.");
    expect(stdout).toContain("Manual tools: capture · import · analyze · spend · feedback --redact");

    // Optimization mode (Page 3) - the two honest modes + exact commands, mode 1 recommended/default.
    expect(stdout).toContain("Optimization mode (how context is handled for supported runs):");
    expect(stdout).toContain("[1] Output only");
    expect(stdout).toContain("(recommended · default)");
    expect(stdout).toContain("Asks for shorter responses. Your input is sent exactly as written.");
    expect(stdout).toContain("[2] Full optimization");
    expect(stdout).toContain("Compact input and shape output on supported requests. Confirm once for selected workflows.");
    expect(stdout).toContain("compaction gateway proof --proof-run <id>");
    expect(stdout).toContain("compaction init --connect <workflow> --mode cache-plus-context");
    expect(stdout).toContain("This read-only screen writes nothing.");

    // Engine commands absent; no overclaim.
    for (const eng of ENGINE_COMMANDS) expect(stdout).not.toContain(`compaction ${eng}`);
    expect(stdout).not.toMatch(/billing-confirmed/i);
    expect(stdout).not.toMatch(/semantic.*preserv/i);
    // No forbidden savings/capability claim leaks onto the screen (the pre-existing activation copy
    // legitimately says "auto-apply is off by default", so auto-apply is guarded on the NEW copy in
    // the model test, not here). These must appear nowhere.
    expect(stdout).not.toMatch(/cost savings|output-token savings|all-provider|\bLCM\b/i);
  });

  it("empty (not-detected) case: same connect-once model, Claude Code shown 'not found'", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "init-empty-"));
    tmpRoots.push(root);
    const { stdout } = await exec(process.execPath, [CLI, "init", "--projects-dir", "/tmp/none-here-nonexistent"], {
      cwd: root,
      env: { HOME: root, PATH: "/usr/bin:/bin", NO_COLOR: "1" }
    });
    expect(stdout).toContain("C O M P A C T I O N");
    expect(stdout).toContain(`v${pkgVersion}`);
    expect(stdout).toContain("Found on this machine:");
    expect(stdout).toContain("Enable Compaction for:");
    expect(stdout).toMatch(/\[ \] Claude Code\s+not found/);
    expect(stdout).not.toMatch(/session\(s\) found/);
    expect(stdout).not.toContain("Start here");
    for (const eng of ENGINE_COMMANDS) expect(stdout).not.toContain(`compaction ${eng}`);
  });

  it("plain `init` writes nothing (read-only detection only)", async () => {
    // A fresh cwd with no .claude/settings.json and no shims; plain init must not create anything.
    const cwd = await mkdtemp(path.join(os.tmpdir(), "init-nowrite-"));
    tmpRoots.push(cwd);
    await exec("node", [CLI, "init", "--projects-dir", "/tmp/none-here-nonexistent"], { cwd });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(cwd);
    expect(entries).not.toContain(".claude"); // no hook install
    expect(entries).not.toContain(".compaction"); // no gateway/policy state
  });

  it("--path focuses one manual capture/import command and rejects unknown paths", async () => {
    const { stdout } = await exec("node", [CLI, "init", "--path", "import", "--projects-dir", "/nonexistent"]);
    expect(stdout).toContain("import --list-sources"); // the focused manual command
    expect(stdout).toContain("Enable Compaction for:"); // still the connect-once model
    await expect(exec("node", [CLI, "init", "--path", "bogus", "--projects-dir", "/nonexistent"])).rejects.toThrow();
  });

  it("public `--help` lists exactly the free commands (engine commands stay hidden)", async () => {
    const { stdout } = await exec("node", [CLI, "--help"]);
    const commandsSection = stdout.slice(stdout.indexOf("Commands:"));

    // The featured commands are visible: the free local-first ones (V0.4 added `context` -
    // local memory/retrieval), the read-only pair `activity` + `policies`, the live per-turn
    // receipt feed `watch`, the subscription output-shaping control trio `stop` + `start` +
    // `savings`, the mainstream hosted-upgrade pair `upgrade` + `status`, the Community
    // account trio `login` + `logout` + `devices`, and the signed-engine delivery command
    // `engine`, plus account-free public release checking through `update`.
    for (const cmd of ["init", "capture", "import", "analyze", "context", "spend", "summary", "aggregate", "feedback", "activity", "policies", "watch", "stop", "start", "savings", "upgrade", "status", "login", "logout", "devices", "engine", "update"]) {
      expect(commandsSection).toMatch(new RegExp(`^\\s*${cmd}\\b`, "m"));
    }

    // Engine commands are HIDDEN from the public help surface.
    for (const eng of ENGINE_COMMANDS) {
      expect(commandsSection).not.toMatch(new RegExp(`^\\s*${eng}\\b`, "m"));
    }

    // The complete public command set; `help` is excluded below.
    const listed = commandsSection
      .split("\n")
      .filter((l) => /^\s{2}\S/.test(l))
      .map((l) => l.trim().split(/\s+/)[0]);
    const featured = listed.filter((name) => name !== "help");
    expect(new Set(featured)).toEqual(
      new Set([
        "analyze",
        "aggregate",
        "init",
        "mode",
        "capture",
        "context",
        "feedback",
        "import",
        "spend",
        "summary",
        "activity",
        "policies",
        "watch",
        "stop",
        "start",
        "savings",
        "upgrade",
        "status",
        "login",
        "logout",
        "devices",
        "engine",
        "usage",
        "update"
      ])
    );
    expect(featured.length).toBe(24);
  });

  it("init help presents named connection commands and keeps numeric aliases undocumented", async () => {
    const { stdout } = await exec(process.execPath, [CLI, "init", "--help"], { env: { ...process.env, NO_COLOR: "1" } });
    const unwrapped = stdout.replace(/\n\s+/g, " ");
    expect(unwrapped).toContain("claude-code | codex | cursor | all");
    expect(unwrapped).toContain("`all` includes detected tools only");
    expect(unwrapped).toContain("disconnect by name: claude-code | codex | cursor");
    expect(stdout).not.toMatch(/1\|claude-code|2\|codex|3\|cursor|4\|all|5\|skip/);
  });
});
