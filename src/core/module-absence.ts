/**
 * Absent-module detection for the lazy boundary seams.
 *
 * A capability that is excluded from a build is reached only through a dynamic `import()`, which
 * throws Node's "module not found" when the target is not on disk. That is the ONE error class a seam
 * may translate into a degrade; anything else is a real runtime error raised from inside a module that
 * IS present, and must propagate so bugs are never masked as "the feature is not installed".
 *
 * THE ERROR CODE ALONE IS NOT ENOUGH (load-bearing). When a lazy target IS present but one of its own
 * static dependencies is missing, Node rejects the import with the SAME `ERR_MODULE_NOT_FOUND`. A
 * code-only test therefore reads a packaging defect as an intentionally absent capability, and every
 * seam degrades silently on a build that is simply broken — the worst possible way to discover a
 * mis-packaged release. So the caller must name the module it asked for, and the error must actually
 * refer to THAT module.
 *
 * WHAT THIS CAN DISTINGUISH:
 *   - the requested target itself missing               → absence (degrade)
 *   - a transitive dependency at a different path missing → NOT absence (propagates)
 *   - any non-module error (TypeError, EACCES, …)       → NOT absence (propagates)
 *   - a module-not-found whose named module cannot be extracted → NOT absence (propagates)
 *
 * WHAT IT CANNOT DISTINGUISH:
 *   - a dependency that resolves to the SAME path as the target modulo file extension (`x.ts` vs
 *     `x.js`). Extensions are compared loosely on purpose, because the same seam runs against a `.ts`
 *     source tree under the test runner and a `.js` build tree when shipped.
 *   - a target that is reachable from itself transitively — the same file cannot be told apart from
 *     itself, by definition.
 *
 * The direction of every uncertainty is fixed: unmatched, unparseable, or unresolvable ⇒ NOT absence.
 * A loud error beats a silent degrade.
 */
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve as resolvePath } from "node:path";

/** The lazy target a seam asked for, named by its call site. */
export interface ExpectedModule {
  /** The exact specifier handed to the dynamic `import()` (e.g. `"./apply-policy.js"`). */
  specifier: string;
  /** `import.meta.url` of the module performing that import — the base the specifier resolves against. */
  importerUrl: string;
}

/**
 * The expectation for a path that lazily loads SOME module out of a whole excluded tree rather than
 * one named file — `runEngineCommand`, which wraps command bodies that each import a different engine
 * module, and the LCM boundaries, whose engine source may import further engine modules of its own.
 *
 * Weaker than `ExpectedModule` and deliberately so: it can only say "the missing module sits under
 * this tree". It still rejects the case that matters — a missing dependency OUTSIDE the tree (a
 * dropped `node_modules` package, a missing public module) no longer reads as "the private build is
 * not installed".
 *
 * ANCHORED, not a bare segment (load-bearing). A lone `engine` segment matched ANYWHERE in the
 * candidate path, so a checkout under any ancestor directory named `engine`
 * (`/home/engine/project/node_modules/chalk/index.js`) or a missing dependency from a package
 * literally named `engine` (`node_modules/engine/index.js`) classified a PUBLIC packaging defect as
 * an absent private engine — the CLI and both LCM boundaries would then report `engine-absent` and
 * degrade quietly instead of surfacing a broken build. The subtree must therefore be matched as a
 * `<dir>/<subdir>` pair, not as one word.
 */
export interface ExpectedModuleTree {
  /**
   * The relative subtrees the missing module must sit under, each matched as a contiguous run of path
   * segments (e.g. `"src/engine"` matches `…/src/engine/x.ts` but never `/home/engine/…`).
   */
  treeSubpaths: readonly string[];
}

/**
 * The expectation for modules excluded ONE BY ONE rather than as a subtree — the private `core/`
 * movers, which sit in the same directories as modules that ship.
 *
 * Stronger than `ExpectedModuleTree` (each path is an exact, whole-segment tail match, so a
 * neighbouring module's absence is never mistaken for a listed one) and weaker than
 * `ExpectedModule` (it does not verify the importer asked for THAT module). It is used only where
 * one call site can load any of several excluded modules — `runEngineCommand`, whose command bodies
 * each import a different one. A seam that reaches exactly one module still uses `ExpectedModule`.
 */
