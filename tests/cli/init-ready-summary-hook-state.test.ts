/**
 * THE READY SUMMARY RE-READS THE HOOK STATE; IT DOES NOT TRUST ITS CALLER.
 *
 * `ReadyRoutingInputs` is computed ONCE, near the top of `init`, before anything is written. #882 added
 * a hook-state axis (`shapingHooksInstalled`) to it whose absent value false-defaults to "not installed",
 * which is the right, understating default — but it made every caller that forgot to refresh the inputs
 * print a false negative. The durable post-TUI summary was that caller: after a SUCCESSFUL interactive
 * Codex enable, the alt-screen said shaping was on and the scrollback it left behind said
 * "output shaping is NOT active for Codex", from the same run.
 *
 * So the invariant under test is NOT "this call site remembered to refresh". It is that the renderer
 * itself resolves the hook axis from the tool's own config, so PRE-INSTALL inputs still render the
 * post-install truth and no future call site can reintroduce the defect.
 *
 * In-process against an isolated HOME (the post-TUI path needs a TTY, so it is not reachable from a
 * CLI subprocess here); the real-CLI halves of this contract live in init-connect-subscription-hooks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  onboardingCompletionBlock,
  readySummaryBlock,
  readySummaryBlockForDetection
} from "../../src/cli/commands/init.js";
import { computeCapabilityMatrix, deriveProviderCapabilities } from "../../src/core/gateway/capability-matrix.js";
import { ADAPTERS } from "../../src/core/gateway/provider-adapter.js";
import { ROUTE_COMMANDS } from "../../src/cli/commands/dev.js";
import type { ReadyRoutingInputs } from "../../src/cli/onboarding/model.js";
import type { ConnectDetection } from "../../src/cli/onboarding/model.js";

let root: string;
let home: string;
let savedHome: string | undefined;
let savedCompactionHome: string | undefined;
let savedConfigDir: string | undefined;

/** Exactly the inputs `computeReadyRoutingInputs()` produces BEFORE the enable: no hook axis at all. */
function preInstallRoutingInputs(): ReadyRoutingInputs {
  return {
    matrix: computeCapabilityMatrix({ verifications: [] }),
    providerCaps: deriveProviderCapabilities(ADAPTERS, []),
    routeCommands: ROUTE_COMMANDS
  };
}

/** Write the two entries a successful `init --connect codex` leaves in ~/.codex/hooks.json. */
function writeInstalledCodexHooks(): void {
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(
    path.join(home, ".codex", "hooks.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "compaction hooks shape codex", timeout: 10 }] }],
        Stop: [{ hooks: [{ type: "command", command: "compaction hooks line codex", timeout: 5 }] }]
      }
    }),
    "utf8"
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ready-hook-state-"));
  home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  savedHome = process.env.HOME;
  savedCompactionHome = process.env.COMPACTION_HOME;
  savedConfigDir = process.env.COMPACTION_CONFIG_DIR;
  process.env.HOME = home;
  process.env.COMPACTION_HOME = path.join(home, ".compaction");
  process.env.COMPACTION_CONFIG_DIR = path.join(home, ".compaction", "config");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedCompactionHome === undefined) delete process.env.COMPACTION_HOME;
  else process.env.COMPACTION_HOME = savedCompactionHome;
  if (savedConfigDir === undefined) delete process.env.COMPACTION_CONFIG_DIR;
  else process.env.COMPACTION_CONFIG_DIR = savedConfigDir;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("readySummaryBlock resolves the shaping-hook axis itself", () => {
  it("durable mixed completion never claims ready and preserves successful tools", () => {
    const text = onboardingCompletionBlock(["claude-code"], ["codex"]).join("\n");
    expect(text).toContain("Setup incomplete");
    expect(text).not.toContain("Compaction is ready");
    expect(text).toContain("Configured: Claude Code");
    expect(text).toContain("Codex: retry with `compaction init --connect codex`");
    expect(text).toContain("compaction status     Check setup");
    expect(text).toContain("compaction activity   See recent results");
    expect(text).toContain("compaction init       Reconfigure");
    expect(text).toContain("compaction stop       Disable");
  });

  it("PRE-INSTALL inputs + hooks now on disk ⇒ configured stays distinct from native-active", async () => {
    writeInstalledCodexHooks();
    const text = (await readySummaryBlock(["codex"], undefined, preInstallRoutingInputs())).join("\n");
    expect(text).toContain("Codex → ✓ Enabled");
    expect(text, "the durable summary re-printed the machine as it was BEFORE the enable").not.toContain(
      "output shaping is NOT active for Codex"
    );
    expect(text).toContain("output shaping is configured for Codex");
    expect(text).toContain("depends on its one-time hook approval");
    expect(text).not.toContain("a concise-response instruction is attached before generation");
  });

  it("no hooks on disk ⇒ the same inputs render the honest NOT-active line (it understates, both ways)", async () => {
    const text = (await readySummaryBlock(["codex"], undefined, preInstallRoutingInputs())).join("\n");
    expect(text).toContain("output shaping is NOT active for Codex");
    expect(text).not.toContain("a concise-response instruction is attached before generation");
  });

  it("a caller's STALE positive claim cannot survive either: absent on disk beats present in the inputs", async () => {
    const stale: ReadyRoutingInputs = { ...preInstallRoutingInputs(), shapingHooksInstalled: ["codex"] };
    const text = (await readySummaryBlock(["codex"], undefined, stale)).join("\n");
    expect(text).toContain("output shaping is NOT active for Codex");
  });

  it("Cursor's session-level hook follows the same re-read", async () => {
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(home, ".cursor", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "compaction hooks shape cursor" }] } }),
      "utf8"
    );
    const text = (await readySummaryBlock(["cursor"], undefined, preInstallRoutingInputs())).join("\n");
    expect(text).not.toContain("output shaping is NOT active for Cursor");
    expect(text).toContain("ONE session-level instruction per session");
  });

  it("the production summary path keeps a desktop-only Cursor install on its native hook", async () => {
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(home, ".cursor", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "compaction hooks shape cursor" }] } }),
      "utf8"
    );
    const detection: ConnectDetection = {
      claude: { detected: false, sessionCount: 0 },
      codex: "absent",
      cursor: { desktopDetected: true, hookReady: false, cli: "absent" }
    };

    const text = (
      await readySummaryBlockForDetection(["cursor"], detection, undefined, preInstallRoutingInputs())
    ).join("\n");

    expect(text).toContain("Cursor desktop app (native session hook)");
    expect(text).toContain("Cursor → ✓ Enabled (plan-auth, default):  native sessionStart hook");
    expect(text).not.toContain("cursor-agent");
  });

  it("a HALF-installed Codex config (shaping entry only) is not claimed as installed", async () => {
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(
      path.join(home, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "compaction hooks shape codex" }] }] }
      }),
      "utf8"
    );
    const text = (await readySummaryBlock(["codex"], undefined, preInstallRoutingInputs())).join("\n");
    expect(text).toContain("output shaping is NOT active for Codex");
  });
});
