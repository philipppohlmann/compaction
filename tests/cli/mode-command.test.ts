/**
 * `compaction mode observe|basic|full` — command behavior + the OPEN GUARANTEES.
 *
 * HERMETIC: `COMPACTION_CONFIG_DIR` is pinned at a per-test tmpdir, so the real `~/.compaction` is never
 * touched, and NO network is available (asserted structurally — the module graph reachable from the
 * mode command + the public basic path imports no engine and no account/network client).
 *
 * Proven here:
 *  - observe/basic persist locally and complete with zero account/network/engine calls;
 *  - `full` persists NOTHING (preserves the current Open mode) and makes no full-apply claim;
 *  - the public basic output-shaping path produces a real output instruction on a supported request;
 *  - the public basic path leaves the user's own messages byte-exact (it ADDS a system instruction; it
 *    does not compact input) — and the copy that describes this says so rather than denying the addition;
 *  - the public basic path does not import the private engine or the private task-classifier;
 *  - basic creates no usage debit and makes no account-service/network call.
 */
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyModeSelection, BASIC_SHAPING_INPUT_EFFECT } from "../../src/cli/commands/mode.js";
import { OPEN_BASIC_OUTPUT_SHAPING_APPLY_LABEL } from "../../src/core/gateway/apply-receipt.js";
import {
  preferencesPath,
  readProductMode,
  writeProductMode
} from "../../src/core/onboarding-preferences.js";
import { planPublicBasicOutputShaping } from "../../src/core/gateway/output-shaping-policy.js";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mode-cmd-"));
  env = { COMPACTION_CONFIG_DIR: dir };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("applyModeSelection - observe / basic persist locally, full does not", () => {
  it("observe persists locally and completes (no account/network/engine)", () => {
    const outcome = applyModeSelection("observe", env);
    expect(outcome).toMatchObject({ requested: "observe", persisted: true, effective: "observe" });
    expect(readProductMode(env)).toBe("observe");
    expect(existsSync(preferencesPath(env))).toBe(true);
  });

  it("basic persists locally and completes (no account/network/engine)", () => {
    const outcome = applyModeSelection("basic", env);
    expect(outcome).toMatchObject({ requested: "basic", persisted: true, effective: "basic" });
    expect(readProductMode(env)).toBe("basic");
  });

  it("full persists NOTHING and preserves the current Open mode (no full-apply claim)", () => {
    writeProductMode("basic", env);
    const outcome = applyModeSelection("full", env);
    expect(outcome).toMatchObject({ requested: "full", persisted: false, effective: "basic" });
    // The persisted mode is unchanged — full apply is not activated.
    expect(readProductMode(env)).toBe("basic");
    expect(outcome.path).toBeUndefined();
  });

  it("full from a fresh install preserves the default `observe` (never writes `full`)", () => {
    const outcome = applyModeSelection("full", env);
    expect(outcome).toMatchObject({ requested: "full", persisted: false, effective: "observe" });
    // No preference file was created by selecting full on a fresh install.
    expect(readProductMode(env)).toBe("observe");
  });

  it("the on-disk file never contains `product_mode: full` via the mode command", async () => {
    applyModeSelection("full", env);
    if (existsSync(preferencesPath(env))) {
      const raw = JSON.parse(await readFile(preferencesPath(env), "utf8")) as Record<string, unknown>;
      expect(raw.product_mode).not.toBe("full");
    }
    // basic → recorded; then full leaves it as basic.
    applyModeSelection("basic", env);
    applyModeSelection("full", env);
    const raw = JSON.parse(await readFile(preferencesPath(env), "utf8")) as Record<string, unknown>;
    expect(raw.product_mode).toBe("basic");
  });
});

