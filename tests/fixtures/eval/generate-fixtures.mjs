// Deterministic generator for the Phase-1 eval-harness fixtures.
//
// This is a TEST/DEV utility (NOT shipped in the npm tarball — tests/ is denied by package-smoke).
// It builds the VALID and NO-OP fixtures from the REAL shipped compaction pipeline
// (`applyCompactionPolicy`), then derives the FAILING fixtures as single, surgical, deterministic
// corruptions of the valid bundle. Grounding the valid fixtures in real pipeline output (rather than
// hand-writing pointers/hashes) keeps the fixtures honest and drift-free.
//
// Run after build:  node tests/fixtures/eval/generate-fixtures.mjs
//
// Fixtures written (8):
//   01 valid exact recoverability               -> passed
//   02 missing source pointer                   -> failed
//   03 hash mismatch                            -> failed
//   04 ambiguous source span (pointer unresolvable / wrong index+id) -> failed
//   05 removed content not recoverable (original removed) -> failed
//   06 unchanged / no-op trace                  -> not_computed (fail-closed: no recoverability evidence)
//   07 Codex imported/local evidence path       -> passed recoverability, but evidence=imported, real_captured=false
//   08 Claude Code true-label path              -> passed recoverability, evidence reflects the TRUE current label
//
// On #08: the harness derives the evidence label from `trace.source` via the shipped
// `evidenceSourceTypeFromTrace`. A captured Claude Code session normalizes to `real_captured`
// ONLY if its trace carries source==="real_captured". To avoid a no-source-no-claim overclaim,
// fixture 08 uses source==="real_captured" to reflect the capture path's true current label AND
// documents that this is the ONLY source value that unlocks the real_captured eval label; every
// synthetic/imported fixture above (01-07) must NOT.

import { applyCompactionPolicy } from "../../../dist/core/policy-middleware.js";
import { contentHash } from "../../../dist/core/content-hash.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function repeatedPayload(tag) {
  return (
    `${tag} dependency resolution report\n` +
    Array.from(
      { length: 30 },
      (_, i) => `  module-${String(i).padStart(3, "0")}@1.${i}.0  resolved integrity sha512-SYNTHETIC${i}`
    ).join("\n") +
    "\nDONE: synthetic repeated tool output (no real content)."
  );
}

/** Build a small synthetic trace with one repeated tool output that the v0 policy compacts. */
function buildBaseTrace(source) {
  const payload = repeatedPayload("synthetic-build");
  return {
    id: "trace_eval_fixture_001",
    title: "Eval fixture: repeated tool output",
    artifactVersion: "trace-compactor-v0",
    source,
    createdAt: "2026-06-15T10:00:00.000Z",
    generatedAt: "2026-06-15T10:00:00.000Z",
    model: "placeholder-agent-model",
    messages: [
      { id: "m1", role: "system", timestamp: "2026-06-15T10:00:00.000Z", content: "You are a coding agent. Keep changes minimal." },
      { id: "m2", role: "user", timestamp: "2026-06-15T10:00:01.000Z", content: "Run the dependency report twice and compare." },
      { id: "m3", role: "tool", toolName: "deps", timestamp: "2026-06-15T10:00:02.000Z", content: payload },
      { id: "m4", role: "assistant", timestamp: "2026-06-15T10:00:03.000Z", content: "First report captured. Running again to confirm stability." },
      { id: "m5", role: "tool", toolName: "deps", timestamp: "2026-06-15T10:00:04.000Z", content: payload },
      { id: "m6", role: "assistant", timestamp: "2026-06-15T10:00:05.000Z", content: "Both reports are identical; the dependency set is stable." }
    ]
  };
}

