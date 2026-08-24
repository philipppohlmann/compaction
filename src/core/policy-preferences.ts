/**
 * Local auto-apply preference store.
 *
 * Stores and reads the user's binary auto-apply preference ("apply automatically next time for
 * this workflow when safety gates pass?", default no). It is a preference record only, not an
 * application engine: this module applies nothing, it imports nothing that mutates a session,
 * trace, run record, or context, and exports no apply function; saving/enabling a preference
 * mutates only this store's JSON file (proven by `tests/core/policy-preferences.test.ts`). The
 * application path lives in the gateway's deterministic eligibility engine
 * (`src/core/gateway/apply-eligibility.ts`), which reads a stored ENABLED `auto-when-gates-pass`
 * preference and evaluates `gates_required` fail-closed on every request; a missing/disabled/
 * `ask-each-time` preference, or any gate that engine cannot evaluate, means nothing is ever
 * applied automatically.
 *
 * Scope is never global and never cross-tool: `tool` is required and "global"/"all"/"*" values are
 * rejected at validation; a preference is always scoped to one workflow/tool (+ repo where
 * detectable + policy type). No wall-clock: the record carries no `created_at`, the id is
 * deterministic over the scope (a content-free upsert key). Local file I/O only: one JSON file
 * under the gitignored `.compaction/`; no network.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Default local preference file (under the gitignored `.compaction/`). */
export const DEFAULT_POLICY_PREFERENCES_DIRECTORY = ".compaction";
export const POLICY_PREFERENCES_FILENAME = "policy-preferences.json";

/** The binary preference (mirror of `AUTO_APPLY_PREFERENCES` in activity-event.ts). Default = ask. */
export const POLICY_PREFERENCE_VALUES = ["ask-each-time", "auto-when-gates-pass"] as const;
export type PolicyPreferenceValue = (typeof POLICY_PREFERENCE_VALUES)[number];

/** Tool values that are NEVER an allowed scope, a preference is never global or cross-tool. */
export const REJECTED_GLOBAL_TOOL_VALUES: readonly string[] = ["global", "all", "*", "any", "cross-tool"];

/**
 * The safety gates a preference's auto-apply would require; populated for provenance/explanation.
 * The eligibility engine evaluates only the gates in `AUTO_APPLY_ELIGIBILITY_GATES`; a preference
 * whose `gates_required` names any gate outside that set can never drive an application
 * (fail-closed on unevaluable gates). This default deliberately contains unevaluable names, so a
 * preference saved without an explicit evaluable gate list stays stored-but-never-applied.
 */
export const DEFAULT_GATES_REQUIRED: readonly string[] = [
  "scope-match",
  "original-retained",
  "capsule-provenance",
  "recoverability-pass",
  "reduction-threshold",
  "risk-checks",
  "evidence-label-emitted",
  "rollback-path"
];

/**
 * The gates the deterministic apply-eligibility engine actually evaluates, ALL of them, on EVERY
 * request, none waivable (`src/core/gateway/apply-eligibility.ts` is the evaluator; this constant
 * lives here so the storage/explain layer and the engine share one source of truth without a
 * circular import). A stored authorization arms automatic deterministic apply ONLY when its
 * `gates_required` is exactly a subset of this set; any other gate name is not evaluable and the
 * preference stays stored-but-never-applied.
 */
export const AUTO_APPLY_ELIGIBILITY_GATES: readonly string[] = [
  "scope-match",
  "supported-shape",
  "deterministic-policy",
  "original-retainable",
  "change-produced"
];

/** True iff EVERY gate the preference requires is one the eligibility engine evaluates. */
export function gatesAreEngineEvaluable(gatesRequired: readonly string[]): boolean {
  return gatesRequired.length > 0 && gatesRequired.every((gate) => AUTO_APPLY_ELIGIBILITY_GATES.includes(gate));
}

