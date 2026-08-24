/**
 * Gateway capability matrix (public CLI/SDK code, engine-free). The content-free answer to "for THIS
 * workflow × provider, what is actually supported?", GENERATED from two truths (never a hardcoded table):
 * the adapter registry (`ADAPTERS`) + each adapter's own `capabilities` descriptor, and the honest
 * per-workflow routing descriptors below. Pure function of those two.
 *
 * Invariants:
 *  - A workflow's readiness is SEPARATE from cache proof / live verification. Independent states:
 *    detected (`workflowFound`) · installable (keyless hook/shim) · plan-auth-ready (run the tool with the
 *    user's existing CLI auth; content-free usage recorded, no API key) · gatewayRoutable · cacheProofSupported
 *    · liveVerified. Codex/Claude Code/Cursor are all detected+installable+plan-auth-ready; only cache-proof /
 *    live-verification differ. A workflow is NEVER "unavailable" merely because cache proof / live verification
 *    is undone, `unavailableReason` is the reason CACHE PROOF is unavailable, not the workflow.
 *  - `liveVerified` defaults false everywhere (adapters are fixture-tested, not proven against live traffic);
 *    it flips true for a provider ONLY from a caller-supplied passing verification record (`opts.verifications`,
 *    real operator-run `verify-cache`), derived from evidence, never fabricated. No record → false everywhere.
 *  - `cacheProofSupported = cacheNormalized && gatewayRoutable && provider-usage-available` (structurally
 *    impossible to be true where any input is false).
 *  - EVERY false capability carries a non-empty honest reason (never a bare false).
 *  - No cost / billing / output-token / savings / semantic claim.
 *  - Content-free by construction: every field is a boolean, an honesty label, a reason string, or a
 *    display-name, no field can carry prompt/response/tool content or credentials.
 */
import { ADAPTERS, type ProviderAdapter } from "./provider-adapter.js";

/** The workflows the matrix answers for. `custom-openai-app` is the primary gateway-routable path. */
export type WorkflowKey = "codex" | "claude-code" | "cursor" | "custom-openai-app";

/**
 * Whether a workflow's provider requests route THROUGH the local Gateway:
 *  - `true`           , routed by default (the custom OpenAI-compatible app path);
 *  - `false`          , not routable (activity-only Stop hook / local-estimate vendor gap);
 *  - `"if-configured"`, routable only when the user configures it (Codex + `OPENAI_BASE_URL` → Gateway); not
 *                        routed by default, so provider-reported proof is unavailable until configured.
 */
export type GatewayRoutable = boolean | "if-configured";

/**
 * The provenance/support labels a surface may render (never a stronger one it invents). `cache-proof-supported`
 * means the pipeline CAN produce cache proof, not that it is live-verified, carry `liveVerified` alongside.
 */
export type CapabilityLabel =
  | "provider-reported"
  | "local-estimate"
  | "unavailable"
  | "activity-only"
  | "gateway-routable"
  | "cache-proof-supported";

/**
 * Per-provider capability, generated from the adapter registry. `usageNormalized` follows from registry
 * presence; `cacheNormalized` is read from the adapter's own `capabilities.reportsCacheHitField`.
 */
export interface ProviderCapability {
  providerId: string;
  displayName: string;
  /** True: a registered adapter normalizes this provider's usage object (derived from registry presence). */
  usageNormalized: boolean;
  /** True iff the adapter can normalize a provider cache-HIT field (from `adapter.capabilities`). */
  cacheNormalized: boolean;
  /** Default false (fixture-tested, not proven live); true only from a supplied passing verification record. */
  liveVerified: boolean;
  /** Required when `cacheNormalized` is false, the honest reason (never a bare false). */
  cacheUnavailableReason?: string;
  /** The honest not-yet-live-proven reason (or the live-verified reason once verified). */
  liveUnverifiedReason: string;
}

/**
 * Routing descriptor for one workflow, grounded in the current integration. `activityOnly` /
 * `localEstimateOnly` are limitation flags (true = the honest limited state).
 */