/** Build a no-op trace (no repeated tool output) so the policy compacts nothing. */
function buildNoOpTrace(source) {
  return {
    id: "trace_eval_fixture_noop",
    title: "Eval fixture: no-op (nothing to compact)",
    artifactVersion: "trace-compactor-v0",
    source,
    createdAt: "2026-06-15T10:00:00.000Z",
    generatedAt: "2026-06-15T10:00:00.000Z",
    model: "placeholder-agent-model",
    messages: [
      { id: "n1", role: "system", timestamp: "2026-06-15T10:00:00.000Z", content: "You are a coding agent." },
      { id: "n2", role: "user", timestamp: "2026-06-15T10:00:01.000Z", content: "What is 2 + 2?" },
      { id: "n3", role: "assistant", timestamp: "2026-06-15T10:00:02.000Z", content: "4." }
    ]
  };
}

/** Run the real pipeline and assemble the eval-input bundle (the createSafetyReport input shape). */
function bundleFromTrace(trace) {
  const r = applyCompactionPolicy({ trace });
  return {
    originalTrace: trace,
    compactedMessages: r.compactedMessages,
    stateCapsules: r.stateCapsules,
    compactedMessageIds: r.compactedMessageIds,
    tokensSaved: r.tokensSaved,
    policyName: r.appliedPolicyName
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactedMessageWithMeta(bundle) {
  return bundle.compactedMessages.find((m) => m.metadata && m.metadata.compaction && m.metadata.compaction.rawSourcePointer);
}

function write(name, obj) {
  const filePath = path.join(here, name);
  writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
  process.stdout.write(`wrote ${name}\n`);
}

mkdirSync(here, { recursive: true });

// --- 01 valid exact recoverability (real pipeline; manual source -> fixture evidence) -----------
const valid = bundleFromTrace(buildBaseTrace("manual"));
if (valid.compactedMessageIds.length === 0) {
  throw new Error("Generator invariant broken: base trace produced no compaction.");
}
write("01-valid-exact-recoverability.json", {
  note: "Valid exact recoverability: real pipeline output, every compacted span pointer-resolvable + hash-matching. Expect recoverability=passed, evidence=fixture, real_captured=false.",
  expected_recoverability: "passed",
  expected_real_captured: false,
  ...valid
});

// --- 02 missing source pointer -------------------------------------------------------------------
{
  const f = clone(valid);
  const msg = compactedMessageWithMeta(f);
  delete msg.metadata.compaction.rawSourcePointer; // strip the pointer entirely
  write("02-missing-source-pointer.json", {
    note: "Missing source pointer: rawSourcePointer stripped from the compacted message metadata. Expect recoverability=failed (no pointer => no recoverable evidence).",
    expected_recoverability: "failed",
    expected_real_captured: false,
    ...f
  });
}

// --- 03 hash mismatch ----------------------------------------------------------------------------
{
  const f = clone(valid);
  const msg = compactedMessageWithMeta(f);
  // Corrupt the recorded content hash so it no longer matches the retained original payload.
  msg.metadata.compaction.rawSourcePointer.contentSha256 = "0".repeat(64);
  // Keep the capsule pointer consistent-but-wrong too, so the failure is unambiguous.
  if (f.stateCapsules[0]) f.stateCapsules[0].sourcePointer.contentSha256 = "0".repeat(64);
  write("03-hash-mismatch.json", {
    note: "Hash mismatch: recorded contentSha256 no longer matches the retained original payload. Expect recoverability=failed (integrity check fails).",
    expected_recoverability: "failed",
    expected_real_captured: false,
    ...f
  });
}

// --- 04 ambiguous source span (pointer does not unambiguously resolve) ---------------------------
{
  const f = clone(valid);
  const msg = compactedMessageWithMeta(f);
  // Point at a message id that does not exist at the recorded index AND does not exist anywhere,
  // so the pointer cannot be unambiguously resolved to the retained original.
  msg.metadata.compaction.rawSourcePointer.messageId = "m_does_not_exist";
  msg.metadata.compaction.rawSourcePointer.messageIndex = 99;
  if (f.stateCapsules[0]) {
    f.stateCapsules[0].sourcePointer.messageId = "m_does_not_exist";
    f.stateCapsules[0].sourcePointer.messageIndex = 99;
  }
  write("04-ambiguous-source-span.json", {
    note: "Ambiguous/unresolvable source span: pointer references a message id+index that does not resolve in the retained original. Expect recoverability=failed.",
    expected_recoverability: "failed",
    expected_real_captured: false,
    ...f
  });
}

// --- 05 removed content not recoverable (the retained original span is gone) ---------------------
{
  const f = clone(valid);
  const pointer = compactedMessageWithMeta(f).metadata.compaction.rawSourcePointer;
  // Delete the original source message from the retained trace: the removed content can no longer
  // be recovered from the retained original.
  f.originalTrace = clone(f.originalTrace);
  f.originalTrace.messages = f.originalTrace.messages.filter((m) => m.id !== pointer.messageId);
  write("05-removed-content-not-recoverable.json", {
    note: "Removed content not recoverable: the original source message was dropped from the retained trace, so the compacted span cannot be reconstructed. Expect recoverability=failed.",
    expected_recoverability: "failed",
    expected_real_captured: false,
    ...f
  });
}

// --- 06 unchanged / no-op trace (nothing compacted) ----------------------------------------------
{
  const noop = bundleFromTrace(buildNoOpTrace("manual"));
  if (noop.compactedMessageIds.length !== 0) {
    throw new Error("Generator invariant broken: no-op trace unexpectedly compacted something.");
  }
  write("06-noop-unchanged.json", {
    note: "No-op trace: nothing was compacted, so there is no recoverability evidence to check. Expect recoverability=not_computed (FAIL-CLOSED — never asserted as passed).",
    expected_recoverability: "not_computed",
    expected_real_captured: false,
    ...noop
  });
}

// --- 07 Codex imported/local evidence path (does NOT unlock real_captured) ------------------------
{
  // A Codex/local import normalizes to a local_command/cli_wrapper trace source -> imported_local
  // evidence -> eval evidence label "imported". Recoverability still passes (the pointers are real),
  // but real_captured MUST be false. This is the laundering guard: imported evidence is never a
  // real capture.
  const imported = bundleFromTrace(buildBaseTrace("local_command"));
  write("07-codex-imported-not-real-captured.json", {
    note: "Codex/local imported evidence: source=local_command -> evidence=imported. Recoverability passes, but real_captured MUST be false (imported evidence never counts as a real capture).",
    expected_recoverability: "passed",
    expected_real_captured: false,
    ...imported
  });
}

// --- 08 Claude Code real_captured path (true current label) --------------------------------------
{
  // The ONLY source value that unlocks the real_captured eval label is source==="real_captured",
  // which is exactly what the Claude Code capture path records for a genuinely captured session.
  // Using it here reflects the TRUE current label (no-source-no-claim): if the capture path did not
  // produce real_captured, this fixture would carry a weaker label instead.
  const captured = bundleFromTrace(buildBaseTrace("real_captured"));
  write("08-claude-code-real-captured.json", {
    note: "Claude Code real_captured path: source=real_captured (the true label the capture path records). Recoverability passes and real_captured=true. This is the ONLY fixture that may carry the real_captured label.",
    expected_recoverability: "passed",
    expected_real_captured: true,
    ...captured
  });
}

// Sanity: confirm the hash anchor used by fixture 01 matches the original payload (drift guard).
{
  const pointer = compactedMessageWithMeta(valid).metadata.compaction.rawSourcePointer;
  const original = valid.originalTrace.messages.find((m) => m.id === pointer.messageId);
  if (!original || contentHash(original.content) !== pointer.contentSha256) {
    throw new Error("Generator invariant broken: valid fixture hash does not match original payload.");
  }
}

process.stdout.write("All 8 eval fixtures generated.\n");