/** The inferred safest scope of a preference: one tool/workflow, optionally one repo, one policy type. */
export interface PolicyPreferenceScope {
  /** REQUIRED. The workflow/tool this preference is scoped to (never "global"/"all"/cross-tool). */
  tool: string;
  /** OPTIONAL. The repo the preference is scoped to, when detectable (content-free identifier). */
  repo?: string;
  /** REQUIRED. Which policy type this preference concerns (content-free identifier). */
  policy_type: string;
}

/** One stored preference record. Content-free; no wall-clock; id is deterministic over the scope. */
export interface PolicyPreference {
  /** Deterministic content-free id: `pref-` + 24 hex of sha-256 over the canonical scope. */
  id: string;
  scope: PolicyPreferenceScope;
  preference: PolicyPreferenceValue;
  /** Whether this preference is live. `disable` sets this false; there is NO enable in the CLI. */
  enabled: boolean;
  /** Safety gates this preference's auto-apply requires. Populated here, evaluated by the engine. */
  gates_required: string[];
}

/** Input to save a preference, id, enabled default, and gates_required are derived when absent. */
export interface SavePolicyPreferenceInput {
  scope: PolicyPreferenceScope;
  preference: PolicyPreferenceValue;
  /** Defaults to true; `disable` turns it off. */
  enabled?: boolean;
  /** Defaults to `DEFAULT_GATES_REQUIRED`; a caller may pass a narrower list (never evaluated here). */
  gates_required?: string[];
}

export interface PolicyPreferenceValidation {
  problems: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The longest a content-free scope/gate identifier may be, anything longer looks like content. */
export const POLICY_PREFERENCE_MAX_STRING_LENGTH = 200;

/**
 * Validate a scope: `tool` and `policy_type` REQUIRED and content-free; `repo` optional; the tool
 * is NEVER a global/all/cross-tool value (case-insensitive). Report-only (never throws).
 */
export function validatePolicyPreferenceScope(scope: unknown): PolicyPreferenceValidation {
  const problems: string[] = [];
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    return { problems: ["scope: must be an object ({ tool, repo?, policy_type })"] };
  }
  const record = scope as Record<string, unknown>;
  if (!isNonEmptyString(record.tool)) {
    problems.push("scope.tool: required - a preference is always scoped to one workflow/tool (never global)");
  } else if (REJECTED_GLOBAL_TOOL_VALUES.includes(record.tool.trim().toLowerCase())) {
    problems.push(
      `scope.tool: "${record.tool}" is rejected - a preference is never global and never cross-tool; scope it to a single tool`
    );
  }
  if (!isNonEmptyString(record.policy_type)) {
    problems.push("scope.policy_type: required - which policy this preference concerns (content-free identifier)");
  }
  if (record.repo !== undefined && !isNonEmptyString(record.repo)) {
    problems.push("scope.repo: when present, must be a non-empty content-free repo identifier");
  }
  for (const [key, value] of Object.entries(record)) {
    if (!["tool", "repo", "policy_type"].includes(key)) {
      problems.push(`scope.${key}: not an allowed scope field (only tool, repo, policy_type)`);
      continue;
    }
    if (typeof value === "string" && value.length > POLICY_PREFERENCE_MAX_STRING_LENGTH) {
      problems.push(`scope.${key}: string exceeds the content-free bound (${value.length} chars) - that is content-sized`);
    }
  }
  return { problems };
}

/** Deterministic content-free id over the scope only (so a scope has ONE preference record). */
export function computePolicyPreferenceId(scope: PolicyPreferenceScope): string {
  const canonical = JSON.stringify({
    policy_type: scope.policy_type,
    repo: scope.repo ?? null,
    tool: scope.tool
  });
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `pref-${digest.slice(0, 24)}`;
}

export const POLICY_PREFERENCE_ID_PATTERN = /^pref-[0-9a-f]{24}$/;

function preferencesPath(directory: string): string {
  return join(directory, POLICY_PREFERENCES_FILENAME);
}