export interface WorkflowRouting {
  workflow: WorkflowKey;
  displayName: string;
  gatewayRoutable: GatewayRoutable;
  /**
   * Installable (keyless): Compaction can install its hook/shim for this workflow with no API key. True for the
   * three CLI workflows; false for the custom OpenAI-compatible app (a routing path with no shim/hook).
   */
  installable: boolean;
  /**
   * Plan-auth ready (the default keyless MVP path): the workflow works via the user's existing CLI auth and
   * records content-free usage through the installed shim/hook, no API key, no Gateway routing required. A
   * per-workflow constant (not key-derived), independent of cacheProofSupported / gatewayRoutable / liveVerified.
   */
  planAuthReady: boolean;
  /** A positive, content-free note describing the plan-auth path (or why it is n/a for the custom app). */
  planAuthNote: string;
  /** The provider a routable workflow routes to (OpenAI-compatible → `openai`); undefined otherwise. */
  defaultProvider?: string;
  /** True when the integration only records session activity (no gateway provider routing). */
  activityOnly: boolean;
  /** True when only a local estimate is possible (the provider emits no usage; vendor gap). */
  localEstimateOnly: boolean;
  /** Honest note about the routing mechanism (always present when not fully `true`). */
  routingNote: string;
  /**
   * Required when not routed by default, the honest reason CACHE PROOF is unavailable. Not a reason the
   * workflow is unavailable: a plan-auth-ready workflow with unavailable cache proof stays detected +
   * installable + plan-auth-ready.
   */
  unavailableReason?: string;
}

/**
 * The combined canonical answer for one workflow (and its default provider where relevant). Every capability
 * boolean that can be false carries a reason in `reasons` (keyed by field name), never a bare false.
 */
export interface WorkflowProviderCapability {
  workflow: WorkflowKey;
  workflowDisplayName: string;
  /** The default provider where relevant (e.g. `openai`); undefined for activity-only / local-estimate rows. */
  providerId?: string;
  providerDisplayName?: string;
  /**
   * Machine detection is the CALLER's job (this model is machine-independent). Populated only when a
   * `found` input is supplied to `computeCapabilityMatrix`; otherwise undefined.
   */
  workflowFound?: boolean;
  /** Installable (keyless): Compaction can install its hook/shim for this workflow (no API key). */
  installable: boolean;
  /**
   * Plan-auth ready (the default keyless MVP path): works via the user's existing CLI auth, measured
   * content-free with no API key and no Gateway routing. Independent of cacheProofSupported / liveVerified, a
   * workflow is NOT unavailable when those are false.
   */
  planAuthReady: boolean;
  /** A positive, content-free note describing the plan-auth path (or why it is n/a for the custom app). */
  planAuthNote: string;
  gatewayRoutable: GatewayRoutable;
  /** A registered provider adapter applies AND normalizes usage for this workflow's routed provider. */
  providerSupported: boolean;
  /** The Gateway can record content-free usage receipts for this workflow (requires routing through it). */
  canRecordUsage: boolean;
  canShowProviderReportedUsage: boolean;
  canShowProviderReportedCacheTokens: boolean;
  canDeriveFreshInputReduction: boolean;
  /** cacheNormalized && routed && provider-usage-available (impossible to be true where any input is false). */
  cacheProofSupported: boolean;
  /** The deterministic apply-with-approval path applies (gateway-routable OpenAI-compatible path only). */
  contextOptimizeWithApprovalSupported: boolean;
  /** Carried alongside cacheProofSupported: default false (supported ≠ live-proven); true only from evidence. */
  liveVerified: boolean;
  localEstimateOnly: boolean;
  activityOnly: boolean;
  /** The label set for this row (a surface renders from these, never a stronger invented label). */
  labels: CapabilityLabel[];
  /** Honest note about the routing mechanism. */
  routingNote: string;
  /** The not-yet-live-proven reason (or live-verified reason once verified). */
  liveUnverifiedReason: string;
  /** Honest reason for every false capability (never a bare false). Keyed by the capability field name. */
  reasons: Record<string, string>;
}

/**
 * A content-free, pure per-provider live-verification input. `liveVerified` is the result of a real
 * operator-run cache verification (`compaction gateway verify-cache`), read from a local content-free record by
 * the caller and passed in (the matrix stays pure). Carries only a provider id, a boolean, and an optional
 * note, never a key or content.
 */
export interface ProviderLiveVerification {
  providerId: string;
  /** True only when a passing content-free verification record exists for this provider (never fabricated). */
  liveVerified: boolean;
  /** Optional content-free honesty note (no percent/savings phrasing). */
  note?: string;
}