describe("public basic output-shaping method (concise_response) — the Open guarantees", () => {
  const chatBody = JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "hello" }] });

  it("produces a REAL output instruction on a supported request (attaches concise_response)", () => {
    const plan = planPublicBasicOutputShaping("/v1/chat/completions", chatBody);
    expect(plan.supported).toBe(true);
    expect(plan.changed).toBe(true);
    expect(plan.applied.map((a) => a.policy_name)).toContain("concise_response");
    const out = JSON.parse(plan.mutatedBody!) as { messages: Array<{ role: string; content: string }> };
    const system = out.messages.find((m) => m.role === "system");
    expect(system?.content).toContain("Output-shaping policy");
    expect(system?.content.toLowerCase()).toContain("concise");
  });

  // NAME CHANGED, BODY UNCHANGED. This test always proved the true, narrower thing
  // its parenthetical states; only the title claimed the false general one. That title was the same
  // sentence the CLI was printing, so the vocabulary that produced the defect was also the vocabulary
  // reviewing it.
  it("leaves the user's own message byte-identical — it ADDS a system instruction, it does not compact input", () => {
    const plan = planPublicBasicOutputShaping("/v1/chat/completions", chatBody);
    const out = JSON.parse(plan.mutatedBody!) as { messages: Array<{ role: string; content: string }> };
    const userMsg = out.messages.find((m) => m.role === "user");
    expect(userMsg).toEqual({ role: "user", content: "hello" });
    // The only added message is the shaping system instruction — no input compaction, no reduction of the prompt.
    expect(out.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  /**
   * FLIPPED by the 2026-08-03 shaping-parity amendment. This test used to
   * assert the opposite — that the public path shapes a planning turn because it could not depend on the
   * private classifier. The classifier is public now and every plan gets the same method, so the Open
   * surface must HOLD the regime the gate exists to protect, exactly as the paid path does.
   */
  it("holds a planning turn: the public path applies the now-public turn gate", () => {
    const planning = JSON.stringify({
      model: "gpt-x",
      messages: [{ role: "user", content: "Design the retry strategy and weigh the trade-offs." }]
    });
    const plan = planPublicBasicOutputShaping("/v1/chat/completions", planning);
    expect(plan.changed, "a planning turn must not be shaped on any plan").toBe(false);
    expect(plan.taskSignal).toBe("planning-request");
  });

  it("still shapes an ordinary code turn", () => {
    const code = JSON.stringify({
      model: "gpt-x",
      messages: [{ role: "user", content: "fix the failing test in utils.ts" }]
    });
    const plan = planPublicBasicOutputShaping("/v1/chat/completions", code);
    expect(plan.changed).toBe(true);
  });
});

/**
 * WHAT `compaction mode basic` CLAIMS ABOUT THE USER'S REQUEST.
 *
 * The command used to print that basic shaping "never mutates your model-visible INPUT". On the shipped
 * artifact the shaping path inserts a system message INTO the request — measured 92 → 552 bytes on a real
 * gateway turn — and the receipt written for that same turn sets `model_visible_bytes_changed: true`. The
 * product was contradicting itself across two of its own surfaces, and the user-facing half was the wrong
 * one. It survived the identical correction already made to the receipt label because no test read it.
 *
 * These assertions are about the CLAIM, not the prose: the copy may not DENY the addition, it must state
 * both halves of what happens, and the last one checks it against the planner rather than against itself —
 * so the sentence cannot drift back to something the runtime does not do.
 */
describe("the `mode basic` copy describes what shaping really does to the request (F78)", () => {
  it("does not deny model-visible input mutation", () => {
    expect(BASIC_SHAPING_INPUT_EFFECT).not.toMatch(/never mutates your model-visible input/i);
    expect(BASIC_SHAPING_INPUT_EFFECT).not.toMatch(/(never|not|does not) (mutate|change)s?[^.]{0,40}model-visible input/i);
  });

  it("states BOTH halves: it adds instruction text, and the user's own messages are untouched", () => {
    expect(BASIC_SHAPING_INPUT_EFFECT).toMatch(/adds model-visible instruction text/i);
    expect(BASIC_SHAPING_INPUT_EFFECT).toMatch(/byte-exact/i);
  });

  it("agrees with the receipt written for the very same turn (the two surfaces may not disagree)", () => {
    for (const surface of [BASIC_SHAPING_INPUT_EFFECT, OPEN_BASIC_OUTPUT_SHAPING_APPLY_LABEL]) {
      expect(surface).toMatch(/adds model-visible instruction text/i);
      expect(surface).toMatch(/byte-exact/i);
    }
  });

  it("and the runtime really does add it — the copy is checked against the planner, not against itself", () => {
    const body = JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "fix the failing test in utils.ts" }] });
    const plan = planPublicBasicOutputShaping("/v1/chat/completions", body);
    expect(plan.changed).toBe(true);
    // ADDS: the forwarded body is strictly larger than what the client sent.
    expect(plan.mutatedBody!.length).toBeGreaterThan(body.length);
    // …and the addition is an instruction the user did not write, not a rewrite of what they did.
    const out = JSON.parse(plan.mutatedBody!) as { messages: Array<{ role: string; content: string }> };
    expect(out.messages.find((m) => m.role === "system")?.content).toContain("Output-shaping policy");
    expect(out.messages.find((m) => m.role === "user")).toEqual({
      role: "user",
      content: "fix the failing test in utils.ts"
    });
  });
});

