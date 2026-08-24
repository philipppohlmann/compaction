/**
 * Privacy-safe feedback bundle for the beta learning loop.
 *
 * This module BUILDS a redacted feedback bundle that a beta tester may OPTIONALLY
 * send to the maintainers. It does NOT write files and does NOT touch the network -
 * the CLI command (src/cli/commands/feedback.ts) owns the local write and the
 * explicit-confirm gate. Keeping the builders pure makes the privacy guarantees
 * unit-testable.
 *
 * PRIVACY MODEL, exclude-by-default (whitelist construction):
 *   The bundle is ASSEMBLED FIELD-BY-FIELD from a small allowed set of non-sensitive,
 *   aggregate signals. Forbidden categories (raw trace messages, prompts, completions,
 *   tool outputs, source code, file contents, environment variables,
 *   credentials/tokens, customer data) are NEVER collected in the first place, they
 *   have no field to land in. The redaction pass below is defense-in-depth for the one
 *   free-text channel we do include (error/log diagnostics), NOT the primary control.
 *
 * REDACTION IS BEST-EFFORT, NOT PERFECT. It is a conservative shape matcher, not a DLP
 * classifier. The tester chooses whether to send the bundle and can inspect it first.
 *
 * EVIDENCE HONESTY: every figure carries the weakest label the evidence supports.
 *   workflow_confirmed is NOT billing_confirmed. There is no billing-confirmed savings
 *   claim, no semantic/commitment-preservation claim, and no output-token-reduction
 *   claim anywhere in this bundle.
 */

import { redactSecrets } from "./provider-usage/credential-redaction.js";

/** Bundle schema version (additive changes bump the minor; field removals bump major). */
export const FEEDBACK_BUNDLE_VERSION = "1.0.0";

/** Marker used wherever a value is not available rather than guessed. */
export const UNKNOWN = "unknown" as const;

export type TriState = "yes" | "no" | "unknown";
export type WorkflowOutcome = "succeeded" | "failed" | "partial" | "unknown";

/**
 * Evidence ladder for this bundle, ordered weakest-to-strongest. The bundle labels
 * each run at the WEAKEST rung the supplied evidence supports. Critically,
 * `workflow_confirmed` is its OWN rung and is NOT `billing_confirmed`, observing that
 * a workflow succeeded does not confirm a billed cost delta. `billing_confirmed` is
 * only ever reachable with real billing/invoice/export evidence (none is collected by
 * this command), so the bundle never emits it.
 */
export const EVIDENCE_LADDER = [
  "measured_input_token_reduction",
  "output_token_delta_observed",
  "recoverability_verified",
  "applied_context",
  "workflow_confirmed",
  "usage_confirmed",
  "billing_confirmed"
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LADDER)[number] | "unknown";

/** The exact non-sensitive categories the bundle INCLUDES (for the preview + README). */
export const INCLUDED_FIELDS: readonly string[] = [
  "CLI version, OS, node version, package version",
  "command path used (which compaction command produced the run)",
  "evidence level (weakest-supported label)",
  "aggregate original/compacted INPUT tokens",
  "output-token delta WHERE OBSERVABLE (else unknown)",
  "estimated cost delta (labeled estimated - never billing-confirmed)",
  "recoverability status",
  "applied_context (yes/no)",
  "workflow_outcome (succeeded/failed/partial/unknown)",
  "missing_context (yes/no/unknown)",
  "provider/model IF supplied",
  "usage metadata IF supplied (allowlisted non-sensitive fields only: numeric token counts + model/provider)",
  "install method",
  "REDACTED errors/logs (best-effort)"
];

/** The categories the bundle EXCLUDES BY DEFAULT, these must NEVER appear. */
export const EXCLUDED_CATEGORIES: readonly string[] = [
  "raw trace messages",
  "prompts",
  "completions",
  "tool outputs",
  "source code",
  "file contents",
  "environment variables",
  "credentials / tokens",
  "customer data"
];

export const BEST_EFFORT_REDACTION_NOTE =
  "Redaction is BEST-EFFORT, not perfect: it is a conservative shape matcher, not a guaranteed scrubber. " +
  "Inspect this bundle before you choose to send it.";

