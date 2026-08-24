/**
 * OPEN `basic` OUTPUT SHAPING AT THE GATEWAY — the engine-free public path.
 *
 * These tests run a REAL gateway against a REAL HTTP upstream and inspect what the upstream RECEIVED,
 * with NO lease, NO stored authorization and NO engine — the published artifact's configuration. That
 * is the whole point: the private engine is excluded from the npm package, so an Open user's shaping
 * has to come from the public planner or it does not come at all.
 *
 * The per-turn LINE is an acceptance criterion here, not an afterthought, so the line is asserted
 * alongside the forwarded bytes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import https, { type RequestOptions } from "node:https";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer } from "../../src/core/gateway/server.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { readRecovery } from "../../src/core/gateway/recovery.js";
import { OUTPUT_SHAPING_POLICY_MARKER } from "../../src/core/output-shaping.js";
import { writeProductMode, type ProductMode } from "../../src/core/onboarding-preferences.js";
import { updateCalibrationFromAbSummary } from "../../src/core/output-shaping-calibration-store.js";
import {
  addOutputShapingAbRun,
  initOutputShapingAbExperiment,
  summarizeOutputShapingAb,
  type OutputShapingAbExperiment,
  type OutputShapingAbRun
} from "../../src/core/output-shaping-ab.js";

/** Provider-reported output of 400 on the turn, so the line has a real count to render. */
const UPSTREAM_REPLY = JSON.stringify({ id: "msg_fake", usage: { input_tokens: 1200, output_tokens: 400 } });
const BODY = JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "add a null check to the parser" }] });

