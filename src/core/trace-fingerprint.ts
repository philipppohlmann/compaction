import { contentHash } from "./content-hash.js";
import type { AgentTrace, TraceMessage } from "./types.js";

/**
 * Per-run trace distinctness fingerprint.
 *
 * PURPOSE (evidence integrity): give each captured run a verifiable, non-sensitive
 * distinctness signal so that genuinely-different sessions are distinguishable from
 * re-captures of the SAME session. Repeated imports of one session must not be counted
 * as independent evidence merely because capture time or file location changed.
 *
 * PRIVACY (load-bearing): the emitted value is a one-way SHA-256 DIGEST ONLY. Raw
 * message content, prompts, completions, tool output, file contents, and secrets are
 * fed INTO the hash (one-way) and are NEVER emitted. `computeTraceFingerprint`
 * returns only the hex digest + non-sensitive structural counts; it returns no
 * message text. Asserting non-content is also covered by a dedicated test
 * (`tests/core/trace-fingerprint.test.ts`).
 *
 * WHAT IS HASHED (the canonical normalized trace content): the ordered message
 * stream as `role | toolName | content`, joined with control-character separators,
 * prefixed with the model. Capture-time-varying fields (capturedAt / generatedAt
 * timestamps, absolute source path, the fingerprint field itself, durationMs) are
 * deliberately EXCLUDED so the same session captured twice yields the SAME
 * fingerprint, while a genuinely different session yields a different one.
 *
 * HONESTY: this is a distinctness signal, NOT a "byte-identical sessions" claim and
 * NOT a semantic/billing/commitment claim. If only aggregate metrics match but no
 * fingerprint is available, distinctness is reported as `not_verified`, never
 * inflated into a distinct count. See `classifyDistinctness`.
 */

/**
 * Field/record separators inside the canonical content string. ASCII control
 * characters (Unit Separator U+001F / Record Separator U+001E) are used so message
 * text cannot accidentally forge a record boundary (collision-resistance of the
 * canonicalization). Built via String.fromCharCode so no raw control chars sit in source.
 */
const FIELD_SEP = String.fromCharCode(0x1f);
const RECORD_SEP = String.fromCharCode(0x1e);

/**
 * Build the canonical content string that the fingerprint digests.
 *
 * INTERNAL ONLY, this string contains raw message content and MUST NOT be emitted
 * anywhere. It exists solely as input to the one-way hash. Callers receive only the
 * resulting digest from `computeTraceFingerprint`.
 */
function canonicalContent(trace: AgentTrace): string {
  const head = `model${FIELD_SEP}${trace.model}`;
  const body = trace.messages
    .map((m: TraceMessage) => [m.role, m.toolName ?? "", m.content].join(FIELD_SEP))
    .join(RECORD_SEP);
  return head + RECORD_SEP + body;
}

/** Algorithm identifier surfaced alongside the digest so the signal is self-describing. */
export const TRACE_FINGERPRINT_ALGORITHM = "sha256-canonical-content-v1";

/**
 * A non-sensitive per-run distinctness fingerprint for a captured trace.
 *
 * Every field here is non-sensitive: a hex digest plus structural counts. There is
 * NO message/prompt/tool-output text in this object.
 */
export interface TraceFingerprint {
  /** Algorithm + canonicalization version (so the digest is interpretable later). */
  algorithm: string;
  /**
   * Hex SHA-256 digest over the canonical normalized trace content. One-way digest
   * ONLY - never raw content. Same session → same value; different session → different.
   */
  content_sha256: string;
  /** Non-sensitive structural count: number of messages hashed. */
  message_count: number;
}

/**
 * Compute the per-run distinctness fingerprint for a captured trace.
 *
 * Returns a digest-only object. The raw `canonicalContent` is consumed by the hash
 * and discarded; it is never returned or stored. This is the smallest safe
 * distinctness signal: it distinguishes a genuinely different session from a
 * re-capture of the same session without exposing any session content.
 */
export function computeTraceFingerprint(trace: AgentTrace): TraceFingerprint {
  return {
    algorithm: TRACE_FINGERPRINT_ALGORITHM,
    content_sha256: contentHash(canonicalContent(trace)),
    message_count: trace.messages.length
  };
}

//  Distinctness classification (de-dup / not_verified, never inflate N)

/**
 * Minimal per-run record the distinctness classifier needs. Carries ONLY a
 * non-sensitive fingerprint digest (optional) - no content, no aggregate metrics
 * masquerading as proof. A record whose fingerprint is absent/unverifiable is
 * counted as `not_verified`, NEVER as distinct.
 */
export interface DistinctnessRecord {
  /** Stable per-run identifier for reporting (e.g. session id or run dir). Non-sensitive. */
  runId: string;
  /**
   * The verifiable distinctness digest, when available. When undefined/empty, the
   * run's distinctness is NOT verified and it does not contribute to the distinct
   * count.
   */
  content_sha256?: string | null;
}

export interface DistinctnessResult {
  /**
   * Number of DISTINCT verified sessions: the count of unique non-empty
   * `content_sha256` values. Re-captures (same digest) collapse to one.
   */
  distinct_verified_count: number;
  /** The unique verified fingerprints (sorted), for citation. */
  distinct_fingerprints: string[];
  /**
   * Run ids whose distinctness could NOT be verified (missing/empty fingerprint).
   * These are reported as `not_verified` and are NOT added to the distinct count.
   */
  not_verified_run_ids: string[];
  /**
   * Total runs considered (verified-distinct contributions + duplicates +
   * not_verified). Provided so a report can never silently drop runs.
   */
  total_runs: number;
}

/**
 * Classify a set of per-run records into a de-duplicated distinct count plus an
 * explicit `not_verified` bucket.
 *
 * Rules (the anti-overcount contract):
 * - same fingerprint  → counted once (de-dup).
 * - different fingerprint → counted as distinct.
 * - missing/empty fingerprint → `not_verified`; does NOT inflate the distinct count.
 *
 * Aggregate metrics are intentionally NOT an input here: matching aggregates alone
 * never makes two runs "the same", and unverifiable distinctness is never upgraded
 * to distinct. The fingerprint is the only signal that moves a run into the
 * verified-distinct set.
 */
export function classifyDistinctness(records: readonly DistinctnessRecord[]): DistinctnessResult {
  const verified = new Set<string>();
  const notVerified: string[] = [];

  for (const r of records) {
    const fp = r.content_sha256;
    if (typeof fp === "string" && fp.length > 0) {
      verified.add(fp);
    } else {
      notVerified.push(r.runId);
    }
  }

  return {
    distinct_verified_count: verified.size,
    distinct_fingerprints: [...verified].sort(),
    not_verified_run_ids: notVerified,
    total_runs: records.length
  };
}
