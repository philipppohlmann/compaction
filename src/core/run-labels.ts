/**
 * Local-only run labels (Strong-MVP Track E, task 3).
 *
 * A tiny, OPTIONAL, file-based tag a developer can attach to a recorded run so the
 * multi-session aggregate can group / filter / attribute it. These labels are written
 * to `.compaction/runs/<run>/run-labels.json`, they are LOCAL ONLY and are NEVER
 * uploaded. They carry no trace content: only short operator-supplied strings
 * (project / workflow / provider-runtime / a free-form user label / an explicit
 * session id).
 *
 * Honesty: a label is metadata the operator typed. It does NOT change any token, cost,
 * savings, or verification figure, and it carries no evidence weight, it is purely an
 * organizing tag for the local rollup. Provider/runtime supplied as a LABEL is operator-
 * asserted, never provider-verified, and is kept distinct from the token-source evidence
 * label (provider-reported vs local-estimate) that the token accounting carries.
 */

/** Marker used wherever a label was not supplied rather than guessed. */
export const NO_LABEL = "unlabeled" as const;

/** Schema version for the run-labels file (additive changes bump the minor). */
export const RUN_LABELS_VERSION = "1.0.0";

/** The exact, bounded set of label fields. No free-form map, only these keys exist. */
export interface RunLabels {
  /** Local-only optional label fields. Absent ≡ unlabeled; never inferred. */
  project?: string;
  workflow?: string;
  /** Operator-ASSERTED provider/runtime (NOT provider-verified). */
  provider?: string;
  /** Free-form local user label. */
  user_label?: string;
  /**
   * Session id used to group multiple runs into one session. When absent, the run is
   * grouped into its own single-run session keyed by run id (every run is at least its
   * own session). Never inferred from content.
   */
  session?: string;
}

/** The on-disk run-labels artifact (local file only). */
export interface RunLabelsFile extends RunLabels {
  labels_version: string;
  written_at: string;
  /** Constant honesty note persisted into the file. */
  note: string;
}

export const RUN_LABELS_NOTE =
  "Local-only organizing labels. Operator-supplied strings; NEVER uploaded; carry no trace content " +
  "and no evidence weight. provider here is operator-ASSERTED, not provider-verified.";

const MAX_LABEL_LENGTH = 200;

/** Trim, drop empties, and cap length. Returns undefined when the value is not a usable label. */
function normalizeLabel(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, MAX_LABEL_LENGTH);
}

/** Normalize a supplied label set to the bounded, trimmed shape (drops empty/invalid fields). */
export function normalizeRunLabels(labels: RunLabels): RunLabels {
  const out: RunLabels = {};
  const project = normalizeLabel(labels.project);
  const workflow = normalizeLabel(labels.workflow);
  const provider = normalizeLabel(labels.provider);
  const userLabel = normalizeLabel(labels.user_label);
  const session = normalizeLabel(labels.session);
  if (project !== undefined) out.project = project;
  if (workflow !== undefined) out.workflow = workflow;
  if (provider !== undefined) out.provider = provider;
  if (userLabel !== undefined) out.user_label = userLabel;
  if (session !== undefined) out.session = session;
  return out;
}

/** True when at least one label field is present after normalization. */
export function hasAnyLabel(labels: RunLabels): boolean {
  return Object.keys(normalizeRunLabels(labels)).length > 0;
}

/** Build the on-disk artifact from a supplied (already-normalizable) label set. */
export function buildRunLabelsFile(labels: RunLabels, writtenAt = new Date().toISOString()): RunLabelsFile {
  return {
    labels_version: RUN_LABELS_VERSION,
    written_at: writtenAt,
    note: RUN_LABELS_NOTE,
    ...normalizeRunLabels(labels)
  };
}

/** Parse a value read from a run-labels.json into the bounded label set (tolerant; drops junk). */
export function parseRunLabels(value: unknown): RunLabels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const pick = (key: string): string | undefined =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;
  return normalizeRunLabels({
    project: pick("project"),
    workflow: pick("workflow"),
    provider: pick("provider"),
    user_label: pick("user_label"),
    session: pick("session")
  });
}
