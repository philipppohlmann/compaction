/**
 * Compaction Gateway automatic-apply eligibility GATES (PUBLIC).
 *
 * Deterministic, engine-free, and fail-closed for mutation while the caller remains fail-open for
 * workflow traffic. This module decides WHETHER apply is allowed for a request — the stored
 * authorization's state, the policy label, the scope match, and the routed endpoint family. It runs no
 * optimization algorithm and mutates nothing, so it holds no static edge into a private module. The
 * in-process composition that DOES mutate lives in `apply-composition.ts` and consumes these gates.
 */
import { join } from "node:path";
import {
  AUTO_APPLY_ELIGIBILITY_GATES,
  DEFAULT_POLICY_PREFERENCES_DIRECTORY,
  REJECTED_GLOBAL_TOOL_VALUES,
  gatesAreEngineEvaluable,
  readPolicyPreferences,
  type PolicyPreference
} from "../policy-preferences.js";
import { DEDUPE_POLICY } from "./request-shape.js";

export type ApplyGateResult = "pass" | "fail";

export interface ApplyRequestScope {
  tool: string;
  repo?: string;
}

/** Verified routed endpoint families. Cursor/custom tools are deliberately absent. */
export const AUTO_APPLY_TOOL_ENDPOINT_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["/messages"],
  codex: ["/responses", "/chat/completions"],
  // Cursor routes OpenAI-compatible AND Anthropic traffic when pointed at the gateway (custom base
  // URL / multi-provider routing). Apply is input-reduction with a LOCAL estimate; no provider-cache
  // capability is claimed for Cursor.
  cursor: ["/responses", "/chat/completions", "/messages"]
};

function endpointMatchesTool(endpoint: string, tool: string): boolean {
  const suffixes = AUTO_APPLY_TOOL_ENDPOINT_FAMILIES[tool];
  if (!suffixes) return false;
  const path = endpoint.split("?")[0];
  return suffixes.some((suffix) => path.endsWith(suffix));
}

export async function findStoredAuthorization(params: {
  scope: ApplyRequestScope;
  cwd: string;
}): Promise<PolicyPreference | undefined> {
  const tool = params.scope.tool?.trim();
  if (!tool || REJECTED_GLOBAL_TOOL_VALUES.includes(tool.toLowerCase())) return undefined;
  const { preferences } = await readPolicyPreferences(join(params.cwd, DEFAULT_POLICY_PREFERENCES_DIRECTORY));
  return preferences
    .filter(
      (preference) =>
        preference.enabled === true &&
        preference.preference === "auto-when-gates-pass" &&
        preference.scope.policy_type === DEDUPE_POLICY &&
        preference.scope.tool === tool &&
        (preference.scope.repo === undefined || preference.scope.repo === params.scope.repo)
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/**
 * The PUBLIC-GATE half of apply eligibility: the auth/scope/endpoint gates the gateway decides
 * BEFORE consulting the native engine — WHETHER apply is allowed for this request. It runs NO
 * optimization algorithm (no dedupe, no shaping, no LCM): those moved into the engine. It returns the
 * content-free gate results this mechanism can decide without the body (`deterministic-policy`,
 * `scope-match`), so the caller only sends ELIGIBLE requests to the engine and can compose the exact
 * gate list the receipt records. The shape/change/retention gates are decided AFTER the engine
 * returns (supported-shape/change-produced from the engine's result; original-retainable when the
 * gateway retains). Fail-closed and never throws.
 */
export interface StoredApplyGateResult {
  eligible: boolean;
  gateResults: Record<string, ApplyGateResult>;
  reason: string;
}

export function evaluateStoredApplyGates(params: {
  endpoint: string;
  requestScope: ApplyRequestScope;
  storedAuthorization: PolicyPreference;
}): StoredApplyGateResult {
  try {
    return evaluateGatesOnly(params);
  } catch (error) {
    return {
      eligible: false,
      gateResults: failedGates(),
      reason: `eligibility evaluation failed (${(error as Error).message}) - fail closed, original forwarded unchanged`
    };
  }
}

/**
 * The auth/scope/endpoint gate checks. Sets `deterministic-policy` and `scope-match` on the shared
 * `gateResults` object (same key-insertion order as `failedGates()`), leaving the shape/change/
 * retention gates for the caller. The in-process composition consumes this function rather than
 * copying it, so the two paths cannot diverge in gate order, keys, or refusal reasons.
 */
function evaluateGatesOnly(params: {
  endpoint: string;
  requestScope: ApplyRequestScope;
  storedAuthorization: PolicyPreference;
}): StoredApplyGateResult {
  const auth = params.storedAuthorization;
  const gateResults = failedGates();

  if (auth.enabled !== true) {
    return { eligible: false, gateResults, reason: `preference ${auth.id} is disabled - nothing is applied under it` };
  }
  if (auth.preference !== "auto-when-gates-pass") {
    return {
      eligible: false,
      gateResults,
      reason: `preference ${auth.id} is "${auth.preference}" - the per-run ask is still required; nothing is applied automatically`
    };
  }
  if (!gatesAreEngineEvaluable(auth.gates_required)) {
    const unknown = auth.gates_required.filter((gate) => !AUTO_APPLY_ELIGIBILITY_GATES.includes(gate));
    return {
      eligible: false,
      gateResults,
      reason: `preference ${auth.id} requires gate(s) this engine does not evaluate (${unknown.join(", ") || "none listed"}) - fail closed`
    };
  }

  if (auth.scope.policy_type !== DEDUPE_POLICY) {
    return {
      eligible: false,
      gateResults,
      reason: `stored policy_type '${auth.scope.policy_type}' is not the deterministic policy '${DEDUPE_POLICY}' - fail closed`
    };
  }
  gateResults["deterministic-policy"] = "pass";

  const requestTool = params.requestScope.tool?.trim();
  if (!requestTool) {
    return { eligible: false, gateResults, reason: "this gateway connection has no workflow identity - no stored authorization can match (fail closed)" };
  }
  if (
    REJECTED_GLOBAL_TOOL_VALUES.includes(requestTool.toLowerCase()) ||
    REJECTED_GLOBAL_TOOL_VALUES.includes(auth.scope.tool.trim().toLowerCase())
  ) {
    return { eligible: false, gateResults, reason: "global/cross-tool scopes are never valid for auto-apply - fail closed" };
  }
  if (auth.scope.tool !== requestTool) {
    return {
      eligible: false,
      gateResults,
      reason: `scope mismatch: authorization covers tool '${auth.scope.tool}', this connection is '${requestTool}' - no application outside the stored authorization`
    };
  }
  if (auth.scope.repo !== undefined && auth.scope.repo !== params.requestScope.repo) {
    return {
      eligible: false,
      gateResults,
      reason: `scope mismatch: authorization is pinned to repo '${auth.scope.repo}', this connection is '${params.requestScope.repo ?? "unknown"}' - fail closed`
    };
  }
  if (!endpointMatchesTool(params.endpoint, requestTool)) {
    return {
      eligible: false,
      gateResults,
      reason: `endpoint '${params.endpoint}' is not a routed endpoint family for tool '${requestTool}' - fail closed`
    };
  }
  gateResults["scope-match"] = "pass";

  return {
    eligible: true,
    gateResults,
    reason: "auth/scope/endpoint gates passed; the engine decides the shape/change gates"
  };
}

function failedGates(): Record<string, ApplyGateResult> {
  const gateResults: Record<string, ApplyGateResult> = {};
  for (const gate of AUTO_APPLY_ELIGIBILITY_GATES) gateResults[gate] = "fail";
  return gateResults;
}