/** Options for `computeCapabilityMatrix`, pure inputs only (no IO). */
export interface CapabilityMatrixOptions {
  /** Override the adapter registry (tests use this to prove the matrix is generated, not hardcoded). */
  adapters?: ProviderAdapter[];
  /** Optional caller-supplied per-workflow detection results (keeps the model machine-independent). */
  found?: Partial<Record<WorkflowKey, boolean>>;
  /**
   * Optional per-provider live-verification evidence (real operator-run `verify-cache` records). Default none →
   * `liveVerified` false for every row. A provider is `liveVerified:true` only when a passing record is here.
   */
  verifications?: ProviderLiveVerification[];
}

/** The content-free note stamped on a provider/row that a real verification has live-verified. */
export const LIVE_VERIFIED_REASON =
  "live-verified: provider-reported cache observed in a recorded content-free verification (compaction gateway verify-cache).";

/** The single honest reason `liveVerified` is false for a not-yet-verified provider/row. */
export const LIVE_UNVERIFIED_REASON =
  "adapters are fixture-tested (usage/cache fields normalized + unit-tested), not proven against live provider traffic this cycle; a later dogfood flips exactly the paths it proves.";

/**
 * The capability fields that must carry a reason in `reasons` when false. `gatewayRoutable` is handled
 * separately (a reason whenever it is not `true`). Exported so the reason-completeness test iterates the same
 * list the builder guarantees.
 */
export const REASONED_CAPABILITY_FIELDS = [
  "providerSupported",
  "canRecordUsage",
  "canShowProviderReportedUsage",
  "canShowProviderReportedCacheTokens",
  "canDeriveFreshInputReduction",
  "cacheProofSupported",
  "contextOptimizeWithApprovalSupported",
  "liveVerified"
] as const;

/**
 * Derive per-provider capability from the adapter registry. `usageNormalized` follows from registry presence;
 * `cacheNormalized` is read from each adapter's own `capabilities.reportsCacheHitField`. Pure, no IO.
 */
export function deriveProviderCapabilities(
  adapters: ProviderAdapter[] = ADAPTERS,
  verifications: ProviderLiveVerification[] = []
): ProviderCapability[] {
  return adapters.map((a) => {
    const cacheNormalized = a.capabilities.reportsCacheHitField;
    // liveVerified only from a supplied passing record for this provider (default none → false); never fabricated.
    const liveVerified = verifications.some((v) => v.providerId === a.providerId && v.liveVerified);
    return {
      providerId: a.providerId,
      displayName: a.displayName,
      usageNormalized: true,
      cacheNormalized,
      liveVerified,
      ...(cacheNormalized
        ? {}
        : {
            cacheUnavailableReason: `${a.displayName} exposes no provider cache-hit field, so cached input tokens cannot be normalized; cache proof is structurally unavailable for this provider.`
          }),
      liveUnverifiedReason: liveVerified ? LIVE_VERIFIED_REASON : LIVE_UNVERIFIED_REASON
    };
  });
}

/**
 * Workflow routing descriptors, grounded in the current integration: Codex's shim is capture/activity
 * (routable only if `OPENAI_BASE_URL` points at the Gateway); Claude Code is a post-session Stop hook
 * (activity-only); Cursor emits no provider usage (local-estimate vendor gap); the custom OpenAI-compatible
 * app is the primary gateway-routable path.
 */