export interface ExpectedModuleSet {
  /**
   * Extension-free, build-root-relative module paths, each matched as a contiguous run of WHOLE
   * path segments ending the candidate (e.g. `"core/compactor"` matches `…/dist/core/compactor.js`
   * but never `…/core/compactor-registry.js` or `…/other/core/compactorX/index.js`).
   */
  moduleSubpaths: readonly string[];
}

/**
 * The one tree excluded as a WHOLE rather than file by file: `src/engine/**` in-repo, `dist/engine/**`
 * when built. Declared here, beside the predicate, as the WHOLE expectation object so the CLI degrade
 * path and the two LCM boundaries cannot disagree about which tree "the engine" means — or rebuild
 * that expectation three different ways.
 */
export const PRIVATE_ENGINE_TREE: ExpectedModuleTree = { treeSubpaths: ["src/engine", "dist/engine"] };

/**
 * The private modules excluded from the public build FILE BY FILE rather than as a tree: the
 * input compactor, the state capsule, the two wrappers that compose them, and the mutating half of
 * the gateway apply surface. They live under `core/`, beside modules that ship, so no subtree
 * expresses them and `PRIVATE_ENGINE_TREE` cannot see them.
 *
 * Declared here, beside the predicate and beside the engine tree, because the `package.json` `files`
 * exclusions and this list are the SAME decision seen from two sides: a module excluded there but
 * missing here raises a bare `ERR_MODULE_NOT_FOUND` with a stack trace instead of the sanctioned
 * degrade, and a module listed here but still shipped is dead weight. `tests/security/
 * private-boundary-seams.test.ts` asserts the two stay in lockstep.
 *
 * Paths are extension-free and relative to the build root, so one entry covers the `.ts` source tree
 * under the test runner and the `.js` build tree when shipped.
 */
export const PRIVATE_CORE_MODULES: ExpectedModuleSet = {
  moduleSubpaths: [
    "core/compactor",
    "core/state-capsule",
    "core/compaction-artifacts",
    "core/policy-middleware",
    "core/context-store-eval",
    "core/context-store-eval-cases",
    "core/context-store-sufficiency",
    "core/gateway/apply-policy",
    "core/gateway/apply-composition",
    "core/gateway/lcm-qualified-classes"
  ]
};

/** Extensions treated as interchangeable when comparing a source tree against a build tree. */
const INTERCHANGEABLE_EXT = /\.(?:m|c)?[jt]s$/;

function withoutKnownExtension(path: string): string {
  return path.replace(INTERCHANGEABLE_EXT, "");
}

function toPath(value: string, importerPath: string | undefined): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  if (isAbsolute(trimmed)) return trimmed;
  // A relative specifier (the CJS `MODULE_NOT_FOUND` form reports the raw specifier, not a resolved
  // path). It is only meaningful against the importer that failed to resolve it.
  if (trimmed.startsWith(".") && importerPath !== undefined) {
    return resolvePath(importerPath, "..", trimmed);
  }
  return undefined;
}

/**
 * Every module name the error names. Node quotes the missing module and leaves the importer and the
 * require-stack unquoted, in both the ESM (`Cannot find module '<resolved>' imported from <base>`)
 * and CJS (`Cannot find module '<specifier>'\nRequire stack: …`) forms, so quoted runs are the
 * missing module and nothing else. `error.url` carries the same fact structurally when Node sets it.
 */
function namedModules(error: { message?: unknown; url?: unknown }): string[] {
  const named: string[] = [];
  if (typeof error.url === "string") named.push(error.url);
  if (typeof error.message === "string") {
    for (const match of error.message.matchAll(/['"]([^'"\n]+)['"]/g)) named.push(match[1] as string);
  }
  return named;
}

/**
 * The module names a "module not found" error carries, or `undefined` when the error is not one (or
 * names nothing comparable). THE ONLY place in `src/` that tests the Node error code — every other
 * module goes through the two predicates below, so the boundary cannot be defined twice and drift.
 */
function moduleNotFoundCandidates(error: unknown): string[] | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return undefined;
  const candidates = namedModules(error as { message?: unknown; url?: unknown });
  return candidates.length > 0 ? candidates : undefined; // nothing to compare against ⇒ propagate
}

