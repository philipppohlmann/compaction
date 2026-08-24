/**
 * OPEN GUARANTEES — the public Open basic path is ENGINE-FREE and ACCOUNT/NETWORK-FREE.
 *
 * Two guards:
 *  1. STATIC import-graph: from the public basic entry points (the `mode` command and the public basic
 *     output-shaping plan), transitively following relative `src/**` imports, NO module reachable on the
 *     Open path may import the private engine (`src/engine/**`) or an
 *     account/entitlement/usage/network client (`api-client`, `provider-usage` upload, `fetch`, `node:http`).
 *  2. RUNTIME no-network: the built CLI `mode observe|basic|full` runs to success under a network trap that
 *     detonates on any socket — proving observe/basic/full complete with zero network calls.
 *
 * If this fails, do NOT relax the guard: an engine/account/network dependency appearing on the Open basic
 * path is exactly the boundary regression this exists to catch.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");
const SRC = join(REPO_ROOT, "src");

/** The public Open basic entry points whose transitive import graph must stay engine/account free. */
const OPEN_ENTRY_POINTS = [
  join(SRC, "cli", "commands", "mode.ts"),
  join(SRC, "core", "gateway", "output-shaping-policy.ts"),
  join(SRC, "core", "output-shaping.ts"),
  join(SRC, "core", "output-shaping-attach.ts")
];

/**
 * Modules that MUST NOT appear anywhere on the Open basic import graph (private engine, input mutation,
 * api-client). The task classifier was on this list until the 2026-08-03 shaping-parity amendment
 * made it public: it now ships to every plan and the Open planner uses it.
 * It is pure, deterministic and engine-free, so it carries none of the risk this list exists to prevent.
 */
const FORBIDDEN_PATH_SUBSTRINGS = [
  "/engine/",
  // Model-visible INPUT mutation. Open MAY NOT compact model-visible input, and this module
  // is excluded from the public tarball, so a static edge to it from an Open entry point would brick
  // a public install at module load. Enforceable only since the PR13a split moved the validator Open
  // actually needs into the PUBLIC request-shape.ts.
  "gateway/apply-policy",
  "gateway/apply-composition",
  "/api-client/", // account / entitlement / usage service client
  "/core/auth/", // device-login client (uses global fetch, which the network regex below cannot see)
  "/core/engine-install/", // signed-engine installer (network via global fetch on explicit commands only)
];

/** Resolve a relative import specifier (`./x.js` / `../y.js`) to its `.ts` source path, if it exists. */
function resolveRelative(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined; // package import — not part of our src graph
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    base,
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    join(base, "index.ts")
  ]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Relative import specifiers in a source file that create a RUNTIME dependency. Type-only imports
 * (`import type ... from` / `export type ... from`) are ERASED at compile time — they carry no runtime
 * dependency, so they are excluded (a type-only reference to, e.g., `api-client/config`'s `EnvLike` does
 * NOT put the account client on the runtime Open path).
 *
 * BLOCK COMMENTS ARE STRIPPED AND BOTH PATTERNS ARE ANCHORED TO LINE STARTS (`^\s*`, `m` flag). This
 * is load-bearing, and fixes a FALSE NEGATIVE that could have made this rail silently green: the
 * clause between `import` and `from` was allowed to start at the word "import" inside a PRECEDING
 * comment and swallow the newline, so
 *
 *     // import type
 *     import { thing } from "./real.js";
 *
 * matched with a clause of `" type\n"`, satisfied the type-only test, `continue`d — and `lastIndex`
 * had already advanced past the real statement, so the real runtime import became invisible. A
 * docblock explaining the type-only convention (which the modules on this graph write constantly)
 * reproduces it. The same fix already shipped in private-boundary-seams.test.ts.
 */
function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const specs: string[] = [];
  // Match each `import ... from "spec"` / `export ... from "spec"` statement, capturing the clause so
  // type-only statements can be skipped. The clause forbids `;` and quotes so it cannot greedily span
  // across a preceding package-spec import (e.g. `from "node:fs"`) into a later relative `from "./x"`.
  const re = /^\s*(import|export)\b([^;"']*?)from\s*["'](\.[^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const clause = m[2];
    // Skip `import type {...}` / `export type {...}` — erased, no runtime dependency.
    if (/^\s+type\b/.test(clause)) continue;
    specs.push(m[3]);
  }
  // Bare side-effect imports (`import "./x.js"`) have no `from` clause but ARE a runtime dependency.
  const bare = /^\s*import\s*["'](\.[^"']+)["']/gm;
  while ((m = bare.exec(code)) !== null) specs.push(m[1]);
  return specs;
}

