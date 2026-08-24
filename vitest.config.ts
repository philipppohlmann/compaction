import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep vitest's default excludes (node_modules, dist, .git, .cache, …) and
    // also ignore the `.claude/` directory. Agent worktrees live under
    // `.claude/worktrees/<id>/` — each is a full copy of this repo, so without
    // this exclude the default test glob sweeps their `tests/**` into the run,
    // producing inflated/duplicated counts and spurious failures from stale
    // sibling checkouts. `npm test` should only run this repo's own `tests/`.
    //
    // `apps/**` is also excluded: the separate packages under `apps/` (e.g.
    // `apps/web`, `apps/api`) have their OWN toolchains and test scripts. The
    // CLI build/tests/`npm run verify` must stay independent of `apps/*`, so the
    // root run never sweeps their `*.test.ts` files.
    exclude: [...configDefaults.exclude, "**/.claude/**", ".claude/**", "apps/**"],

    // Explicit, because vitest's 5s default does not fit this suite. Much of `tests/cli/**` spawns a
    // real CLI subprocess against `dist/` per test case, paying node startup + module load before it
    // asserts anything, and files run in parallel — so per-test wall clock tracks machine load. On an
    // idle machine 15 tests already exceed 5s and 25 exceed 4s.
    //
    // Those tests pass today only because 16 test files hand-roll their own per-test timeout to opt
    // out of the default (`grep -rlE '^\s*\}\s*,\s*[0-9]{4,}\s*\)' tests/` — the trailing-argument
    // form; no file in the suite uses `{timeout: N}` or `vi.setConfig({testTimeout})`). An earlier
    // draft of this comment said 35, which was never measured; the count is stated with its method so
    // the next reader can re-run it. That is the actual defect: the default is wrong for the suite, so every new
    // subprocess test must remember a magic number, and one that forgets fails as
    // `Test timed out in 5000ms` with no assertion failure — a signal that reports machine speed, not
    // correctness. Setting the default the suite actually needs makes the opt-outs redundant rather
    // than load-bearing. 30s is well clear of observed spawn cost and still fails a hung subprocess in
    // bounded time.
    testTimeout: 30_000,

    // Runs once per test FILE, before that file's imports. Neutralizes the two pieces of ambient
    // developer state that otherwise decide whether the suite is green: a real `~/.compaction`
    // install (whose `product_mode` authorizes gateway output shaping) and an exported `FORCE_COLOR`
    // (which makes chalk emit escapes into asserted CLI output). See the file for the full rationale.
    setupFiles: ["tests/helpers/hermetic-env.ts"]
  }
});