export const WORKFLOW_ROUTING: WorkflowRouting[] = [
  {
    workflow: "custom-openai-app",
    displayName: "Custom OpenAI-compatible app",
    gatewayRoutable: true,
    defaultProvider: "openai",
    installable: false,
    planAuthReady: false,
    planAuthNote:
      "not a plan-auth CLI workflow - this is the Advanced gateway-routable path (the user points their own OpenAI-compatible app/command at the local Gateway); there is no shim/hook to install and no existing-subscription plan-auth path.",
    activityOnly: false,
    localEstimateOnly: false,
    routingNote:
      "the primary gateway-routable path: the user points their own app/command at the local Gateway via `compaction gateway run -- <command>`, so OpenAI-compatible requests flow through Compaction."
  },
  {
    workflow: "codex",
    displayName: "Codex CLI",
    gatewayRoutable: "if-configured",
    defaultProvider: "openai",
    installable: true,
    planAuthReady: true,
    planAuthNote:
      "plan-auth ready (default, keyless): run `codex` normally with your existing CLI auth / subscription; Compaction records content-free usage through the installed shim - no API key requested or stored.",
    activityOnly: true,
    localEstimateOnly: false,
    routingNote:
      "the current Compaction shim wraps `codex exec --json` for capture/activity - it does NOT route provider requests through the Gateway. Codex is gateway-routable ONLY when the user sets an OpenAI-compatible base URL (OPENAI_BASE_URL) to the local Gateway.",
    unavailableReason:
      "Codex is detected, installable, and plan-auth-ready; only provider CACHE PROOF is unavailable by default because the shim is capture/activity and does not route provider requests through the Gateway (route via OPENAI_BASE_URL → the local Gateway to enable provider-reported cache proof). The workflow itself is not unavailable."
  },
  {
    workflow: "claude-code",
    displayName: "Claude Code",
    gatewayRoutable: false,
    installable: true,
    planAuthReady: true,
    planAuthNote:
      "plan-auth ready (default, keyless): run `claude` normally with your existing CLI auth / subscription; Compaction records content-free usage through the installed Stop hook - no API key requested or stored.",
    activityOnly: true,
    localEstimateOnly: false,
    routingNote:
      "the current integration is a consented Stop hook (post-session, activity-only) - it records session activity and does NOT route provider requests through the Gateway.",
    unavailableReason:
      "Claude Code is detected, installable, and plan-auth-ready; only provider CACHE PROOF is unavailable by default because the integration is an activity-only Stop hook that does not route provider requests through the Gateway (route via `--provider anthropic` to enable provider-reported cache proof). The workflow itself is not unavailable."
  },
  {
    workflow: "cursor",
    displayName: "Cursor",
    gatewayRoutable: false,
    installable: true,
    planAuthReady: true,
    planAuthNote:
      "plan-auth ready (default, keyless): run `cursor` normally with your existing CLI auth / subscription; Compaction records a content-free local estimate of activity through the installed shim - no API key requested or stored.",
    activityOnly: false,
    localEstimateOnly: true,
    routingNote:
      "Cursor emits no provider usage and cannot be routed through the Gateway (vendor gap); Compaction can only produce a local estimate of activity.",
    unavailableReason:
      "Cursor is detected, installable, and plan-auth-ready (content-free local estimate of activity); only provider cache proof is unavailable because Cursor emits no provider usage (vendor gap) and cannot be routed through the Gateway. The workflow itself is not unavailable."
  }
];

/** True iff this workflow's requests are routed through the Gateway BY DEFAULT (not merely if-configured). */
function routedNow(routable: GatewayRoutable): boolean {
  return routable === true;
}

/** The honest reason a provider-reported capability is unavailable because of the routing gap. */
function routingGapReason(r: WorkflowRouting): string {
  return (
    r.unavailableReason ??
    `${r.displayName} does not route provider requests through the local Gateway (${r.routingNote})`
  );
}

/**
 * Build the combined capability row for one workflow and its (optional) default provider. Pure. Every false
 * reasoned capability gets a specific honest reason, so the row never carries a bare false.
 */
