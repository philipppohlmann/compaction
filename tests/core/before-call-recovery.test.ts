import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { retainOriginalPrompt } from "../../src/core/before-call-recovery.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "bc-recovery-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("retainOriginalPrompt - local-only, recoverable, content-safe pointer", () => {
  it("writes the ORIGINAL under .compaction/before-call-recovery and returns a content-free pointer", () => {
    const original = "SECRET original prompt text with confidential details";
    const retained = retainOriginalPrompt(original, { cwd, idFactory: () => "fixed-id-123" });

    // the artifact lives under the gitignored .compaction subtree (never committed/uploaded)
    expect(retained.recoveryPath).toContain(path.join(".compaction", "before-call-recovery"));
    expect(existsSync(retained.recoveryPath)).toBe(true);
    // the ORIGINAL is recoverable verbatim
    expect(readFileSync(retained.recoveryPath, "utf8")).toBe(original);

    // the POINTER is content-free: it carries the id, never the prompt text
    expect(retained.pointer).toBe("before-call-recovery:fixed-id-123");
    expect(retained.pointer).not.toContain("SECRET");
    expect(retained.pointer).not.toContain("confidential");
    expect(retained.recoveryId).toBe("fixed-id-123");
  });

  it("uses a content-free random id (not derived from the prompt) by default", () => {
    const a = retainOriginalPrompt("prompt one", { cwd });
    const b = retainOriginalPrompt("prompt one", { cwd });
    // identical content → DIFFERENT ids (ids are random, not content-derived)
    expect(a.recoveryId).not.toBe(b.recoveryId);
  });
});