function listen(s: Server): Promise<number> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
}
function close(s: Server): Promise<void> {
  return new Promise((r) => s.close(() => r()));
}
function post(port: number, path: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Seed a calibrated rate through the REAL store API (never a hand-written fixture). */
async function seedCalibration(configDir: string, control: number, treatment: number): Promise<void> {
  let exp: OutputShapingAbExperiment = initOutputShapingAbExperiment({ experimentId: "e-seed", taskShape: "code" });
  const run = (arm: "control" | "treatment", outputTokens: number): OutputShapingAbRun => ({
    arm,
    outputTokens,
    inputTokens: 1000,
    providerReported: true,
    tokenSource: "provider-reported",
    ...(arm === "treatment" ? { policyFamily: "output_shaping" as const, policyNames: ["concise_response"], evalMarkersPreserved: true } : {})
  });
  for (let i = 0; i < 3; i++) exp = addOutputShapingAbRun(exp, run("control", control));
  for (let i = 0; i < 3; i++) exp = addOutputShapingAbRun(exp, run("treatment", treatment));
  await updateCalibrationFromAbSummary(summarizeOutputShapingAb(exp), { COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv);
}

describe("gateway Open `basic` output shaping — engine-free, account-free, no lease", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    vi.restoreAllMocks();
  });

  async function setup(mode: ProductMode | null, extraEnv: Record<string, string> = {}): Promise<{
    port: number;
    seen: string[];
    receipts: GatewayReceipt[];
    logs: string[];
    cwd: string;
    configDir: string;
  }> {
    const seen: string[] = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(UPSTREAM_REPLY);
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    vi.spyOn(https, "request").mockImplementation(((o: RequestOptions, cb: (r: unknown) => void) =>
      request({ ...o, protocol: "http:", hostname: "127.0.0.1", port: upstreamPort }, cb as Parameters<typeof request>[1])) as typeof https.request);

    const cwd = mkdtempSync(join(tmpdir(), "openbasic-cwd-"));
    const configDir = mkdtempSync(join(tmpdir(), "openbasic-cfg-"));
    dirs.push(cwd, configDir);
    mkdirSync(configDir, { recursive: true });
    // NO lease, NO credentials, NO stored authorization: exactly an Open device.
    const entitlementEnv = { COMPACTION_CONFIG_DIR: configDir, ...extraEnv } as NodeJS.ProcessEnv;
    if (mode) writeProductMode(mode, entitlementEnv);

    const receipts: GatewayReceipt[] = [];
    const logs: string[] = [];
    const gateway = createGatewayServer({
      provider: "anthropic",
      upstream: "https://evil.invalid/ignored",
      mode: "record",
      workflow: "claude-code",
      cwd,
      entitlementEnv,
      log: (l) => logs.push(l),
      onReceipt: (r) => receipts.push(r)
    });
    servers.push(gateway);
    return { port: await listen(gateway), seen, receipts, logs, cwd, configDir };
  }

  /**
   * Wait for the receipt AND for the per-turn line that follows it. The apply receipt is recorded
   * fire-and-forget (`void recordApplyReceiptFor`), so `onReceipt` fires one await BEFORE the line is
   * logged; waiting only on the receipt races the assertion that matters most here.
   */
  async function settle(receipts: GatewayReceipt[], logs: string[]): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (receipts.length > 0 && logs.some((l) => l.startsWith("compaction \u00b7 "))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("mode BASIC: the upstream receives the shaping instruction, with no engine and no lease", async () => {
    const ctx = await setup("basic");
    expect(await post(ctx.port, "/v1/messages", BODY)).toBe(200);
    await settle(ctx.receipts, ctx.logs);

    expect(ctx.seen).toHaveLength(1);
    expect(ctx.seen[0], "the published, engine-free path must shape").toContain(OUTPUT_SHAPING_POLICY_MARKER);
    // The user's own message is untouched — Open never mutates model-visible INPUT.
    expect(ctx.seen[0]).toContain("add a null check to the parser");
  });

  it("the per-turn LINE reads `basic shaping`, and says so because the RECEIPT says so", async () => {
    const ctx = await setup("basic");
    expect(await post(ctx.port, "/v1/messages", BODY)).toBe(200);
    await settle(ctx.receipts, ctx.logs);

    const receipt = ctx.receipts[0];
    expect(receipt.request_mutated).toBe(true);
    expect(receipt.applied_components).toContain("output-shaping");
    // Open does not compact input, so no before→after pair exists and no input arrow can be rendered.
    expect(receipt.estimated_input_tokens_before).toBeUndefined();

    const line = ctx.logs.find((l) => l.startsWith("compaction · "));
    expect(line, "a per-turn line must be emitted").toBeDefined();
    expect(line).toContain("basic shaping");
    expect(line).toContain("observed input 1,200"); // a plain count, never a reduction
    // The OUTPUT arrow now renders from the shipped default prior, so a fresh install shows a
    // reduction rather than a bare count. Its label carries the PROVENANCE
    // `est. · default prior` (G7) — a default prior must never read as this device's measured evidence.
    expect(line).toMatch(/output [\d,]+→400 \(−\d+%, est\. · default prior\)/);
    // NO INPUT REDUCTION on an Open line -- the load-bearing Open guarantee. Anchored to the input
    // clause itself: the previous `/input .*→/` spanned across the ` · output …→…` arrow and would now
    // fail on a correct line, which would have looked like a regression and was not one.
    expect(line).not.toMatch(/observed input [\d,]+→/);
    expect(line).not.toMatch(/· input [\d,]+→/);
  });

  it("with a calibrated rate the line carries the output arrow; without one, a plain count", async () => {
    // Uncalibrated first: same turn, no arrow, no fabricated before.
    const plain = await setup("basic");
    expect(await post(plain.port, "/v1/messages", BODY)).toBe(200);
    await settle(plain.receipts, plain.logs);
    // "Uncalibrated" no longer means "no arrow": a fresh install carries the shipped prior, so the
    // arrow renders immediately. What still distinguishes it is the RATE -- the prior's 47% here vs
    // the device's own 40% below once it has measured.
    const plainLine = plain.logs.find((l) => l.startsWith("compaction · "));
    // The default prior is labelled AS a default prior (provenance honesty, G7).
    expect(plainLine).toMatch(/output [\d,]+→400 \(−47%, est\. · default prior\)/);

    // Now a real measured 40% A/B (1000→600), folded through the real store.
    const calibrated = await setup("basic");
    await seedCalibration(calibrated.configDir, 1000, 600);
    expect(await post(calibrated.port, "/v1/messages", BODY)).toBe(200);
    await settle(calibrated.receipts, calibrated.logs);
    const calLine = calibrated.logs.find((l) => l.startsWith("compaction · "));
    // The device's OWN 40% replaces the prior outright: before = 400 + round(400 * 0.4/0.6) = 667.
    expect(calLine).toContain("output 667→400");
    expect(calLine, "the measured rate displaces the prior").not.toContain("−47%");
    expect(calLine).toContain("basic shaping");
    // F7 (the defect): a measured turn and a default-prior turn must render DIFFERENTLY. The measured
    // turn carries the plain calibrated `est.` and NOT the `default prior` provenance suffix.
    expect(calLine).toContain("(−40%, est.)");
    expect(calLine, "a device measurement is not a default prior").not.toContain("default prior");
    expect(plainLine, "the two provenances render differently").not.toBe(calLine);
  });

  it("DOUBLE-SHAPING GUARD: a body the tool's hook already shaped is forwarded unchanged", async () => {
    const ctx = await setup("basic");
    const alreadyShaped = JSON.stringify({
      model: "claude-x",
      system: `${OUTPUT_SHAPING_POLICY_MARKER}\n- Answer concisely.`,
      messages: [{ role: "user", content: "add a null check to the parser" }]
    });
    expect(await post(ctx.port, "/v1/messages", alreadyShaped)).toBe(200);
    await settle(ctx.receipts, ctx.logs);

    expect(ctx.seen[0], "byte-exact: no second policy block").toBe(alreadyShaped);
    // Exactly one occurrence of the marker — not two.
    expect(ctx.seen[0].split(OUTPUT_SHAPING_POLICY_MARKER)).toHaveLength(2);
    expect(ctx.receipts[0].request_mutated).not.toBe(true);
    expect(ctx.logs.some((l) => l.includes("already carries the shaping policy"))).toBe(true);
  });

  it("mode OBSERVE forwards byte-exact and claims nothing", async () => {
    const ctx = await setup("observe");
    expect(await post(ctx.port, "/v1/messages", BODY)).toBe(200);
    await settle(ctx.receipts, ctx.logs);
    expect(ctx.seen[0]).toBe(BODY);
    const line = ctx.logs.find((l) => l.startsWith("compaction · "));
    expect(line).not.toContain("basic shaping");
  });

  it("`compaction stop` / COMPACTION_SHAPING_HOOKS=0 turns OFF gateway shaping too", async () => {
    // One switch for one user-visible idea: the same kill switch the tool-hook path reads.
    const ctx = await setup("basic", { COMPACTION_SHAPING_HOOKS: "0" });
    expect(await post(ctx.port, "/v1/messages", BODY)).toBe(200);
    await settle(ctx.receipts, ctx.logs);
    expect(ctx.seen[0]).toBe(BODY);
  });

  it("the byte-exact ORIGINAL is retained and recoverable for a shaped turn", async () => {
    const ctx = await setup("basic");
    expect(await post(ctx.port, "/v1/messages", BODY)).toBe(200);
    await settle(ctx.receipts, ctx.logs);

    const recoveryId = ctx.receipts[0].recovery_id;
    expect(recoveryId, "the original must be retained on this path").toBeDefined();
    const recovered = readRecovery(ctx.cwd, recoveryId as string);
    expect(recovered?.original_body, "byte-exact").toBe(BODY);
    expect(recovered?.policy).toBe("open-basic-output-apply");
  });

  it("makes `.compaction/` self-ignoring, so retained prompt bodies can never be committed", async () => {
    // The recovery store holds the byte-exact ORIGINAL request body — the user's prompt, and for an
    // agent tool the source files embedded in it. Its docstring promised "gitignored", but nothing in
    // the product ever wrote a `.gitignore`; that promise was only ever this repo's own. Wiring Open
    // basic shaping made the store HOT (one file per shaped POST, in the user's project directory), so
    // the guarantee now has to enforce itself.
    const ctx = await setup("basic");
    expect(await post(ctx.port, "/v1/messages", BODY)).toBe(200);
    await settle(ctx.receipts, ctx.logs);

    const ignore = join(ctx.cwd, ".compaction", ".gitignore");
    expect(existsSync(ignore), "a shaped turn must leave the state dir self-ignoring").toBe(true);
    expect(readFileSync(ignore, "utf8")).toContain("*");
    // And the body really is sitting there, which is why the ignore file matters.
    const recovered = readRecovery(ctx.cwd, ctx.receipts[0].recovery_id as string);
    expect(recovered?.original_body).toBe(BODY);
  });

  it("never overwrites a .gitignore the user already wrote there", async () => {
    const ctx = await setup("basic");
    const stateDir = join(ctx.cwd, ".compaction");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, ".gitignore"), "# mine\n!keep-me\n", "utf8");
    expect(await post(ctx.port, "/v1/messages", BODY)).toBe(200);
    await settle(ctx.receipts, ctx.logs);
    expect(readFileSync(join(stateDir, ".gitignore"), "utf8")).toBe("# mine\n!keep-me\n");
  });

  it("the receipt records what actually happened: no stored-authorization claim, matching policy", async () => {
    // The shared output-shaping label asserts "under stored scoped authorization" and the receipt's
    // policy defaulted to `deterministic-dedupe` — neither true here, and the second disagreed with the
    // recovery record for the same turn.
    const ctx = await setup("basic");
    expect(await post(ctx.port, "/v1/messages", BODY)).toBe(200);
    await settle(ctx.receipts, ctx.logs);

    const receipt = ctx.receipts[0] as unknown as Record<string, unknown>;
    expect(receipt.policy, "agrees with the recovery record").toBe("open-basic-output-apply");
    expect(readRecovery(ctx.cwd, ctx.receipts[0].recovery_id as string)?.policy).toBe("open-basic-output-apply");
    expect(String(receipt.label)).not.toContain("stored scoped authorization");
    expect(String(receipt.label)).toContain("open basic output shaping");

    // THE LABEL MUST NOT CONTRADICT THE RECEIPT IT RIDES ON. An earlier version said
    // "your model-visible INPUT was not changed" while `model_visible_bytes_changed` on the SAME object
    // was true — attaching the block adds model-visible text. The honest claim is the one that is
    // actually checkable: the block is appended, the user's own messages are untouched.
    expect(receipt.model_visible_bytes_changed).toBe(true);
    expect(String(receipt.label)).not.toContain("model-visible INPUT was not changed");
    expect(String(receipt.label)).toContain("adds model-visible instruction text");
    expect(String(receipt.label), "the real Open/Community line").toContain("never compacted");
  });

  it("an explicit per-call `record` header still wins: no shaping", async () => {
    const ctx = await setup("basic");
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: ctx.port,
          method: "POST",
          path: "/v1/messages",
          headers: { "content-type": "application/json", "x-compaction-mode": "record", "content-length": String(Buffer.byteLength(BODY)) }
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve());
        }
      );
      req.on("error", reject);
      req.write(BODY);
      req.end();
    });
    await settle(ctx.receipts, ctx.logs);
    expect(ctx.seen[0]).toBe(BODY);
  });

  it("a GET is never shaped (only POST bodies are request shapes)", async () => {
    const ctx = await setup("basic");
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: ctx.port, method: "GET", path: "/v1/models" }, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });
    expect(ctx.seen[0] ?? "").not.toContain(OUTPUT_SHAPING_POLICY_MARKER);
  });
});