/**
 * True only when `error` is a module-not-found that refers to `expected` — the module this seam
 * deliberately reaches lazily. Anything else is a real failure and the caller must rethrow it.
 */
export function isModuleAbsentError(error: unknown, expected: ExpectedModule): boolean {
  const candidates = moduleNotFoundCandidates(error);
  if (candidates === undefined) return false;

  let importerPath: string | undefined;
  try {
    importerPath = fileURLToPath(expected.importerUrl);
  } catch {
    importerPath = isAbsolute(expected.importerUrl) ? expected.importerUrl : undefined;
  }

  // A BARE specifier never resolves against the importer, so it is matched by name. Relative
  // specifiers — every seam in this repo — are resolved to a path and compared as paths.
  if (!expected.specifier.startsWith(".")) {
    return candidates.some(
      (candidate) => candidate === expected.specifier || candidate.startsWith(`${expected.specifier}/`)
    );
  }
  if (importerPath === undefined) return false; // cannot resolve the expectation ⇒ propagate

  const expectedPath = withoutKnownExtension(resolvePath(importerPath, "..", expected.specifier));
  return candidates.some((candidate) => {
    const candidatePath = toPath(candidate, importerPath);
    return candidatePath !== undefined && withoutKnownExtension(candidatePath) === expectedPath;
  });
}

/**
 * True only when `error` is a module-not-found naming a module inside one of `expected.treeSubpaths`.
 * For the paths that cannot name one file (see `ExpectedModuleTree`). Everything else — including a
 * missing module outside those subtrees — is a real failure the caller must rethrow.
 *
 * The subtree must match as a contiguous run of WHOLE segments with something beneath it, so
 * `src/engine/x.js` is absence while `/home/engine/…/chalk/index.js`, `node_modules/engine/index.js`,
 * and a file named `src/engine.js` are not. A candidate that IS the subtree with nothing under it is
 * not a module either.
 */
export function isModuleTreeAbsentError(error: unknown, expected: ExpectedModuleTree): boolean {
  const candidates = moduleNotFoundCandidates(error);
  if (candidates === undefined) return false;
  return candidates.some((candidate) => {
    const segments = candidate.replace(/\\/g, "/").split("/").filter((s) => s !== "");
    return expected.treeSubpaths.some((subpath) => {
      const want = subpath.split("/").filter((s) => s !== "");
      if (want.length === 0) return false;
      // `< segments.length` (not `<=`): the subtree must have at least one segment BENEATH it, so the
      // directory itself never counts as a missing module.
      for (let start = 0; start + want.length < segments.length; start++) {
        if (want.every((w, i) => segments[start + i] === w)) return true;
      }
      return false;
    });
  });
}

/**
 * True only when `error` is a module-not-found naming one of `expected.moduleSubpaths` — the private
 * modules excluded from the public build file by file. Everything else, including a missing module
 * that merely sits in the same DIRECTORY as a listed one, is a real failure the caller must rethrow.
 *
 * The subpath must match the END of the candidate as whole segments, with the extension stripped, so
 * `dist/core/compactor.js` and `src/core/compactor.ts` are both absence while
 * `dist/core/compactor-registry.js` and `dist/core/compaction-artifacts.js` are matched only by their
 * own entries. Anchoring at the END (rather than anywhere, as the tree predicate does) is what keeps
 * a two-segment path like `core/compactor` from matching an unrelated deep path that happens to
 * contain those segments in the middle.
 */
export function isModuleSetAbsentError(error: unknown, expected: ExpectedModuleSet): boolean {
  const candidates = moduleNotFoundCandidates(error);
  if (candidates === undefined) return false;
  return candidates.some((candidate) => {
    const segments = withoutKnownExtension(candidate.replace(/\\/g, "/"))
      .split("/")
      .filter((s) => s !== "");
    return expected.moduleSubpaths.some((subpath) => {
      const want = subpath.split("/").filter((s) => s !== "");
      if (want.length === 0 || want.length > segments.length) return false;
      const start = segments.length - want.length;
      return want.every((w, i) => segments[start + i] === w);
    });
  });
}
