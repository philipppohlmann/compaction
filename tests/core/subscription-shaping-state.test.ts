import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SHAPING_STATE_VERSION,
  isShapingStopped,
  readShapingRunState,
  shapingStatePath,
  startShaping,
  stopShaping
} from "../../src/core/subscription-shaping-state.js";
import { isShapingHooksActivated } from "../../src/core/output-shaping-hook-activation.js";

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-shaping-state-"));
  env = { COMPACTION_CONFIG_DIR: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("subscription shaping run-state (persisted stop/start)", () => {
  it("defaults to ACTIVE (fail-open) when no state file exists", () => {
    expect(readShapingRunState(env)).toBe("active");
    expect(isShapingStopped(env)).toBe(false);
  });

  it("stop persists `stopped`, start persists `active`; both are idempotent + report what changed", () => {
    const stopped = stopShaping(env);
    expect(stopped.previous).toBe("active");
    expect(stopped.current).toBe("stopped");
    expect(stopped.changed).toBe(true);
    expect(isShapingStopped(env)).toBe(true);

    const stopAgain = stopShaping(env);
    expect(stopAgain.changed).toBe(false); // idempotent

    const started = startShaping(env);
    expect(started.previous).toBe("stopped");
    expect(started.current).toBe("active");
    expect(started.changed).toBe(true);
    expect(isShapingStopped(env)).toBe(false);

    expect(startShaping(env).changed).toBe(false); // idempotent
  });

  it("writes only the versioned, whitelisted keys (content-free)", () => {
    stopShaping(env);
    const raw = JSON.parse(readFileSync(shapingStatePath(env), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["shaping", "version"]);
    expect(raw.version).toBe(SHAPING_STATE_VERSION);
    expect(raw.shaping).toBe("stopped");
  });

  it("a WRONG-VERSION file is not trusted - reads as the default active (versioned-activation discipline)", () => {
    writeFileSync(shapingStatePath(env), JSON.stringify({ version: "some-older-version", shaping: "stopped" }), "utf8");
    expect(readShapingRunState(env)).toBe("active"); // foreign version can never flip us to stopped
  });

  it("a corrupt / wrong-shape file reads as the default active (fail-open, never throws)", () => {
    writeFileSync(shapingStatePath(env), "not json {{{", "utf8");
    expect(readShapingRunState(env)).toBe("active");
    writeFileSync(shapingStatePath(env), JSON.stringify(["array"]), "utf8");
    expect(readShapingRunState(env)).toBe("active");
  });
});

describe("activation honors BOTH the env kill-switch AND the persisted stop-state", () => {
  it("is active when neither is set", () => {
    expect(isShapingHooksActivated(env as NodeJS.ProcessEnv)).toBe(true);
  });

  it("is DISABLED by the persisted stop-state alone (env kill-switch clear)", () => {
    stopShaping(env);
    expect(isShapingHooksActivated(env as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is DISABLED by the env kill-switch alone (state active)", () => {
    expect(isShapingHooksActivated({ ...env, COMPACTION_SHAPING_HOOKS: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("start re-enables activation (clears the persisted stop) when the env kill-switch is clear", () => {
    stopShaping(env);
    expect(isShapingHooksActivated(env as NodeJS.ProcessEnv)).toBe(false);
    startShaping(env);
    expect(isShapingHooksActivated(env as NodeJS.ProcessEnv)).toBe(true);
  });

  it("the env kill-switch STILL overrides even after start (both must be clear to shape)", () => {
    startShaping(env);
    expect(isShapingHooksActivated({ ...env, COMPACTION_SHAPING_HOOKS: "off" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