/**
 * ALLOWLIST of non-sensitive usage-metadata keys.
 *
 * Provider usage exports can carry request/response bodies, user IDs, emails, and
 * prompt fragments alongside token counts. So usage metadata is NOT copied verbatim:
 * we KEEP ONLY these known non-sensitive keys (numeric token counts + the model /
 * provider identifiers) and DROP every other key, allowlist, not blocklist. An
 * unrecognized key is always dropped, never copied. This is applied identically to
 * the written bundle and to the preview.
 */
export const USAGE_METADATA_ALLOWLIST: readonly string[] = [
  "input_tokens",
  "prompt_tokens",
  "output_tokens",
  "completion_tokens",
  "total_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "cached_tokens",
  "model",
  "provider"
];

const USAGE_METADATA_ALLOWED_SET: ReadonlySet<string> = new Set(USAGE_METADATA_ALLOWLIST);
/** These allowlisted keys carry string identifiers; all other allowlisted keys are numeric. */
const USAGE_METADATA_STRING_KEYS: ReadonlySet<string> = new Set(["model", "provider"]);

export const USAGE_METADATA_ALLOWLIST_NOTE =
  "usage metadata IF supplied (ALLOWLISTED non-sensitive fields only: numeric token counts + model/provider; " +
  "all unrecognized keys are DROPPED, best-effort)";

/** Result of allowlist-filtering supplied usage metadata: kept fields + count of dropped keys. */
export interface FilteredUsageMetadata {
  kept: Record<string, unknown>;
  dropped_key_count: number;
}

/**
 * Apply the usage-metadata allowlist. Keeps ONLY recognized non-sensitive keys, and
 * only when their value is the expected primitive type (numeric token counts; string
 * model/provider). Every other key, including unknown keys and allowlisted keys with
 * an unexpected (e.g. object/array) value, is DROPPED. Never records dropped VALUES,
 * only a count. Returns `undefined` if nothing survives, so absent ≡ unknown.
 */
export function filterUsageMetadata(
  raw: Record<string, unknown> | undefined
): FilteredUsageMetadata | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const kept: Record<string, unknown> = {};
  let droppedKeyCount = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!USAGE_METADATA_ALLOWED_SET.has(key)) {
      droppedKeyCount += 1;
      continue;
    }
    if (USAGE_METADATA_STRING_KEYS.has(key)) {
      if (typeof value === "string" && value.length > 0) {
        kept[key] = value;
      } else {
        droppedKeyCount += 1;
      }
      continue;
    }
    // Token-count keys: keep only finite numbers (drop strings/objects/NaN/etc.).
    if (typeof value === "number" && Number.isFinite(value)) {
      kept[key] = value;
    } else {
      droppedKeyCount += 1;
    }
  }
  if (Object.keys(kept).length === 0 && droppedKeyCount === 0) return undefined;
  return { kept, dropped_key_count: droppedKeyCount };
}

export const NO_UPLOAD_NOTE =
  "This command writes a LOCAL bundle only. It performs NO network call, NO upload, and NO telemetry. " +
  "Whether to send this bundle is entirely your choice.";

/** Aggregate token figures collected from local run reports (input tokens only by default). */
export interface AggregateRunSignals {
  run_count: number;
  total_original_input_tokens: number;
  total_compacted_input_tokens: number;
  total_input_tokens_saved: number;
  /** Output-token delta only where the source actually carried output tokens; else unknown. */
  output_token_delta: number | typeof UNKNOWN;
  /** Estimated cost delta in USD, labeled estimated, NEVER billing-confirmed; unknown if unestimated. */
  estimated_cost_delta_usd: number | typeof UNKNOWN;
}

export interface EnvironmentSignals {
  cli_version: string;
  os: string;
  node_version: string;
  package_version: string;
  install_method: string;
}

/** Optional, operator-SUPPLIED signals. Absent → recorded as unknown, never inferred. */
export interface SuppliedSignals {
  command_path?: string;
  evidence_level?: EvidenceLevel;
  recoverability_status?: string;
  applied_context?: TriState;
  workflow_outcome?: WorkflowOutcome;
  missing_context?: TriState;
  provider?: string;
  model?: string;
  /** Free-form usage metadata (e.g. provider-reported token counts) the tester supplies. */
  usage_metadata?: Record<string, unknown>;
  /** Raw error/log text to be REDACTED (best-effort) before inclusion. */
  diagnostic_text?: string;
}

