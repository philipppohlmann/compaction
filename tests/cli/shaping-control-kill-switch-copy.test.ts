import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerStartCommand } from "../../src/cli/commands/shaping-control.js";
import { SHAPING_HOOKS_ENV, isShapingHooksActivated } from "../../src/core/output-shaping-hook-activation.js";

/**
 * Regression for the F65-class defect: `compaction start`'s description named a kill-switch VALUE
 * (`COMPACTION_SHAPING_HOOKS=disable`) that the runtime does not honor, so a user who followed the
 * copy got shaping silently left ON while believing they had switched it off (fails open).
 *
 * This pins the copy AND separately falsifies it against the runtime gate (`isShapingHooksActivated`,
 * which wraps the actual kill-switch parser) so the two assertions cannot hide one another - a broken
 * exact-string pin must not mask a live property regression, and vice versa.
 */

/** Isolated, never-written config dir so `isShapingHooksActivated` only reflects the env kill-switch,
 *  never an ambient persisted `compaction stop` state on the machine running the test. */
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "shaping-control-kill-switch-copy-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function startDescription(): string {
  const program = new Command();
  registerStartCommand(program);
  const start = program.commands.find((cmd) => cmd.name() === "start");
  if (!start) throw new Error("registerStartCommand did not register a `start` command");
  return start.description();
}

describe("`compaction start` description names only kill-switch values the runtime honors", () => {
  it("pins the exact kill-switch clause in the `start` description", () => {
    expect(startDescription()).toContain(
      "If COMPACTION_SHAPING_HOOKS is set to 0/false/off/no (case-insensitive), that still overrides output shaping."
    );
  });

  it("every value the description names actually disables shaping at runtime (falsifies the F65 drift)", () => {
    const namedValues = ["0", "false", "off", "no"];
    for (const value of namedValues) {
      const env = { [SHAPING_HOOKS_ENV]: value, COMPACTION_CONFIG_DIR: configDir };
      expect(isShapingHooksActivated(env)).toBe(false);
    }
  });

  it("the value the OLD (wrong) copy named ('disable') is NOT honored - proves the drift this test guards", () => {
    const env = { [SHAPING_HOOKS_ENV]: "disable", COMPACTION_CONFIG_DIR: configDir };
    expect(isShapingHooksActivated(env)).toBe(true);
    expect(startDescription()).not.toContain("is set to disable");
  });
});