export function buildCapabilityRow(
  r: WorkflowRouting,
  provider?: ProviderCapability
): WorkflowProviderCapability {
  const routed = routedNow(r.gatewayRoutable);
  const providerSupported = provider !== undefined && provider.usageNormalized;
  const cacheNormalized = provider?.cacheNormalized === true;

  const canRecordUsage = routed && providerSupported;
  const canShowProviderReportedUsage = routed && providerSupported;
  const canShowProviderReportedCacheTokens = routed && providerSupported && cacheNormalized;
  const canDeriveFreshInputReduction = canShowProviderReportedCacheTokens;
  const cacheProofSupported = cacheNormalized && routed && providerSupported;
  const contextOptimizeWithApprovalSupported = routed && providerSupported;

  // liveVerified requires the row to be actually routed AND its provider to have a passing record. An
  // unrouted row (activity-only / local-estimate / if-configured) has no cache-proof path to verify → false.
  const liveVerified = routed && provider?.liveVerified === true;

  const reasons: Record<string, string> = {};
  // reasons hold reasons for FALSE capabilities only; a false liveVerified carries the not-yet-proven reason.
  if (!liveVerified) reasons.liveVerified = LIVE_UNVERIFIED_REASON;

  const routingReason = routingGapReason(r);
  // A routed+supported provider whose only gap is the cache field (e.g. Mistral) uses the adapter's reason.
  const cacheGapReason =
    provider && !cacheNormalized && provider.cacheUnavailableReason ? provider.cacheUnavailableReason : routingReason;

  if (!providerSupported) {
    reasons.providerSupported =
      provider === undefined
        ? `${r.displayName} routes no requests through the local Gateway (${r.activityOnly ? "activity-only" : r.localEstimateOnly ? "local-estimate only" : "not routable"}), so no provider adapter applies. ${r.routingNote}`
        : `the ${provider.displayName} adapter does not normalize usage.`;
  }
  if (!canRecordUsage) reasons.canRecordUsage = routingReason;
  if (!canShowProviderReportedUsage) reasons.canShowProviderReportedUsage = routingReason;
  if (!canShowProviderReportedCacheTokens) {
    reasons.canShowProviderReportedCacheTokens = routed && providerSupported ? cacheGapReason : routingReason;
  }
  if (!canDeriveFreshInputReduction) {
    reasons.canDeriveFreshInputReduction = routed && providerSupported ? cacheGapReason : routingReason;
  }
  if (!cacheProofSupported) {
    reasons.cacheProofSupported =
      provider && !cacheNormalized ? cacheGapReason : routingReason;
  }
  if (!contextOptimizeWithApprovalSupported) {
    reasons.contextOptimizeWithApprovalSupported = `the deterministic apply-with-approval path applies only to the gateway-routable OpenAI-compatible path; ${routingReason}`;
  }
  // gatewayRoutable reason whenever it is not fully `true` (false or if-configured).
  if (r.gatewayRoutable !== true) reasons.gatewayRoutable = r.routingNote;

  const labels: CapabilityLabel[] = [];
  if (routed) labels.push("gateway-routable");
  if (canShowProviderReportedUsage) labels.push("provider-reported");
  if (cacheProofSupported) labels.push("cache-proof-supported");
  if (r.localEstimateOnly) labels.push("local-estimate");
  if (r.activityOnly) labels.push("activity-only");
  if (labels.length === 0) labels.push("unavailable");

  return {
    workflow: r.workflow,
    workflowDisplayName: r.displayName,
    ...(provider ? { providerId: provider.providerId, providerDisplayName: provider.displayName } : {}),
    installable: r.installable,
    planAuthReady: r.planAuthReady,
    planAuthNote: r.planAuthNote,
    gatewayRoutable: r.gatewayRoutable,
    providerSupported,
    canRecordUsage,
    canShowProviderReportedUsage,
    canShowProviderReportedCacheTokens,
    canDeriveFreshInputReduction,
    cacheProofSupported,
    contextOptimizeWithApprovalSupported,
    liveVerified,
    localEstimateOnly: r.localEstimateOnly,
    activityOnly: r.activityOnly,
    labels,
    routingNote: r.routingNote,
    liveUnverifiedReason: provider?.liveUnverifiedReason ?? LIVE_UNVERIFIED_REASON,
    reasons
  };
}

/**
 * The capability matrix: one row per workflow (and its default provider where relevant), generated from the
 * adapter registry + the workflow routing descriptors. Pure and machine-independent by default; supply
 * `opts.found` to attach caller-side detection, or `opts.adapters` (removing one decays its dependent rows).
 */
export function computeCapabilityMatrix(opts: CapabilityMatrixOptions = {}): WorkflowProviderCapability[] {
  const providerCaps = deriveProviderCapabilities(opts.adapters ?? ADAPTERS, opts.verifications ?? []);
  return WORKFLOW_ROUTING.map((r) => {
    const provider = r.defaultProvider
      ? providerCaps.find((p) => p.providerId === r.defaultProvider)
      : undefined;
    const row = buildCapabilityRow(r, provider);
    if (opts.found && Object.prototype.hasOwnProperty.call(opts.found, r.workflow)) {
      row.workflowFound = opts.found[r.workflow];
    }
    return row;
  });
}

/** Look up a single workflow's row from a computed matrix. Pure. */
export function capabilityForWorkflow(
  matrix: WorkflowProviderCapability[],
  workflow: WorkflowKey
): WorkflowProviderCapability | undefined {
  return matrix.find((row) => row.workflow === workflow);
}