export interface FeedbackBundleInput {
  environment: EnvironmentSignals;
  aggregate: AggregateRunSignals;
  supplied?: SuppliedSignals;
}

export interface FeedbackBundle {
  bundle_version: string;
  generated_at: string;
  privacy: {
    includes: readonly string[];
    excludes_by_default: readonly string[];
    redaction: string;
    upload: string;
  };
  environment: EnvironmentSignals;
  command_path: string | typeof UNKNOWN;
  evidence_level: EvidenceLevel;
  tokens: {
    aggregate_original_input_tokens: number;
    aggregate_compacted_input_tokens: number;
    aggregate_input_tokens_saved: number;
    /** Output-token delta where observable; otherwise unknown. NOT a reduction claim. */
    output_token_delta: number | typeof UNKNOWN;
    note: string;
  };
  cost: {
    estimated_cost_delta_usd: number | typeof UNKNOWN;
    label: string;
  };
  recoverability_status: string | typeof UNKNOWN;
  applied_context: TriState;
  workflow_outcome: WorkflowOutcome;
  missing_context: TriState;
  provider: string | typeof UNKNOWN;
  model: string | typeof UNKNOWN;
  /** Allowlist-filtered usage metadata (numeric token counts + model/provider only), or unknown. */
  usage_metadata: Record<string, unknown> | typeof UNKNOWN;
  /** Count of usage-metadata keys DROPPED by the allowlist (values never recorded). */
  usage_metadata_dropped_key_count: number;
  /** Best-effort REDACTED diagnostics. Free-text channel; redaction defense-in-depth applies. */
  redacted_diagnostics: string | typeof UNKNOWN;
  run_count: number;
}

const COST_LABEL =
  "estimated (token-estimated cost / local estimate) - NOT billing-confirmed, NOT realized savings";

const OUTPUT_TOKEN_NOTE =
  "Input-token figures are measured aggregates. Output-token delta is shown only where the " +
  "source carried output tokens (else unknown); this bundle makes NO output-token-reduction claim.";

/**
 * Best-effort redaction for the ONE free-text channel (error/log diagnostics).
 *
 * Two-stage, FAIL-CLOSED design, because shape redaction alone cannot catch
 * arbitrary natural-language content (a leaked prompt/completion/customer record is
 * just prose). So:
 *
 *   Stage 1 (shape redaction): mask credential shapes (shared backstop), env-var
 *     assignments, absolute-ish file paths, emails, and long quoted strings.
 *   Stage 2 (line allowlist, fail-closed): KEEP only lines that match recognizable
 *     diagnostic STRUCTURE, a stack frame (`at fn (file:line:col)`), an error/exception
 *     header (`TypeError: ...`), a Node error code (`Error [ERR_...]`, `code: 'E...'`),
 *     a leading compiler/HTTP code, or a line that is itself only redaction markers.
 *     A line is NOT kept merely because it contains a word like "trace" or "stack":
 *     `trace: <raw prompt>` has no diagnostic structure and is DROPPED, replaced by a
 *     `[dropped: non-error-shaped line]` marker. Arbitrary prose (prompts, completions,
 *     customer data) is therefore absent by construction, not by hoping a regex caught it.
 *
 * Still explicitly BEST-EFFORT: a secret embedded inside an error-shaped line in a
 * shape we do not recognize could survive. The exclude-by-default model and the
 * tester's own review are the real guarantees; this is defense in depth.
 */
function redactLineShapes(line: string): string {
  let out = redactSecrets(line);
  // export KEY=... shell forms (before bare KEY=VALUE so the keyword is kept).
  out = out.replace(/\b(export\s+[A-Z][A-Z0-9_]{2,})\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/gi, "$1=***REDACTED***");
  // KEY=VALUE env-var-style assignments (mask the value; keep the key name).
  out = out.replace(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/g, "$1=***REDACTED***");
  // Absolute-ish filesystem paths (POSIX + Windows), may reveal usernames/dirs.
  out = out.replace(/(?:\/[\w.\-]+){2,}\/?/g, "***REDACTED_PATH***");
  out = out.replace(/[A-Za-z]:\\(?:[\w.\- ]+\\?)+/g, "***REDACTED_PATH***");
  // Email addresses.
  out = out.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "***REDACTED_EMAIL***");
  // Long quoted strings, likely prompt/completion/content fragments, not error shape.
  out = out.replace(/"[^"]{40,}"/g, '"***REDACTED_CONTENT***"');
  out = out.replace(/'[^']{40,}'/g, "'***REDACTED_CONTENT***'");
  return out;
}