/** Transitively collect every `src/**` module reachable from the given entry points. */
function reachableGraph(entryPoints: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entryPoints];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const spec of importSpecifiers(source)) {
      const resolved = resolveRelative(file, spec);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

describe("STATIC: the Open basic import graph is engine-free and account/network-free", () => {
  // ANTI-VACUITY. Every assertion below is an "expect nothing", so a walker that silently returned
  // no imports would make this whole rail green while proving nothing. These three cases pin the
  // walker itself, including the comment shapes that previously made a real import invisible.
  it("the import walker sees real imports, including after comments that mention `import type`", () => {
    expect(importSpecifiers(`import { thing } from "./real.js";`)).toEqual(["./real.js"]);
    expect(importSpecifiers(`import type { T } from "./types.js";`)).toEqual([]);
    expect(importSpecifiers(`// import type\nimport { thing } from "./real.js";`)).toEqual(["./real.js"]);
    expect(importSpecifiers(`/* import type */\nimport { thing } from "./real.js";`)).toEqual(["./real.js"]);
    expect(
      importSpecifiers(`/**\n * Note: import type is erased at compile time.\n */\nimport { thing } from "./real.js";`)
    ).toEqual(["./real.js"]);
    expect(importSpecifiers(`import "./side-effect.js";`)).toEqual(["./side-effect.js"]);

    // The graph the rail actually walks must be non-trivial, or "no offenders" means nothing.
    expect(reachableGraph(OPEN_ENTRY_POINTS).size).toBeGreaterThan(OPEN_ENTRY_POINTS.length);
  });

  it("no forbidden (engine / input-mutation / api-client) module is reachable from the Open entry points", () => {
    const graph = reachableGraph(OPEN_ENTRY_POINTS);
    const offenders: string[] = [];
    for (const file of graph) {
      const rel = file.slice(REPO_ROOT.length);
      for (const bad of FORBIDDEN_PATH_SUBSTRINGS) {
        if (rel.includes(bad)) offenders.push(`${rel} (matches "${bad}")`);
      }
    }
    expect(offenders, `Open basic path reached a forbidden module:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no module on the Open basic graph statically imports a network primitive (fetch/http/https/net)", () => {
    const graph = reachableGraph(OPEN_ENTRY_POINTS);
    const offenders: string[] = [];
    for (const file of graph) {
      const source = readFileSync(file, "utf8");
      // A direct import of a network module on the Open path is the regression we forbid.
      if (/from\s*["'](?:node:)?(?:http|https|net|tls|dns)["']/.test(source)) {
        offenders.push(file.slice(REPO_ROOT.length));
      }
    }
    expect(offenders, `Open basic path imported a network module:\n${offenders.join("\n")}`).toEqual([]);
  });
});

// ---- RUNTIME no-network guard (built CLI) --------------------------------------------------------

const CLI = join(REPO_ROOT, "dist", "cli", "index.js");
let workDir = "";
let preloadPath = "";

const NETWORK_TRAP = `
const failHard = (what) => { throw new Error("NETWORK CALL ATTEMPTED on Open path: " + what); };
if (typeof globalThis.fetch === "function") { globalThis.fetch = () => failHard("fetch"); }
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request) {
  const mod = origLoad.apply(this, arguments);
  const trap = (obj, method, label) => {
    if (obj && typeof obj[method] === "function") { obj[method] = function () { return failHard(label); }; }
  };
  if (request === "http" || request === "node:http") { trap(mod, "request", "http.request"); trap(mod, "get", "http.get"); }
  if (request === "https" || request === "node:https") { trap(mod, "request", "https.request"); trap(mod, "get", "https.get"); }
  if (request === "net" || request === "node:net") { trap(mod, "connect", "net.connect"); trap(mod, "createConnection", "net.createConnection"); }
  if (request === "tls" || request === "node:tls") { trap(mod, "connect", "tls.connect"); }
  if (request === "dns" || request === "node:dns") { trap(mod, "lookup", "dns.lookup"); trap(mod, "resolve", "dns.resolve"); }
  return mod;
};
`;

function runMode(args: string[]): string {
  const env = {
    ...process.env,
    COMPACTION_CONFIG_DIR: workDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim()
  };
  return execFileSync("node", [CLI, ...args], { cwd: workDir, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}

const CLI_BUILT = existsSync(CLI);

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "open-mode-no-network-"));
  preloadPath = join(workDir, "network-trap.cjs");
  writeFileSync(preloadPath, NETWORK_TRAP, "utf8");
});
afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe.runIf(CLI_BUILT)("RUNTIME: `compaction mode` runs with NO network (would crash on any socket)", () => {
  it("`mode observe` completes under the network trap", () => {
    const out = runMode(["mode", "observe"]);
    expect(out).toContain("observe");
    expect(out).toContain("apply off");
  });

  /**
   * PINNED IN ITS OWN CASE rather than appended to the one above — an exact
   * string reports its failure first and would mask the no-network assertions beside it.
   *
   * The promise names its SURFACE. `apply off` asserts "no model-visible mutation", which only the
   * status line can say (it reads the current turn's own shaping decision); the replay surfaces see a
   * receipt that cannot tell an unshaped turn from one the prompt hook shaped upstream, so they omit
   * the label. Unqualified, this sentence promised a label that three surfaces do not print.
   *
   * This is the only test that runs the built command and inspects its stdout, which is why the pin
   * lives in this file.
   */
  it("`mode observe` names the surface its `apply off` promise holds for", () => {
    expect(runMode(["mode", "observe"])).toContain(
      "From the next turn, the per-turn receipt line reads `apply off` on the Claude Code status line."
    );
  });

  it("`mode basic` completes under the network trap", () => {
    const out = runMode(["mode", "basic"]);
    expect(out).toContain("basic");
    expect(out).toContain("basic shaping");
  });

  it("`mode full` with NO lease completes under the network trap (explains-and-points, no full-apply claim)", () => {
    // `full` is lease-gated. With no entitlement lease on this device (fresh config dir), the
    // command consults the PURE lease-store (local disk only — no socket), honestly explains what
    // Community adds, and points at the ONBOARDING STEPPER. It NEVER claims full is enabled and never
    // opens a socket (the trap would detonate). A valid-lease unlock is proven in the lease-store/mode
    // tests, which construct a dev-signed lease without any network.
    //
    // A later change moved WHICH command it points at, not whether it points: the stepper sets up the account
    // AND the entitlement in one step, so nobody has to learn that `compaction login` exists. The
    // assertion moved with the copy — the property under test (a real next step is offered, and no
    // full-apply claim is made) is unchanged.
    //
    // The next step is asserted as Community, not as one exact sentence: which sentence the command
    // prints depends on whether the engine is on the device at all, and the PUBLIC package (where this
    // guard matters most) never has it, so it explains the separate delivery instead of the stepper.
    // Both sentences point at the same real next step, which is the property being guarded.
    const out = runMode(["mode", "full"]);
    expect(out.toLowerCase()).toContain("not available");
    expect(out, "a real next step must be offered").toMatch(/\bCommunity\b/);
    expect(out).not.toContain("compaction login");
    expect(out).not.toContain("Full apply enabled");
  });

  it("`mode` (no arg) prints the current mode with no network", () => {
    runMode(["mode", "basic"]);
    const out = runMode(["mode"]);
    expect(out).toContain("Current mode");
  });

  it("`mode --help` does NOT promise an offline `full` the signed-in path cannot keep", () => {
    // PIN THE CLAIM AGAINST THE RUNTIME. The description used to end with a blanket "no account,
    // entitlement, usage, or network call is made", written when `full` was explain-and-point only.
    // `mode full` now attempts a Community repair first, which on a SIGNED-IN device contacts the
    // entitlement service and can download and install the signed engine — so the blanket sentence
    // was false for exactly the users it mattered to. The offline promise survives where it is still
    // kept (observe / basic / no-argument), and the network one is stated where it now applies.
    //
    // The tests above prove the other half of the pin: all three modes still complete with ZERO
    // sockets on a device with no account, which is what lets the narrower promise stand.
    // Commander hard-wraps the description to the terminal width, so the claim is matched on
    // whitespace-collapsed text — otherwise the pin would be a pin on the line width.
    const out = runMode(["mode", "--help"]).replace(/\s+/g, " ");
    expect(out).not.toMatch(/no account, entitlement, usage, or network call is made/);
    expect(out).toMatch(/`observe`, `basic`, and the no-argument display are fully offline/);
    expect(out).toMatch(/may contact the entitlement service and download and install the signed engine/);
  });
});
