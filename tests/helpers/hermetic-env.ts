/**
 * HERMETIC TEST ENVIRONMENT (vitest `setupFiles`, runs once per test FILE before its imports).
 *
 * WHY THIS EXISTS. The suite is green on CI and red on a developer machine that actually uses the
 * product, and neither state was a statement about the code. Two pieces of ambient developer state
 * leak into any test that does not explicitly override them, because the CLI reads them from the
 * real environment and every spawned child inherits `process.env`:
 *
 *  1. `~/.compaction/preferences.json`. A dogfooding install persists `product_mode: "basic"`, which
 *     is the WHOLE authorization for the Open-basic gateway output-shaping path: on a `basic` device the gateway legitimately attaches a shaping
 *     system message to an otherwise-unmutated request. Tests that assert byte-identical passthrough
 *     then fail while the implementation is behaving exactly as its contract says. The fresh-machine
 *     default is `observe` (`DEFAULT_PRODUCT_MODE`), which shapes nothing — so an EMPTY config dir,
 *     not a hand-written one, is the correct default posture to test against.
 *
 *  2. `HOME`. Compaction is an INSTALL-ONCE product, so the Claude Code integration now installs into
 *     `~/.claude/settings.json` by DEFAULT (a project-scoped install would not survive a new repo or
 *     worktree). Any test that runs a real `init --connect` / `hooks install` without overriding HOME
 *     would therefore mutate the DEVELOPER'S OWN Claude Code settings — installing a status line and
 *     hooks on their machine as a side effect of running the suite. The project-scoped default used to
 *     mask this; it never made the tests hermetic. HOME is redirected per test FILE so a connect lands
 *     in a throwaway home, and `claudeSettingsHome()` reads `env.HOME` first precisely so this works.
 *
 *  3. `FORCE_COLOR`. Some terminals and agent harnesses export it (e.g. `FORCE_COLOR=3`), which makes
 *     chalk emit SGR escapes inside CLI output and breaks raw-substring assertions — `run \e[1mcompaction\e[22m`
 *     no longer contains `run compaction`. It is DELETED rather than set to `0`, and deliberately not
 *     replaced with `NO_COLOR`: chalk treats an empty `FORCE_COLOR` as colors-ON (already documented at
 *     `tests/cli/exhausted-allowance-notices.test.ts`), and `NO_COLOR` is itself an input some tests
 *     assert on (`tests/cli/terminal-logo.test.ts`). Deleting it reproduces CI exactly: no
 *     `FORCE_COLOR`, no TTY, chalk off.
 *
 * SCOPE. This sets the DEFAULT only. A test that sets its own `COMPACTION_CONFIG_DIR` (directly or in
 * a child's env) still wins, and no assertion anywhere is relaxed by this file — it removes a variable
 * the tests never meant to measure.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Per-test-FILE, so parallel workers cannot observe each other's writes.
const configDir = mkdtempSync(join(tmpdir(), "compaction-hermetic-"));
process.env.COMPACTION_CONFIG_DIR = configDir;
const homeDir = mkdtempSync(join(tmpdir(), "compaction-hermetic-home-"));
process.env.HOME = homeDir;
delete process.env.FORCE_COLOR;

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});
