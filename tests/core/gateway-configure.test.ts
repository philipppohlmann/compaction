import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectProject,
  planGatewayConfigure,
  applyGatewayConfigure,
  formatConfigurePlan,
  CONFIGURE_ENV_VAR
} from "../../src/core/gateway/configure.js";

/**
 * Gateway project configure. Binding rules: approval-gated (plan writes NOTHING),
 * apply creates a `.bak` backup first, and it NEVER overwrites an existing provider base URL without an
 * explicit force. These tests exercise create / append / conflict on a temp project.
 */
const BASE = "http://127.0.0.1:8787/v1";

describe("gateway configure - approval-gated, backup-first, no overwrite without force", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-configure-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("plan writes NOTHING (approval-gated) and previews the exact diff", () => {
    const plan = planGatewayConfigure(dir, BASE);
    expect(plan.action).toBe("create");
    expect(plan.diff).toContain(`${CONFIGURE_ENV_VAR}=${BASE}`);
    // No file was created by planning or formatting.
    formatConfigurePlan(plan);
    expect(fs.existsSync(path.join(dir, ".env"))).toBe(false);
  });

  it("apply CREATE writes only the base-URL line (no backup needed, nothing existed)", () => {
    const plan = planGatewayConfigure(dir, BASE);
    const res = applyGatewayConfigure(dir, plan);
    expect(res.wrote).toBe(true);
    expect(res.backupFile).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toContain(`${CONFIGURE_ENV_VAR}=${BASE}`);
  });

  it("apply APPEND preserves existing content AND writes a .bak backup first", () => {
    fs.writeFileSync(path.join(dir, ".env"), "FOO=bar\n", "utf8");
    const plan = planGatewayConfigure(dir, BASE);
    expect(plan.action).toBe("append");
    const res = applyGatewayConfigure(dir, plan);
    expect(res.wrote).toBe(true);
    expect(res.backupFile).toBe(".env.bak");
    // Backup holds the ORIGINAL content; new file keeps it and adds the line.
    expect(fs.readFileSync(path.join(dir, ".env.bak"), "utf8")).toBe("FOO=bar\n");
    const next = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(next).toContain("FOO=bar");
    expect(next).toContain(`${CONFIGURE_ENV_VAR}=${BASE}`);
  });

  it("CONFLICT: refuses to overwrite an existing base URL without force; writes nothing", () => {
    fs.writeFileSync(path.join(dir, ".env"), "OPENAI_BASE_URL=https://api.openai.com/v1\n", "utf8");
    const detection = detectProject(dir);
    expect(detection.existingBaseUrl?.var).toBe("OPENAI_BASE_URL");
    const plan = planGatewayConfigure(dir, BASE);
    expect(plan.action).toBe("conflict");

    const refused = applyGatewayConfigure(dir, plan); // no force
    expect(refused.wrote).toBe(false);
    expect(refused.reason).toMatch(/force/);
    // Untouched: still the original provider URL, no backup created.
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toContain("https://api.openai.com/v1");
    expect(fs.existsSync(path.join(dir, ".env.bak"))).toBe(false);
  });

  it("CONFLICT with force: backs up, replaces the base-URL line in place", () => {
    fs.writeFileSync(path.join(dir, ".env"), "A=1\nOPENAI_BASE_URL=https://api.openai.com/v1\nB=2\n", "utf8");
    const plan = planGatewayConfigure(dir, BASE);
    const res = applyGatewayConfigure(dir, plan, true);
    expect(res.wrote).toBe(true);
    expect(res.backupFile).toBe(".env.bak");
    const next = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(next).toContain(`OPENAI_BASE_URL=${BASE}`);
    expect(next).not.toContain("https://api.openai.com/v1");
    // Neighbouring keys preserved.
    expect(next).toContain("A=1");
    expect(next).toContain("B=2");
  });

  it("detects the openai SDK dependency in package.json", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { openai: "^4.0.0" } }), "utf8");
    const d = detectProject(dir);
    expect(d.hasPackageJson).toBe(true);
    expect(d.usesOpenAiSdk).toBe(true);
  });
});
