/**
 * Open-core public/proprietary boundary (Phase 1c/1d).
 *
 * The engine lives in `src/engine/**` and is BUILT into `dist/engine/**`. The published npm
 * tarball ships ONLY the open-core hybrid-compactor slice of it (the per-file re-includes in
 * `package.json` `files`); the proprietary optimization/eval surface is EXCLUDED. Shipped
 * modules must therefore never STATICALLY `import` a private engine module, doing so would
 * (a) pull private engine code into the published static graph and (b) crash a public install
 * at module-load time.
 *
 * Engine-backed CLI commands instead LAZY-LOAD their engine module through a dynamic `import()`
 * (which is NOT part of the static import graph). When the engine build is present (in-repo) the
 * command runs normally. When it is ABSENT (public install) the dynamic import throws
 * `ERR_MODULE_NOT_FOUND`; `runEngineCommand()` catches that, prints the single sanctioned
 * boundary message, exits non-zero, and prints NO stack trace and NO engine output. Any OTHER
 * error (a real bug inside a present engine) is re-thrown unchanged.
 */
import {
  PRIVATE_CORE_MODULES,
  PRIVATE_ENGINE_TREE,
  isModuleSetAbsentError,
  isModuleTreeAbsentError
} from "../core/module-absence.js";

/**
 * The EXACT, single sanctioned degrade message: it names the boundary factually and immediately
 * reaffirms what stays free. Do not fork per-command variants of this string.
 *
 * It names the ONE real next step. Earlier wording offered "Compaction API or a private engine build",
 * which described how the product is built rather than what the reader can do, and neither phrase names
 * anything a user can obtain. The Hybrid Engine is free, arrives with Community, and is the actual thing
 * these commands are waiting for.
 *
 * The second sentence names what genuinely remains, each clause checkable against a public install:
 * `capture`/`import` (capture), `analyze` (token and cost measurement, honestly labeled), the gateway's
 * content-free receipts, and `feedback --redact` (redacted share bundles).
 */
export const ENGINE_DEGRADE_MESSAGE =
  "Optimization and stronger evals need the Hybrid Engine, which is delivered separately and is " +
  "installed for you when you activate Community. Local capture, token and cost measurement, " +
  "content-free receipts, and redacted share bundles remain available.";

/**
 * True when `error` is the Node "module not found" thrown by a dynamic `import()` of a module the
 * published package deliberately excludes (vs. a real runtime error raised from inside a module that
 * IS present). Shares the single absence test with the core boundary seams so a command and a seam
 * can never disagree about what "absent" means.
 *
 * TWO SHAPES, ONE MEANING. The private build is excluded two ways: `dist/engine/**` leaves as a whole
 * TREE, and a listed set of private `core/` modules leaves FILE BY FILE (they sit beside modules that
 * ship, so no subtree describes them). Both are the same fact — "this capability is not in this
 * build" — and both must reach the same sanctioned message. Before the npm flip only the tree existed;
 * a `core/` mover's absence would then have escaped as a bare `ERR_MODULE_NOT_FOUND` with a stack
 * trace, which is precisely what `runEngineCommand` exists to prevent.
 *
 * SCOPED, NOT BLANKET: a module-not-found naming anything outside the engine tree AND outside the
 * listed set is a packaging or dependency defect, not an excluded capability, and still propagates.
 */
export function isEngineAbsentError(error: unknown): boolean {
  return (
    isModuleTreeAbsentError(error, PRIVATE_ENGINE_TREE) ||
    isModuleSetAbsentError(error, PRIVATE_CORE_MODULES)
  );
}

/**
 * Run an engine-backed command body. If the engine build is absent (public install), print
 * the sanctioned boundary message to stderr, set a non-zero exit code, and return WITHOUT a
 * stack trace. Any other error propagates unchanged so real bugs are never masked.
 *
 * Usage:
 *   await runEngineCommand(async () => {
 *     const { optimizeOpenAIAgents } = await import("../../engine/openai-agents-optimization.js");
 *     // ...use it...
 *   });
 */
export async function runEngineCommand(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (isEngineAbsentError(error)) {
      process.stderr.write(`${ENGINE_DEGRADE_MESSAGE}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
