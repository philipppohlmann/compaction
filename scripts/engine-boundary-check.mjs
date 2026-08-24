#!/usr/bin/env node
// Open-core boundary check.
//
// The npm package ships ZERO `dist/engine/**` modules: the private engine is delivered as a
// signed artifact outside npm. This script proves three
// invariants on the COMPILED output (it follows only STATIC `import ... from "..."` /
// `export ... from "..."` edges; dynamic `import()` is the allowed lazy seam, and `import type`
// is already erased by tsc):
//
//   1. CLI graph is engine-free: the static import graph from `dist/cli/index.js` reaches
//      ZERO `dist/engine/**` modules. Shipped core reaches the engine only via lazy dynamic
//      `import()` seams that fail open when the target is absent.
//   2. NO PUBLIC ENGINE SLICE: package.json "files" re-includes nothing from `dist/engine/**`,
//      and the computed packlist contains no `dist/engine/**` path. Before the npm boundary
//      flip an 18-module hybrid slice was re-included here and this invariant asserted the
//      opposite; the hybrid is now private, so a re-include is a boundary regression.
//   3. NOTHING REACHABLE IS EXCLUDED: every module the CLI's static graph reaches is actually
//      IN the packlist. This is the generalisation of invariant 1 and the real brick guard —
//      dropping a STATIC dependency from the tarball throws ERR_MODULE_NOT_FOUND at module
//      LOAD, before commander builds a command and before any degrade handler can run. A
//      module intended to leave the build must be lazy-only FIRST and excluded SECOND; this
//      invariant is what catches the reverse order.
//
// The authoritative exclusion list is package.json "files" (the shipped truth); its parity
// with the mirror manifest is asserted separately in tests/scripts/package-boundary.test.ts.
//
// Exits non-zero and lists offending edges/files on any violation.
//
// Usage: node scripts/engine-boundary-check.mjs   (requires `npm run build` first)

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");
const cliEntry = path.join(distDir, "cli", "index.js");

if (!existsSync(cliEntry)) {
  process.stderr.write(`[boundary] FAIL: entry not found: ${cliEntry} (run npm run build first)\n`);
  process.exit(1);
}

// Any positive (non-`!`) `dist/engine/**` entry in package.json "files" would re-include part of the
// private engine. After the npm boundary flip there must be none.
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const engineReincludes = (pkg.files ?? []).filter(
  (entry) => typeof entry === "string" && !entry.startsWith("!") && entry.startsWith("dist/engine/")
);

/**
 * The paths npm would actually publish. `--ignore-scripts` skips `prepack` (the build, already done
 * above); `--dry-run` writes nothing and resolves the list locally, so this stays offline.
 */