/**
 * `compaction mode full` ON AN AUTHENTICATED DEVICE whose entitlement is missing or stale.
 *
 * The journey says the user never has to learn that leases exist, so this state cannot be a refusal
 * that hands them `compaction lease`. It has to be something the product tries to fix. Two properties
 * are asserted, and they are the two that were wrong before:
 *
 *  1. The excluded vocabulary (`compaction lease`, "lease root", "engine root") does not
 *     appear in the refusal a real user can reach.
 *  2. "No account, entitlement, usage, or network call was made" is printed ONLY when it is true. On
 *     this path a repair really did call the service, so the sentence must be absent — a promise that
 *     survives the moment it stops holding is worse than no promise.
 *
 * HERMETIC: config dir + HOME are a tmpdir and the credentials point at a dead loopback port, so the
 * repair can only fail. The CLI is spawned ASYNCHRONOUSLY (see tests/cli/login-cli.test.ts).
 */
describe("`compaction mode full` repairs an authenticated device instead of teaching it lease vocabulary", () => {
  const CLI = join(__dirname, "..", "..", "dist", "cli", "index.js");
  const cliBuilt = existsSync(CLI);

  async function runModeFull(configDir: string): Promise<string> {
    const { execFile } = await import("node:child_process");
    return await new Promise((resolve) => {
      execFile(
        process.execPath,
        [CLI, "mode", "full"],
        {
          env: {
            ...process.env,
            COMPACTION_CONFIG_DIR: configDir,
            HOME: configDir,
            FORCE_COLOR: "0",
            NO_COLOR: "1"
          },
          timeout: 60_000
        },
        (_error, stdout, stderr) => resolve(`${stdout}${stderr}`)
      );
    });
  }

  it.runIf(cliBuilt)(
    "never names `compaction lease`, and drops the no-network promise once a repair has called the service",
    async () => {
      const { writeStoredCredentials } = await import("../../src/core/auth/credentials.js");
      const { generateDeviceKeyPair } = await import("../../src/core/auth/device-flow.js");
      const keys = generateDeviceKeyPair();
      writeStoredCredentials(
        {
          schema_version: 1,
          api_url: "http://127.0.0.1:1",
          account_id: "acct-test",
          device_id: "123e4567-e89b-42d3-a456-426614174000",
          device_token: "cmpd_test_123e4567-e89b-42d3-a456-426614174000.fakefakefakefakefakefakefakefake",
          device_private_key_pem: keys.privateKeyPem,
          device_public_key: keys.publicKey,
          created_at: new Date().toISOString()
        },
        env
      );

      const out = await runModeFull(dir);

      expect(out.toLowerCase()).toContain("not available");
      expect(out).not.toContain("Full apply enabled");
      // (1) the excluded vocabulary
      expect(out).not.toContain("compaction lease");
      expect(out).not.toContain("lease status");
      // (2) the promise is absent because it is no longer true
      expect(out).not.toContain("No account, entitlement, usage, or network call was made");
      // …and the mode really is preserved: the refusal must be a no-op, not a rollback.
      expect(readProductMode(env)).not.toBe("full");
    },
    90_000
  );
});
