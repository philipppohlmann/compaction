/**
 * Content-free renderer for the gateway capability matrix (public CLI/SDK code, engine-free): turns
 * `computeCapabilityMatrix()` into the honest table for `compaction gateway capabilities`. Owns no capability
 * logic, a pure function of the matrix rows, so it can never present a row as more capable than the matrix.
 *
 * Invariants (also test-enforced):
 *  - "cache proof: supported" prints only when `row.cacheProofSupported`, and is qualified live-unverified
 *    unless `row.liveVerified`, never presented as achieved/live-proven.
 *  - A false `cacheProofSupported` prints "not supported, <row's own reason>".
 *  - Labels are the row's own `labels`, never invented here.
 *  - No cost / billing / output-token / savings / semantic claim; nothing rendered as an ACHIEVED reduction.
 *  - Content-free: only display names, routing states, labels, and reason strings from the matrix.
 */
import {
  LIVE_UNVERIFIED_REASON,
  type GatewayRoutable,
  type WorkflowProviderCapability
} from "./capability-matrix.js";

/** Human-readable one-word routing state for a row's `gatewayRoutable` tri-state. */
function routingWord(routable: GatewayRoutable): string {
  if (routable === true) return "gateway-routable";
  if (routable === "if-configured") return "if-configured";
  return "not routable";
}

/**
 * The cache-proof line for one row. Supported rows are qualified live-unverified unless a real verification
 * has live-verified them; unsupported rows print the row's own reason.
 */
function cacheProofLine(row: WorkflowProviderCapability): string {
  if (row.cacheProofSupported) {
    // Supported ≠ live-proven: shown live-verified only when a real operator-run verification set it.
    if (row.liveVerified) {
      return "supported (live-verified - provider-reported cache observed in a recorded verification)";
    }
    return "supported (pipeline; live-unverified - run a real proof to verify)";
  }
  return `not supported - ${row.reasons.cacheProofSupported ?? "unavailable for this workflow"}`;
}

/**
 * The plan-auth line for one row (the default keyless state). A plan-auth-ready workflow reads as ready via
 * plan auth, with cache proof / live verification as optional add-ons - never as unavailable/key-required.
 */
function planAuthLine(row: WorkflowProviderCapability): string {
  if (row.planAuthReady) {
    return "ready (default) - run this workflow normally with your existing CLI auth; content-free usage recorded (no API key).";
  }
  return "n/a - Advanced gateway-routable path (no shim/hook to install).";
}

/** User-facing header/subhead copy for the capabilities table. */
export const CAPABILITIES_HEADER = "compaction gateway capabilities";
export const CAPABILITIES_SUBHEAD =
  "What is actually supported for each workflow - plan-auth is the default (keyless); provider cache proof and live verification are OPTIONAL add-ons. Rendered from the capability matrix (content-free).";
/** Plan-auth-first framing: a workflow is ready via plan auth even when cache proof / live verification is undone. */
export const CAPABILITIES_PLAN_AUTH_NOTE =
  "Plan-auth (default): detected CLI workflows record content-free usage with your existing auth - no API key requested or stored. Provider cache proof and live verification are optional (Advanced); a workflow is not unavailable when they are not done.";
export const CAPABILITIES_LIVE_NOTE = `Note: supported ≠ live-verified. No workflow is live-verified yet - ${LIVE_UNVERIFIED_REASON}`;

/** The live note reflecting actual state: which rows are live-verified from real evidence (none → default note). */
export function liveNoteFor(matrix: WorkflowProviderCapability[]): string {
  const verified = matrix.filter((r) => r.liveVerified);
  if (verified.length === 0) return CAPABILITIES_LIVE_NOTE;
  const names = verified.map((r) => r.workflowDisplayName).join(", ");
  return `Note: supported ≠ live-verified. Live-verified from real provider-reported cache receipts: ${names}.`;
}

/** Render one matrix row as honest, content-free lines (no colour; the CLI adds colour). Pure. */
export function formatCapabilityRow(row: WorkflowProviderCapability): string[] {
  const title = row.providerDisplayName
    ? `${row.workflowDisplayName}  →  ${row.providerDisplayName}`
    : row.workflowDisplayName;
  const lines = [title];
  lines.push(`  plan auth:    ${planAuthLine(row)}`);
  lines.push(`  routing:      ${routingWord(row.gatewayRoutable)}`);
  lines.push(`  cache proof:  ${cacheProofLine(row)} [optional add-on]`);
  lines.push(`  labels:       ${row.labels.join(", ")}`);
  lines.push(`  note:         ${row.routingNote}`);
  return lines;
}

/**
 * Render the whole matrix as an honest, content-free block. Pure - no IO, no colour, no capability logic:
 * every line is derived from the supplied matrix rows.
 */
export function formatCapabilityMatrix(matrix: WorkflowProviderCapability[]): string {
  const out: string[] = [
    CAPABILITIES_HEADER,
    CAPABILITIES_SUBHEAD,
    "",
    CAPABILITIES_PLAN_AUTH_NOTE,
    "",
    liveNoteFor(matrix),
    ""
  ];
  for (const row of matrix) {
    out.push(...formatCapabilityRow(row));
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}