/** Read all stored preferences. A missing file means "none saved yet" (empty, not an error). */
export async function readPolicyPreferences(
  directory: string = DEFAULT_POLICY_PREFERENCES_DIRECTORY
): Promise<{ preferences: PolicyPreference[] }> {
  let raw: string;
  try {
    raw = await readFile(preferencesPath(directory), "utf8");
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    if (code === "ENOENT") return { preferences: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${preferencesPath(directory)} is not valid JSON - refusing to guess (fail-closed)`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { preferences?: unknown }).preferences)
      ? (parsed as { preferences: unknown[] }).preferences
      : [];
  const preferences = list.filter((entry): entry is PolicyPreference => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as Record<string, unknown>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.enabled === "boolean" &&
      POLICY_PREFERENCE_VALUES.includes(candidate.preference as PolicyPreferenceValue) &&
      validatePolicyPreferenceScope(candidate.scope).problems.length === 0
    );
  });
  return { preferences };
}

export type SavePolicyPreferenceResult =
  | { saved: true; preference: PolicyPreference; path: string; replacedExisting: boolean }
  | { saved: false; problems: string[] };

/**
 * Save (upsert by deterministic scope id) ONE preference to the local store. Fail-closed: an
 * invalid scope saves NOTHING. THIS DOES NOT APPLY ANYTHING - it writes one JSON file and returns;
 * there is no application path here (proven by the fail-closed test).
 */
export async function savePolicyPreference(
  input: SavePolicyPreferenceInput,
  directory: string = DEFAULT_POLICY_PREFERENCES_DIRECTORY
): Promise<SavePolicyPreferenceResult> {
  const problems = validatePolicyPreferenceScope(input.scope).problems;
  if (!POLICY_PREFERENCE_VALUES.includes(input.preference)) {
    problems.push(`preference: must be one of ${POLICY_PREFERENCE_VALUES.join(" | ")} (exact)`);
  }
  if (problems.length > 0) return { saved: false, problems };

  const scope: PolicyPreferenceScope = {
    tool: input.scope.tool,
    policy_type: input.scope.policy_type,
    ...(input.scope.repo !== undefined ? { repo: input.scope.repo } : {})
  };
  const record: PolicyPreference = {
    id: computePolicyPreferenceId(scope),
    scope,
    preference: input.preference,
    enabled: input.enabled ?? true,
    gates_required: input.gates_required ? [...input.gates_required] : [...DEFAULT_GATES_REQUIRED]
  };

  const { preferences } = await readPolicyPreferences(directory);
  const existingIndex = preferences.findIndex((entry) => entry.id === record.id);
  const replacedExisting = existingIndex >= 0;
  const next = replacedExisting
    ? preferences.map((entry, index) => (index === existingIndex ? record : entry))
    : [...preferences, record];

  const path = preferencesPath(directory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ preferences: next }, null, 2)}\n`, "utf8");
  return { saved: true, preference: record, path, replacedExisting };
}

export type DisablePolicyPreferenceResult =
  | { disabled: true; preference: PolicyPreference; path: string; alreadyDisabled: boolean }
  | { disabled: false; reason: string };

/**
 * Disable a preference by id (set enabled=false). The safe management verb - disabling can only
 * ever REDUCE what could apply, so it is always safe. Unknown id → a clear error, nothing changed.
 * Idempotent: disabling an already-disabled preference is a reported no-op (no throw).
 */
export async function disablePolicyPreference(
  id: string,
  directory: string = DEFAULT_POLICY_PREFERENCES_DIRECTORY
): Promise<DisablePolicyPreferenceResult> {
  const { preferences } = await readPolicyPreferences(directory);
  const index = preferences.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return { disabled: false, reason: `no preference with id "${id}" - nothing changed (run "compaction policies list")` };
  }
  const target = preferences[index];
  if (target.enabled === false) {
    return { disabled: true, preference: target, path: preferencesPath(directory), alreadyDisabled: true };
  }
  const updated: PolicyPreference = { ...target, enabled: false };
  const next = preferences.map((entry, i) => (i === index ? updated : entry));
  const path = preferencesPath(directory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ preferences: next }, null, 2)}\n`, "utf8");
  return { disabled: true, preference: updated, path, alreadyDisabled: false };
}

/** Look up one preference by id (read-only). */
export async function findPolicyPreference(
  id: string,
  directory: string = DEFAULT_POLICY_PREFERENCES_DIRECTORY
): Promise<PolicyPreference | undefined> {
  const { preferences } = await readPolicyPreferences(directory);
  return preferences.find((entry) => entry.id === id);
}

/**
 * Plain-language explanation of what a preference MEANS. Honest per state:
 * - `ask-each-time` (the default): nothing is ever applied automatically under it.
 * - `auto-when-gates-pass` with ENGINE-EVALUABLE gates: ACTIVE while enabled - future eligible
 *   requests in this scope are applied automatically by the deterministic policy when EVERY gate
 *   passes; anything else is forwarded unchanged.
 * - `auto-when-gates-pass` with gates the engine does NOT evaluate (legacy default list): stored
 *   but NEVER applied (fail-closed on unevaluable gates).
 * Surfaces the user-inspectable facts: scope, policy, gates, where originals are retained, how to
 * recover, and how to disable. No wall-clock, no content.
 */
export function explainPolicyPreference(preference: PolicyPreference): string {
  const scopeLine = preference.scope.repo
    ? `the "${preference.scope.tool}" workflow in repo "${preference.scope.repo}"`
    : `the "${preference.scope.tool}" workflow`;
  const lines = [
    `Preference ${preference.id}`,
    ``,
    `Scope:      ${scopeLine}`,
    `Policy:     ${preference.scope.policy_type}`,
    `Preference: ${preference.preference}`,
    `Enabled:    ${preference.enabled ? "yes" : "no (disabled)"}`,
    ``
  ];
  if (preference.preference === "auto-when-gates-pass") {
    if (gatesAreEngineEvaluable(preference.gates_required)) {
      lines.push(
        `What it means: for ${scopeLine}, you gave one explicit scoped authorization: eligible`,
        `requests are applied automatically by the deterministic policy - ONLY when every one of`,
        `these gates passes on that request (evaluated fail-closed, every time):`,
        ...preference.gates_required.map((gate) => `  - ${gate}`),
        ``,
        preference.enabled
          ? `ACTIVE while enabled: an eligible request is applied automatically WITHOUT a per-run ask;`
          : `DISABLED: nothing is applied automatically under this preference until it is re-authorized;`,
        `an unsupported, uncertain, out-of-scope, or failing request is forwarded UNCHANGED, and a`,
        `Compaction failure never blocks the workflow (fail-open).`,
        ``,
        `Every automatic application: retains the exact original locally (.compaction/gateway/recovery/),`,
        `is byte-exact recoverable (compaction gateway recover <recovery_id>), and is recorded`,
        `content-free with the passing gates and this preference id (compaction activity).`
      );
    } else {
      lines.push(
        `What it would mean: for ${scopeLine}, you chose "apply automatically next time WHEN ALL`,
        `safety gates pass". This preference requires gates the deterministic eligibility engine`,
        `does not evaluate:`,
        ...preference.gates_required.map((gate) => `  - ${gate}`),
        ``,
        `STORED, NEVER APPLIED: because at least one required gate is not evaluable, nothing is`,
        `applied automatically under this preference (fail-closed on unevaluable gates).`
      );
    }
  } else {
    lines.push(
      `What it means: for ${scopeLine}, Compaction ASKS every time before applying anything`,
      `(the default). Nothing is ever applied automatically under this preference.`
    );
  }
  lines.push(
    ``,
    `Originals are always retained; every application is reversible.`,
    `To turn this preference off:  compaction policies disable ${preference.id}`
  );
  return lines.join("\n");
}
