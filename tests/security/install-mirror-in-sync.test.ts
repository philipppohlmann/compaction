import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for the hosted /install mirrors.
 *
 * `scripts/install.sh` is the SINGLE SOURCE OF TRUTH for the public curl
 * installer. Hosted surfaces serve the same script statically at the `/install`
 * path by copying the byte-identical content into their `public/` directory:
 *
 *   - apps/web/public/install         , the marketing site's static mirror.
 *   - apps/cli-install/public/install , the DEDICATED install-only surface that
 *     serves cli.compaction.dev/install and NOTHING else.
 *
 * If ANY mirror drifts from the source, users piping `/install` to a shell from
 * that host would run DIFFERENT code than the audited `scripts/install.sh`, a
 * security-relevant divergence. This test fails the moment a present mirror
 * differs from the source, so no mirror can silently fall out of sync. The fix on
 * failure is always to re-copy the source over the mirror (never to edit a mirror
 * by hand):
 *
 *   cp scripts/install.sh apps/web/public/install
 *   cp scripts/install.sh apps/cli-install/public/install
 *
 * NOTE: this asserts byte-identity only. The installer's *safety* properties
 * (no sudo / no telemetry / no phone-home / Node>=18 gate / honest-not-published)
 * are pinned separately in `install-script-safe.test.ts`, which runs against the
 * source of truth, so a passing pair here means the served script inherits those
 * same guarantees.
 *
 * INDEPENDENCE GATE: the CLI package (`@compaction/cli`, repo root)
 * and its `npm run verify` / `npm test` must remain INDEPENDENT of `apps/web` and
 * `apps/cli-install`, which are separate static surfaces with their own
 * toolchains. This test therefore *existence-gates* on EACH mirror: when a mirror
 * is absent (e.g. a CLI-only checkout, or an app moved/removed), that mirror's
 * drift assertion is SKIPPED so a healthy CLI never fails verification merely
 * because an app is not in the tree. When a mirror IS present, its byte-identity
 * assertion runs and the drift guard stays fully effective, it fails the moment
 * the served script diverges from the audited source. The guard is GATED, not
 * weakened: genuine drift (mirror present but differing) still fails the suite.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const SOURCE = join(REPO_ROOT, "scripts", "install.sh");

/** Every hosted surface that serves a byte-identical copy of the installer. */
const MIRRORS: Array<{ name: string; path: string }> = [
  { name: "apps/web/public/install", path: join(REPO_ROOT, "apps", "web", "public", "install") },
  {
    name: "apps/cli-install/public/install",
    path: join(REPO_ROOT, "apps", "cli-install", "public", "install"),
  },
];

// The source installer always lives in the CLI repo; a mirror only exists when its
// separate app package is present. Gate per-mirror so the CLI suite stays
// independent of those apps yet still catches drift whenever an app is
// checked out.
const presentMirrors = MIRRORS.filter((m) => existsSync(m.path));

describe.skipIf(presentMirrors.length === 0)(
  "/install mirrors are in sync with scripts/install.sh (at least one mirror present)",
  () => {
    it("the installer source of truth exists", () => {
      // If any mirror is present, the source it mirrors must exist too.
      expect(existsSync(SOURCE)).toBe(true);
    });

    // One byte-identity assertion per PRESENT mirror. Absent mirrors are skipped
    // (independence gate) so a CLI-only checkout never fails here.
    for (const mirror of MIRRORS) {
      const present = existsSync(mirror.path);
      it.skipIf(!present)(`${mirror.name} is byte-identical to scripts/install.sh`, () => {
        const source = readFileSync(SOURCE);
        const served = readFileSync(mirror.path);
        // Compare raw bytes (Buffer.equals) so any whitespace / newline / encoding
        // drift is caught, not just visible-character drift.
        expect(served.equals(source)).toBe(true);
      });
    }
  },
);