function packlist() {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const parsed = JSON.parse(stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return new Set((entry.files ?? []).map((f) => f.path));
}

// Match STATIC module edges only:
//   import ... from "X";   import "X";   export ... from "X";
// Crucially does NOT match dynamic `import("X")` (no `from`, has parens) — that is the allowed lazy path.
const STATIC_EDGE = /(?:^|\n)\s*(?:import\s+(?:[^;'"]*?\s+from\s+)?|export\s+[^;]*?\s+from\s+)["']([^"']+)["']/g;

function staticSpecifiers(source) {
  const specs = [];
  let m;
  while ((m = STATIC_EDGE.exec(source)) !== null) {
    specs.push(m[1]);
  }
  return specs;
}

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // bare/node specifier — not part of our dist graph
  let target = path.resolve(path.dirname(fromFile), spec);
  if (existsSync(target) && target.endsWith(".js")) return target;
  if (existsSync(`${target}.js`)) return `${target}.js`;
  if (existsSync(path.join(target, "index.js"))) return path.join(target, "index.js");
  return target; // may not exist (e.g. excluded engine module) — caller checks
}

function isEngineModule(file) {
  const rel = path.relative(distDir, file);
  return rel === "engine" || rel.startsWith(`engine${path.sep}`);
}

/**
 * Walk the static graph from `entry`. Every static edge into `dist/engine/**` is reported to
 * `onEngineEdge`, which returns whether to keep walking THROUGH that engine module.
 */
function walk(entry, onEngineEdge) {
  const visited = new Set();
  function step(file) {
    if (visited.has(file)) return;
    visited.add(file);
    if (!existsSync(file)) return;
    const source = readFileSync(file, "utf8");
    for (const spec of staticSpecifiers(source)) {
      const resolved = resolveSpecifier(file, spec);
      if (!resolved) continue;
      if (isEngineModule(resolved)) {
        if (!onEngineEdge(file, resolved)) continue;
      }
      step(resolved);
    }
  }
  step(entry);
  return visited;
}

let failed = false;

// --- 1. CLI graph is engine-free (static edges) ---------------------------
const cliEngineEdges = [];
const cliVisited = walk(cliEntry, (from, to) => {
  cliEngineEdges.push({ from: path.relative(distDir, from), to: path.relative(distDir, to) });
  return false; // never walk into the engine from the CLI graph
});
process.stdout.write(`[boundary] reachable shipped modules (static graph from dist/cli/index.js): ${cliVisited.size}\n`);
if (cliEngineEdges.length > 0) {
  failed = true;
  process.stderr.write(`[boundary] FAIL: ${cliEngineEdges.length} static edge(s) from the CLI graph reach dist/engine/**:\n`);
  for (const edge of cliEngineEdges) {
    process.stderr.write(`  ${edge.from}  ->  ${edge.to}\n`);
  }
} else {
  process.stdout.write("[boundary] PASS: zero static engine edges in the CLI graph (engine reached only via lazy dynamic import).\n");
}

// --- 2. The tarball re-includes NOTHING from dist/engine/** ---------------
const shipped = packlist();
const shippedEngine = [...shipped].filter((f) => f.startsWith("dist/engine/")).sort();

if (engineReincludes.length > 0) {
  failed = true;
  process.stderr.write(
    `[boundary] FAIL: package.json "files" re-includes ${engineReincludes.length} dist/engine/** path(s); the private engine ships as a signed artifact, never in npm:\n`
  );
  for (const entry of engineReincludes) process.stderr.write(`  ${entry}\n`);
}
if (shippedEngine.length > 0) {
  failed = true;
  process.stderr.write(`[boundary] FAIL: ${shippedEngine.length} dist/engine/** path(s) present in the packlist:\n`);
  for (const file of shippedEngine) process.stderr.write(`  ${file}\n`);
}
if (engineReincludes.length === 0 && shippedEngine.length === 0) {
  process.stdout.write("[boundary] PASS: the packlist contains zero dist/engine/** paths (no public engine slice).\n");
}

// --- 3. Everything the CLI statically reaches is IN the packlist ----------
// The brick guard. An excluded STATIC dependency fails at module LOAD, which no degrade path can
// catch, so this is the invariant that decides whether an exclusion degrades or bricks.
const reachableMissing = [...cliVisited]
  // A resolved path that is not on disk is a broken build, not a packaging decision — tsc and the
  // runtime both catch that, and reporting it here would only obscure the exclusion this checks for.
  .filter((file) => existsSync(file))
  .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
  .filter((rel) => rel.startsWith("dist/") && !shipped.has(rel))
  .sort();
if (reachableMissing.length > 0) {
  failed = true;
  process.stderr.write(
    `[boundary] FAIL: ${reachableMissing.length} module(s) on the CLI's STATIC graph are excluded from the tarball. A public install would throw ERR_MODULE_NOT_FOUND at load, before any degrade can run:\n`
  );
  for (const file of reachableMissing) process.stderr.write(`  ${file}\n`);
  process.stderr.write(
    "  Fix by making the module lazy-only (dynamic import behind a seam) BEFORE excluding it — never the other way round.\n"
  );
} else {
  process.stdout.write(
    `[boundary] PASS: all ${cliVisited.size} statically-reachable modules ship (no excluded module is on the load path).\n`
  );
}

if (failed) process.exit(1);