/**
 * Does a (already shape-redacted) line look like a REAL error/diagnostic, vs arbitrary
 * prose? Fail-closed: a line is kept ONLY if it matches recognizable diagnostic
 * STRUCTURE, never merely because it contains a word like "trace" or "stack". A bare
 * `trace: <raw prompt>` line carries no stack-frame / error-header structure and is
 * therefore DROPPED, its content (a prompt, completion, or customer record) would
 * otherwise survive.
 */
function isErrorShapedLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true; // blank lines are harmless
  // Stack frames: "at fn (file:line:col)" / "at file:line:col".
  if (/^\s*at\s+.+\(.+:\d+:\d+\)\s*$/.test(line)) return true;
  if (/^\s*at\s+.+:\d+:\d+\)?\s*$/.test(line)) return true;
  // Node-style "at async fn ..." frames are covered by the two patterns above.
  // Error/exception HEADER: "TypeError: ...", "Error: ...", "SomethingException: ...".
  if (/^\s*[\w.$]*(?:Error|Exception|Warning):\s/.test(line)) return true;
  // Node error codes: "Error [ERR_FOO]" or a `code: 'ERR_FOO'` / `errno: -2` line.
  if (/\b(?:Error|Exception)\s*\[(?:ERR_[A-Z0-9_]+|E[A-Z]{2,})\]/.test(line)) return true;
  if (/^\s*(?:code|errno):\s*['"]?(?:E[A-Z]{2,}|ERR_[A-Z0-9_]+|-?\d+)['"]?\s*$/.test(line)) return true;
  // Bare Node error codes on their own / leading the line (ENOENT, EACCES, ECONNRESET).
  if (/^\s*(?:E[A-Z]{2,}|ERR_[A-Z0-9_]+)\b/.test(line)) return true;
  // Compiler/HTTP diagnostic codes leading the line: "TS2345: ...", "error TS2345", "HTTP 500".
  if (/^\s*(?:error\s+)?[A-Z]{2}\d{3,5}\b/.test(line)) return true;
  if (/^\s*(?:HTTP\s+|status\s+)[1-5]\d{2}\b/i.test(line)) return true;
  // Lines that are now ENTIRELY redaction markers (plus tiny glue) are safe to keep.
  if (/\*\*\*REDACTED/.test(line) && trimmed.replace(/\*\*\*REDACTED[A-Z_]*\*\*\*/g, "").trim().length < 20) {
    return true;
  }
  return false;
}

export function redactDiagnostic(text: string): string {
  if (text.length === 0) return text;
  const lines = text.split(/\r?\n/);
  const kept: string[] = lines.map((line) => {
    const shaped = redactLineShapes(line);
    return isErrorShapedLine(shaped) ? shaped : "[dropped: non-error-shaped line]";
  });
  return kept.join("\n");
}

function triOrUnknown(value: TriState | undefined): TriState {
  return value ?? "unknown";
}

/**
 * Assemble the bundle from the allowed signal set. Whitelist construction: there is no
 * code path here that copies raw messages, prompts, completions, tool outputs, source,
 * file contents, env vars, credentials, or customer data into the result.
 */
export function buildFeedbackBundle(input: FeedbackBundleInput, generatedAt = new Date().toISOString()): FeedbackBundle {
  const supplied = input.supplied ?? {};

  const redactedDiagnostics =
    typeof supplied.diagnostic_text === "string" && supplied.diagnostic_text.length > 0
      ? redactDiagnostic(supplied.diagnostic_text)
      : UNKNOWN;

  // Usage metadata is NEVER copied verbatim: apply the allowlist, keep only recognized
  // non-sensitive fields, drop everything else (and only record a dropped-key COUNT).
  const filteredUsage = filterUsageMetadata(supplied.usage_metadata);
  const usageMetadata =
    filteredUsage && Object.keys(filteredUsage.kept).length > 0 ? filteredUsage.kept : UNKNOWN;
  const usageMetadataDroppedKeyCount = filteredUsage ? filteredUsage.dropped_key_count : 0;

  return {
    bundle_version: FEEDBACK_BUNDLE_VERSION,
    generated_at: generatedAt,
    privacy: {
      includes: INCLUDED_FIELDS,
      excludes_by_default: EXCLUDED_CATEGORIES,
      redaction: BEST_EFFORT_REDACTION_NOTE,
      upload: NO_UPLOAD_NOTE
    },
    environment: input.environment,
    command_path: supplied.command_path ?? UNKNOWN,
    evidence_level: supplied.evidence_level ?? UNKNOWN,
    tokens: {
      aggregate_original_input_tokens: input.aggregate.total_original_input_tokens,
      aggregate_compacted_input_tokens: input.aggregate.total_compacted_input_tokens,
      aggregate_input_tokens_saved: input.aggregate.total_input_tokens_saved,
      output_token_delta: input.aggregate.output_token_delta,
      note: OUTPUT_TOKEN_NOTE
    },
    cost: {
      estimated_cost_delta_usd: input.aggregate.estimated_cost_delta_usd,
      label: COST_LABEL
    },
    recoverability_status: supplied.recoverability_status ?? UNKNOWN,
    applied_context: triOrUnknown(supplied.applied_context),
    workflow_outcome: supplied.workflow_outcome ?? "unknown",
    missing_context: triOrUnknown(supplied.missing_context),
    provider: supplied.provider ?? UNKNOWN,
    model: supplied.model ?? UNKNOWN,
    usage_metadata: usageMetadata,
    usage_metadata_dropped_key_count: usageMetadataDroppedKeyCount,
    redacted_diagnostics: redactedDiagnostics,
    run_count: input.aggregate.run_count
  };
}

/** Human-readable preview: EXACTLY what will be written, field-by-field. */
export function formatBundlePreview(bundle: FeedbackBundle): string {
  const lines: string[] = [];
  lines.push("Feedback bundle preview - EXACTLY these fields will be written (local file only):");
  lines.push("");
  lines.push(`  bundle_version:            ${bundle.bundle_version}`);
  lines.push(`  generated_at:              ${bundle.generated_at}`);
  lines.push(`  run_count:                 ${bundle.run_count}`);
  lines.push("");
  lines.push("  environment:");
  lines.push(`    cli_version:             ${bundle.environment.cli_version}`);
  lines.push(`    os:                      ${bundle.environment.os}`);
  lines.push(`    node_version:            ${bundle.environment.node_version}`);
  lines.push(`    package_version:         ${bundle.environment.package_version}`);
  lines.push(`    install_method:          ${bundle.environment.install_method}`);
  lines.push("");
  lines.push(`  command_path:              ${String(bundle.command_path)}`);
  lines.push(`  evidence_level:            ${bundle.evidence_level}`);
  lines.push("");
  lines.push("  tokens (aggregate, INPUT measured):");
  lines.push(`    original_input_tokens:   ${bundle.tokens.aggregate_original_input_tokens}`);
  lines.push(`    compacted_input_tokens:  ${bundle.tokens.aggregate_compacted_input_tokens}`);
  lines.push(`    input_tokens_saved:      ${bundle.tokens.aggregate_input_tokens_saved}`);
  lines.push(`    output_token_delta:      ${String(bundle.tokens.output_token_delta)} (where observable; else unknown)`);
  lines.push("");
  lines.push(`  estimated_cost_delta_usd:  ${String(bundle.cost.estimated_cost_delta_usd)}`);
  lines.push(`    cost label:              ${bundle.cost.label}`);
  lines.push("");
  lines.push(`  recoverability_status:     ${String(bundle.recoverability_status)}`);
  lines.push(`  applied_context:           ${bundle.applied_context}`);
  lines.push(`  workflow_outcome:          ${bundle.workflow_outcome}`);
  lines.push(`  missing_context:           ${bundle.missing_context}`);
  lines.push(`  provider:                  ${String(bundle.provider)}`);
  lines.push(`  model:                     ${String(bundle.model)}`);
  lines.push(`  usage_metadata:            ${bundle.usage_metadata === UNKNOWN ? UNKNOWN : JSON.stringify(bundle.usage_metadata)}`);
  lines.push(`    (allowlisted fields only; ${bundle.usage_metadata_dropped_key_count} unrecognized key(s) dropped)`);
  lines.push(`  redacted_diagnostics:      ${bundle.redacted_diagnostics === UNKNOWN ? UNKNOWN : "(best-effort redacted text - see bundle)"}`);
  lines.push("");
  lines.push("EXCLUDED BY DEFAULT (never collected, never written):");
  for (const category of EXCLUDED_CATEGORIES) {
    lines.push(`  - ${category}`);
  }
  lines.push("");
  lines.push(BEST_EFFORT_REDACTION_NOTE);
  lines.push(NO_UPLOAD_NOTE);
  return lines.join("\n");
}

/** README written INSIDE the bundle directory. */
export function renderBundleReadme(bundle: FeedbackBundle): string {
  const lines: string[] = [];
  lines.push("# compaction feedback bundle");
  lines.push("");
  lines.push(`Generated: ${bundle.generated_at}`);
  lines.push(`Bundle version: ${bundle.bundle_version}`);
  lines.push("");
  lines.push("## What this is");
  lines.push("");
  lines.push(
    "A privacy-safe feedback bundle for the compaction beta learning loop. It contains a small set of"
  );
  lines.push(
    "NON-SENSITIVE, aggregate signals about a compaction run so the maintainers can learn whether the"
  );
  lines.push("tool helped - WITHOUT seeing your traces, prompts, code, or data.");
  lines.push("");
  lines.push("## What it INCLUDES (by default - non-sensitive only)");
  lines.push("");
  for (const field of INCLUDED_FIELDS) {
    lines.push(`- ${field}`);
  }
  lines.push("");
  lines.push("## What it EXCLUDES by default (never collected, never written)");
  lines.push("");
  for (const category of EXCLUDED_CATEGORIES) {
    lines.push(`- ${category}`);
  }
  lines.push("");
  lines.push("## Usage metadata is allowlist-filtered (best-effort)");
  lines.push("");
  lines.push(
    "Provider usage exports can carry request/response bodies, user IDs, emails, or prompt fragments " +
      "alongside token counts. So supplied usage metadata is NOT copied verbatim: only an allowlist of " +
      "non-sensitive fields is kept (numeric token counts plus model/provider), and every unrecognized " +
      "key is DROPPED - allowlist, not blocklist. This is best-effort; inspect the kept fields below."
  );
  lines.push("");
  lines.push("Allowlisted usage-metadata keys (kept when present, with the expected value type):");
  for (const key of USAGE_METADATA_ALLOWLIST) {
    lines.push(`- \`${key}\``);
  }
  lines.push("");
  if (bundle.usage_metadata !== UNKNOWN || bundle.usage_metadata_dropped_key_count > 0) {
    lines.push(
      `${bundle.usage_metadata_dropped_key_count} unrecognized usage-metadata key(s) were dropped ` +
        "from this bundle (their values were never recorded)."
    );
    lines.push("");
  }
  lines.push("## Redaction is best-effort");
  lines.push("");
  lines.push(BEST_EFFORT_REDACTION_NOTE);
  lines.push("");
  lines.push("## You choose whether to send");
  lines.push("");
  lines.push(NO_UPLOAD_NOTE);
  lines.push("");
  lines.push("## Evidence honesty");
  lines.push("");
  lines.push(
    "Each figure carries the weakest label the evidence supports. The estimated cost delta is a " +
      "token-estimated / local estimate - it is NOT billing-confirmed and NOT realized savings."
  );
  lines.push(
    "`workflow_outcome: succeeded` means a workflow ran to completion; it is NOT a billing confirmation. " +
      "workflow_confirmed is NOT billing_confirmed."
  );
  lines.push(
    "This bundle makes no output-token-reduction claim and no semantic/commitment-preservation claim. " +
      "Output-token delta is shown only where observable, otherwise unknown."
  );
  lines.push("");
  lines.push("## Files");
  lines.push("");
  lines.push("- `feedback-bundle.json` - the bundle data (the fields listed above).");
  lines.push("- `README.md` - this file.");
  lines.push("");
  return lines.join("\n");
}
