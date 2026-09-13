#!/usr/bin/env node
// Package smoke check for the compaction CLI.
//
// Deterministic, self-cleaning, NOT wired into `npm test`. Verifies that the
// npm tarball ships the right files and that the installed `compaction` binary
// runs from outside the repo.
//
//   1. npm run build
//   2. npm pack --dry-run --json  -> assert file allow/deny list
//   3. npm pack to a tmp dir, install into a scratch prefix, run
//      `compaction --help` and `compaction analyze --help` from OUTSIDE the
//      repo cwd, assert exit 0 + usage text.
//   4. Clean up tarball + tmp dirs.
//
// Usage: node scripts/package-smoke.mjs   (or: npm run smoke:package)

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Any positive (non-`!`) `dist/engine/**` entry in package.json `files` would re-include part of the
// private engine. After the npm boundary flip there is no public engine slice at all, so this must
// stay empty — it is read here (rather than assumed) so a re-include fails loudly.
const pkgJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const ENGINE_REINCLUDES = (pkgJson.files ?? []).filter(
  (entry) => typeof entry === "string" && !entry.startsWith("!") && entry.startsWith("dist/engine/")
);

function log(step, msg) {
  process.stdout.write(`[smoke] ${step}: ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[smoke] FAIL: ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts
  });
}

// Paths that MUST NOT appear in the published tarball.
const DENY_PATTERNS = [
  /^\.compaction\//,
  /^docs\//,
  /^tests\//,
  /^src\//,
  /^\.claude\//,
  /^issues\//,
  /\.jsonl$/,
  /^docs\/dogfood\//,
  /cycle-ledger/,
  /\.env$/,
  /\.tgz$/,
  // Open-core boundary: the published package ships ZERO internal demos and ZERO sourcemaps
  // (which could reveal private engine paths/internals). dist/engine is checked separately
  // below against the PUBLIC_ENGINE_FILES allowlist (only the hybrid open-core slice ships).
  /^dist\/examples\//,
  /\.js\.map$/
];

// Private module basenames that must NEVER appear ANYWHERE in the published tarball, regardless
// of directory. (The public CLI `engine-degrade` helper and the `launch-treatment-session` COMMAND
// wrapper are intentionally NOT in this list — they ship and only lazy-load the engine.)
//
// Matching by BASENAME rather than by path is the point: `!dist/engine/**` already keeps the engine
// directory out, so a path-anchored rule would prove nothing new. These patterns catch a private
// module that is MOVED into a shipping directory, which is the way a boundary quietly regresses.
//
// The hybrid-compactor names were deliberately exempt here until the npm boundary flip, when the
// hybrid became private (the moat is the fuller private adaptive engine, and it is delivered as
// a signed artifact outside npm). They are now
// forbidden like the rest. `lcm-shadow` is the one name that also belongs to a PUBLIC module — the
// core gateway's shadow GATE, `dist/core/gateway/lcm-shadow.js`, which ships — so that one entry is
// anchored to the engine directory instead of matched bare.
const FORBIDDEN_MODULE_PATTERNS = [
  // Private hybrid compactor (moved private at the npm boundary flip).
  /commitment-extraction\./,
  /commitment-preservation\./,
  /engine\/lcm-shadow\./,
  /apply-body-construction\./,
  /candidate-generator\./,
  /context-bundle\./,
  /(^|\/)contracts\./,
  /gateway-apply-candidate-source\./,
  /gateway-shadow-runner\./,
  /local-model-client\./,
  /local-model-provision\./,
  /(^|\/)model-client\./,
  /model-mirror(-manifest)?\./,
  /prefix-cache\./,
  /promotion-profile\./,
  /standard-fixtures\./,
  /summary-refinement\./,
  // Private `core/` movers: model-visible input mutation, the state capsule, the two wrappers that
  // statically compose them, and the context-store eval harness. Excluded file by file rather than
  // as a tree because they sit beside modules that ship.
  /(^|\/)compactor\./,
  /(^|\/)state-capsule\./,
  /(^|\/)compaction-artifacts\./,
  /(^|\/)policy-middleware\./,
  /context-store-eval(-cases)?\./,
  /context-store-sufficiency\./,
  /(^|\/)apply-policy\./,
  /(^|\/)apply-composition\./,
  /(^|\/)lcm-qualified-classes\./,
  // Operator-only measurement tooling: never registered on the public CLI, never shipped.
  /billing-delta/,
  /eval-harness\./,
  /eval-fixtures\./,
  /task-check\./,
  /strong-readiness\./,
  /optimization-(approval|review)\./,
  /openai-agents-optimization\./,
  /\brecommendation(-artifacts)?\./,
  /apply-mode\./,
  /in-workflow-apply\./,
  /pre-apply-approval-view\./,
  /session-seed-export\./,
  /treatment-session-launcher\./,
  // Private LCM eval/judge/corpus surface (revised open-core boundary, 2026-07-27).
  /lcm-shadow-promotion\./,
  /input-compaction-verification\./,
  /output-shaping-verification\./,
  /output-sufficiency-eval\./,
  /(^|\/)judge(-agreement|-config|-rubric)?\./,
  /corpus-(manifest|validator)\./,
  /evaluation-(harness|adapters)\./,
  /baseline-comparison\./,
  /class-readiness\./,
  /context-variants\./,
  /continuation-replay\./,
  /operator-config\./,
  /real-corpus-evaluation\./,
  /replay-config\./,
  /(^|\/)reproducibility\./,
  /run-identity\./,
  /success-contract\./,
  /engine\/lcm\/capture\./,
  // The private native-engine sidecar never ships; the signed installer delivers it.
  /engine\/native\//
];

// Paths that MUST appear in the published tarball.
const REQUIRE_FILES = [
  "dist/cli/index.js",
  "dist/cli/commands/update.js",
  "dist/core/update/bootstrap.js",
  "dist/core/update/scheduler.js",
  "dist/core/update/worker.js",
  "README.md",
  "LICENSE",
  "package.json"
];

const cleanup = [];
process.on("exit", () => {
  for (const target of cleanup) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// --- 1. build -------------------------------------------------------------
log("1/4 build", "npm run build");
run("npm", ["run", "build"], { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
if (!existsSync(path.join(repoRoot, "dist/cli/index.js"))) {
  fail("dist/cli/index.js missing after build");
}

// Open-core static-graph invariant: no shipped module STATICALLY imports the engine. Lazy `import()`
// is allowed (it is not in the static graph). This is the structural backstop for the file-exclusion
// + degrade behavior asserted below.
log("1/4 build", "engine boundary: static import graph from dist/cli/index.js reaches zero dist/engine/**");
run("node", [path.join(repoRoot, "scripts/engine-boundary-check.mjs")], { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });

// --- 2. pack file-list assertions ----------------------------------------
log("2/4 pack", "npm pack --dry-run --json");
const dryJson = run("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot });
const parsed = JSON.parse(dryJson);
const entry = Array.isArray(parsed) ? parsed[0] : parsed;
const files = (entry.files ?? []).map((f) => f.path);

if (files.length === 0) fail("npm pack reported zero files");

for (const required of REQUIRE_FILES) {
  if (!files.includes(required)) {
    fail(`required file missing from tarball: ${required}`);
  }
}

const offenders = files.filter((f) => DENY_PATTERNS.some((re) => re.test(f)));
if (offenders.length > 0) {
  fail(`disallowed files present in tarball:\n  ${offenders.join("\n  ")}`);
}

// Open-core invariant: ZERO private engine modules anywhere in the tarball.
const engineLeaks = files.filter((f) => FORBIDDEN_MODULE_PATTERNS.some((re) => re.test(f)));
if (engineLeaks.length > 0) {
  fail(`private engine modules present in tarball:\n  ${engineLeaks.join("\n  ")}`);
}

// Open-core boundary: the tarball ships ZERO `dist/engine/**` paths. The private engine is delivered
// as a signed artifact outside npm, so there is no allowlist to be in parity with — the only correct
// count is zero, asserted from BOTH sides (the declaration in package.json and the computed packlist)
// so neither a stray re-include nor a glob that stops excluding can pass unnoticed.
if (ENGINE_REINCLUDES.length > 0) {
  fail(
    `package.json "files" re-includes dist/engine/** paths; the private engine never ships in npm:\n  ${ENGINE_REINCLUDES.join("\n  ")}`
  );
}
const shippedEngine = files.filter((f) => f.startsWith("dist/engine/"));
if (shippedEngine.length > 0) {
  fail(`dist/engine files present in tarball (the engine must never ship):\n  ${shippedEngine.join("\n  ")}`);
}
log("pack", "open-core boundary: ZERO dist/engine/** paths in the tarball (private engine ships as a signed artifact, not in npm)");

log("pack", `file count: ${files.length}`);
log("pack", `unpacked size: ${entry.unpackedSize ?? "unknown"} bytes`);
process.stdout.write(`[smoke] tarball file list:\n`);
for (const f of files.slice(0, 8)) process.stdout.write(`  ${f}\n`);
if (files.length > 8) process.stdout.write(`  ... and ${files.length - 8} more\n`);

// --- 3. real pack + install + run from outside the repo ------------------
const packDir = mkdtempSync(path.join(tmpdir(), "compaction-pack-"));
cleanup.push(packDir);
log("3/4 install", `npm pack -> ${packDir}`);
const packOut = run("npm", ["pack", "--pack-destination", packDir], { cwd: repoRoot }).trim();
const tarballName = packOut.split("\n").pop().trim();
const tarballPath = path.join(packDir, tarballName);
if (!existsSync(tarballPath)) fail(`tarball not found at ${tarballPath}`);

const installPrefix = mkdtempSync(path.join(tmpdir(), "compaction-prefix-"));
cleanup.push(installPrefix);
log("install", `npm install -g --prefix ${installPrefix}`);
run("npm", ["install", "-g", "--prefix", installPrefix, tarballPath], {
  stdio: ["ignore", "ignore", "inherit"]
});

// Resolve the installed binary (unix layout: <prefix>/bin, win: <prefix>).
const binCandidates = [
  path.join(installPrefix, "bin", "compaction"),
  path.join(installPrefix, "compaction"),
  path.join(installPrefix, "compaction.cmd")
];
const binPath = binCandidates.find((p) => existsSync(p));
if (!binPath) {
  fail(`installed binary not found. Looked in:\n  ${binCandidates.join("\n  ")}`);
}
log("install", `installed binary: ${binPath}`);

// Run from OUTSIDE the repo so any repo-relative path assumptions surface, with a scratch config dir
// so nothing here can read or write the operator's real ~/.compaction.
const outsideCwd = mkdtempSync(path.join(tmpdir(), "compaction-cwd-"));
cleanup.push(outsideCwd);
const configDir = mkdtempSync(path.join(tmpdir(), "compaction-config-"));
cleanup.push(configDir);
const openEnv = { ...process.env, COMPACTION_CONFIG_DIR: configDir };

log("3/4 run", "compaction --help (outside repo cwd)");
const help = run(binPath, ["--help"], { cwd: outsideCwd });
if (!/usage|compaction|command/i.test(help)) {
  fail(`--help output did not look like usage text:\n${help}`);
}
if (!/\bupdate\b/.test(help)) fail("Installed top-level help did not list update.");
const updateHelp = run(binPath, ["update", "--help"], { cwd: outsideCwd });
if (!["--check", "--channel", "--rollback", "--auto"].every(flag => updateHelp.includes(flag))) {
  fail("Installed update help is missing required delivery options.");
}
process.stdout.write(`[smoke] compaction --help exit code: 0\n`);

log("3/4 run", "compaction analyze --help (subcommand resolves)");
const analyzeHelp = run(binPath, ["analyze", "--help"], { cwd: outsideCwd });
if (!/analyze|usage|trace/i.test(analyzeHelp)) {
  fail(`analyze --help output did not look like usage text:\n${analyzeHelp}`);
}
process.stdout.write(`[smoke] compaction analyze --help exit code: 0\n`);

// V0.4 public `context` command ships free + local: it must appear in the top-level help and its
// add/get subcommands must resolve. (Local memory/retrieval; no engine — see boundary check above.)
log("3/4 run", "compaction context (public free command ships + resolves)");
if (!/\bcontext\b/.test(help)) {
  fail(`top-level --help did not list the public 'context' command:\n${help}`);
}
const contextHelp = run(binPath, ["context", "--help"], { cwd: outsideCwd });
if (!/\badd\b/.test(contextHelp) || !/\bget\b/.test(contextHelp)) {
  fail(`context --help did not list the add/get subcommands:\n${contextHelp}`);
}
process.stdout.write(`[smoke] compaction context --help exit code: 0\n`);

// THE OPEN EXPERIENCE, END TO END, FROM THE INSTALLED BINARY.
//
// This is the property the npm boundary flip is judged on: with NO private engine present, an Open
// user must still get the whole free product, not a shell of it. Each step below is a real command
// run against a scratch config dir outside the repo — no engine, no account, no network.
//
// `mode basic` selects the ONE public deterministic output-shaping method, which is Open's actual
// optimization and the thing that must survive the flip intact.
log("3/4 run", "compaction mode basic (public deterministic output shaping is selectable)");
const modeOut = run(binPath, ["mode", "basic"], { cwd: outsideCwd, env: openEnv });
if (!/basic/.test(modeOut) || !/basic shaping/.test(modeOut)) {
  fail(`mode basic did not confirm public basic shaping:\n${modeOut}`);
}
const modeShow = run(binPath, ["mode"], { cwd: outsideCwd, env: openEnv });
if (!/Current mode/.test(modeShow) || !/basic/.test(modeShow)) {
  fail(`mode did not report the mode it had just been set to:\n${modeShow}`);
}
process.stdout.write(`[smoke] compaction mode basic -> mode: OK — public shaping selected and persisted\n`);

// First-run onboarding from the INSTALLED binary. `init` is read-only guidance (writes
// nothing, no network); we assert it runs and prints the connect-once install screen
// (tool detection + the "Enable Compaction for:" menu) + the real `--connect` next command.
log("3/4 run", "compaction init (installed, read-only connect-once onboarding)");
const initOut = run(binPath, ["init"], { cwd: outsideCwd });
if (!/Enable Compaction for:/i.test(initOut) || !/compaction init --connect/i.test(initOut)) {
  fail(`init output missing the connect-once install screen / --connect guidance:\n${initOut}`);
}
process.stdout.write(`[smoke] compaction init exit code: 0\n`);

// --- 3b. Claude Code first-value path from the INSTALLED binary -----------
// Proves discover + capture + downstream compact work from the packaged CLI with NO repo-file
// runtime dependency. A self-contained synthetic session (NO real session content) is written to
// a fixture projects dir so discovery + capture run entirely against tmp paths.
const ccPayload =
  "synthetic-package@0.0.0 dependency resolution report\n" +
  Array.from(
    { length: 40 },
    (_, i) =>
      `  package-module-${String(i).padStart(3, "0")}@1.${i}.0  resolved https://registry.example/pkg-${i}.tgz integrity sha512-FAKEHASH${i}`
  ).join("\n") +
  "\nDONE: resolved all transitive dependencies (synthetic smoke fixture, no real content).";

const ccSession = [
  { type: "user", uuid: "u1", timestamp: "2026-06-08T10:00:01.000Z", sessionId: "smoke-cc-0001", isSidechain: false, message: { role: "user", content: "Show the report twice." } },
  { type: "assistant", uuid: "a1", timestamp: "2026-06-08T10:00:05.000Z", sessionId: "smoke-cc-0001", isSidechain: false, message: { id: "m1", model: "claude-sonnet-4-6", role: "assistant", type: "message", content: [{ type: "text", text: "Running it." }, { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm ls --all" } }], stop_reason: "tool_use", usage: { input_tokens: 150, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 1200 } } },
  { type: "user", uuid: "u2", timestamp: "2026-06-08T10:00:06.000Z", sessionId: "smoke-cc-0001", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: ccPayload }] } },
  { type: "assistant", uuid: "a2", timestamp: "2026-06-08T10:00:10.000Z", sessionId: "smoke-cc-0001", isSidechain: false, message: { id: "m2", model: "claude-sonnet-4-6", role: "assistant", type: "message", content: [{ type: "text", text: "Once more." }, { type: "tool_use", id: "tu_2", name: "Bash", input: { command: "npm ls --all" } }], stop_reason: "tool_use", usage: { input_tokens: 300, output_tokens: 40, cache_creation_input_tokens: 50, cache_read_input_tokens: 2400 } } },
  { type: "user", uuid: "u3", timestamp: "2026-06-08T10:00:11.000Z", sessionId: "smoke-cc-0001", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: ccPayload }] } },
  { type: "assistant", uuid: "a3", timestamp: "2026-06-08T10:00:20.000Z", sessionId: "smoke-cc-0001", isSidechain: false, message: { id: "m3", model: "claude-sonnet-4-6", role: "assistant", type: "message", content: [{ type: "text", text: "Identical." }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 } } }
];

const ccProjectsDir = mkdtempSync(path.join(tmpdir(), "compaction-cc-projects-"));
cleanup.push(ccProjectsDir);
const ccSlugDir = path.join(ccProjectsDir, "-synthetic-smoke");
mkdirSync(ccSlugDir, { recursive: true });
const ccSessionPath = path.join(ccSlugDir, "smoke-cc-0001.jsonl");
writeFileSync(ccSessionPath, ccSession.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

log("3/4 run", "compaction capture claude-code --discover (installed, fixture projects dir)");
const discover = run(binPath, ["capture", "claude-code", "--discover", "--projects-dir", ccProjectsDir], { cwd: outsideCwd });
if (!/Discovered 1 session/.test(discover) || !/compaction capture claude-code --session/.test(discover)) {
  fail(`discover output missing session listing / next-command guidance:\n${discover}`);
}
process.stdout.write(`[smoke] compaction capture claude-code --discover: OK\n`);

const ccOut = mkdtempSync(path.join(tmpdir(), "compaction-cc-out-"));
cleanup.push(ccOut);
log("3/4 run", "compaction capture claude-code --session (installed)");
const capture = run(binPath, ["capture", "claude-code", "--session", ccSessionPath, "--out", ccOut], { cwd: outsideCwd });
if (!/Token-count source:/.test(capture) || !new RegExp(`compaction analyze ${ccOut.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(capture)) {
  fail(`capture output missing token-count source label / next command:\n${capture}`);
}
const capturedTrace = path.join(ccOut, "captured-trace.json");
if (!existsSync(capturedTrace)) fail(`capture did not write captured-trace.json at ${capturedTrace}`);
process.stdout.write(`[smoke] compaction capture claude-code --session: OK\n`);

// FREE first-value downstream of capture: `analyze` runs entirely locally (no engine) and must
// produce the labeled local before/after estimate + waste category from the packaged binary.
log("3/4 run", "compaction analyze (installed, free first-value downstream of capture)");
const analyze = run(binPath, ["analyze", capturedTrace], { cwd: outsideCwd });
if (!/repeated_tool_output/.test(analyze) || !/Saving per run: \$(?!0\.000000)/.test(analyze)) {
  fail(`analyze produced no real local delta from the captured trace:\n${analyze}`);
}
process.stdout.write(`[smoke] compaction analyze (free, downstream of capture): OK — real local delta\n`);

// Local memory round trip: `context add` records items from the user's OWN captured trace and
// `context get` retrieves them with source pointers. Deterministic, local, engine-free — it stays
// public through the flip, so a real add→get must work here, not just `--help`.
log("3/4 run", "compaction context add -> get (local memory round trip, no engine)");
const contextAdd = run(binPath, ["context", "add", capturedTrace], { cwd: outsideCwd, env: openEnv });
if (!/\b(item|items)\b/i.test(contextAdd)) {
  fail(`context add did not report what it recorded:\n${contextAdd}`);
}
const contextGet = run(binPath, ["context", "get", "dependency resolution report"], { cwd: outsideCwd, env: openEnv });
if (!/smoke-cc-0001|synthetic-package|package-module-/.test(contextGet)) {
  fail(`context get did not retrieve anything from the items just added:\n${contextGet}`);
}
process.stdout.write(`[smoke] compaction context add -> get: OK — retrieved the user's own recorded items\n`);

// The per-turn receipt surface. `watch --once` is the snapshot form, so it exits; with no receipts
// yet it must say so honestly rather than fabricate a feed or fail.
log("3/4 run", "compaction watch --once (per-turn receipt pane resolves and exits)");
const watchOut = run(binPath, ["watch", "--once"], { cwd: outsideCwd, env: openEnv });
process.stdout.write(`[smoke] compaction watch --once: OK — exited cleanly (${watchOut.trim().split("\n").length} line(s))\n`);

// The rollup. Open's answer to "what is this doing for me" — must run with no account and no engine.
log("3/4 run", "compaction status (rollup runs with no account, no engine)");
const statusOut = run(binPath, ["status"], { cwd: outsideCwd, env: openEnv });
if (statusOut.trim() === "") fail("status printed nothing");
process.stdout.write(`[smoke] compaction status: OK — rollup printed with no account and no engine\n`);

// Byte-exact recovery is the safety property under every apply. With no apply performed there is
// nothing to restore, and the honest behavior is to say so — never to invent a recovery or crash.
log("3/4 run", "compaction gateway recover (unknown id degrades honestly, no stack trace)");
let recoverOut = "";
try {
  recoverOut = run(binPath, ["gateway", "recover", "smoke-no-such-id"], { cwd: outsideCwd, env: openEnv });
} catch (error) {
  recoverOut = `${(error.stdout ?? "").toString()}${(error.stderr ?? "").toString()}`;
}
if (/\n\s+at\s|node:internal|ERR_MODULE_NOT_FOUND/.test(recoverOut)) {
  fail(`gateway recover leaked a stack trace:\n${recoverOut}`);
}
process.stdout.write(`[smoke] compaction gateway recover: OK — resolved and reported honestly, no stack trace\n`);

// ENGINE-GATED FEATURES DEGRADE HONESTLY: the published package excludes the private surface, so an
// engine-backed command must print the EXACT sanctioned boundary message, exit non-zero, and emit NO
// stack trace and NO output. Asserted on TWO commands that fail for two structurally different
// reasons, because the flip introduced the second kind:
//
//   `recommend` — its lazy target is under `dist/engine/**`, excluded as a whole TREE.
//   `compact`   — its lazy targets are `dist/core/compaction-artifacts.js` and
//                 `dist/core/policy-middleware.js`, excluded FILE BY FILE from a directory that
//                 otherwise ships. Before the flip `compact` succeeded here; the input compactor and
//                 state capsule are now private, so it must degrade — and it must degrade through
//                 the SAME message, not leak `ERR_MODULE_NOT_FOUND`. That is the case a tree-only
//                 absence check would have missed.
const ENGINE_DEGRADE_MESSAGE =
  "Optimization and stronger evals need the Hybrid Engine, which is delivered separately and is " +
  "installed for you when you activate Community. Local capture, token and cost measurement, " +
  "content-free receipts, and redacted share bundles remain available.";

function assertDegradesCleanly(label, args) {
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    stdout = run(binPath, args, { cwd: outsideCwd });
  } catch (error) {
    code = error.status ?? 1;
    stderr = (error.stderr ?? "").toString();
    stdout = (error.stdout ?? "").toString();
  }
  if (code === 0) fail(`${label} exited 0 but should degrade non-zero in a public (engine-excluded) install`);
  if (stderr.trim() !== ENGINE_DEGRADE_MESSAGE) {
    fail(`${label} degrade message mismatch.\n  expected: ${ENGINE_DEGRADE_MESSAGE}\n  got: ${stderr.trim()}`);
  }
  if (/\n\s+at\s|node:internal|ERR_MODULE_NOT_FOUND/.test(stderr)) {
    fail(`${label} degrade leaked a stack trace:\n${stderr}`);
  }
  if (stdout.trim() !== "") {
    fail(`${label} degrade leaked engine output on stdout:\n${stdout}`);
  }
  process.stdout.write(`[smoke] compaction ${label} (private surface excluded): OK — degraded cleanly, exit ${code}\n`);
}

log("3/4 run", "compaction recommend (installed) — must degrade honestly (engine tree excluded)");
assertDegradesCleanly("recommend", ["recommend", capturedTrace]);

const ccCompactOut = path.join(ccOut, "compacted");
log("3/4 run", "compaction compact (installed) — must degrade honestly (private core movers excluded)");
assertDegradesCleanly("compact", ["compact", capturedTrace, "--out", ccCompactOut]);
if (existsSync(path.join(ccCompactOut, "report.json")) || existsSync(path.join(ccCompactOut, "report.md"))) {
  fail(`compact degraded but still wrote artifacts under ${ccCompactOut} — a degrade must produce nothing`);
}

// --- 4. cleanup happens via exit handler ---------------------------------
log("4/4 cleanup", `removing ${cleanup.length} tmp paths + tarball`);
process.stdout.write(`[smoke] PASS\n`);
