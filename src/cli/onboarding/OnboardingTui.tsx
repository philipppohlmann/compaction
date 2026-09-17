import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import {
  ONBOARDING_TOOLS,
  ONBOARDING_TARGET_HEADER,
  ONBOARDING_TARGET_READONLY,
  ONBOARDING_PLAN_OPTIONS,
  ONBOARDING_PLAN_HEADER,
  ONBOARDING_PLAN_SUBLINES,
  ONBOARDING_PRO_WAITLIST_HEADLINE,
  onboardingProWaitlistLines,
  ONBOARDING_AUTH_FALLBACK_LINES,
  onboardingAuthFailureLines,
  onboardingReadyToolLine,
  CODEX_TRUST_ONBOARDING_INSTRUCTION,
  findOnboardingTool,
  orderedOnboardingDiscovery,
  deriveDiscovery,
  initialSelection,
  toggleSelection,
  workflowsToEnable,
  selectedReadyWorkflows,
  defaultOptimizationMode,
  recommendedOnboardingPlan,
  type ConnectDetection,
  type WorkflowDiscovery,
  type ReadyToolKey,
  type EnableResult,
  type OptimizationModeKey,
  type OnboardingReadyStatus,
  type OnboardingPlanKey,
  type OnboardingProductMode,
  type OnboardingAuthProgress,
  type OnboardingAuthFailureReason,
  type CommunityAuthFn
} from "./model.js";
import {
  ENGINE_EULA_SUMMARY,
  ENGINE_EULA_VERSION,
  engineEulaAccepted,
  engineEulaUrl,
  recordEngineEulaAcceptance
} from "../../core/legal/engine-eula.js";
import { WelcomeHeader, FRAME_MAX, useTerminalSize } from "./WelcomeHeader.js";

/**
 * Production interactive onboarding for `compaction init`: select detected workflows, choose a
 * plan, run the installers, then show verified status.
 *
 * ARCHITECTURE (what keeps this testable + honest):
 *  - Detection (`ConnectDetection`) and verified ready status (`OnboardingReadyStatus`) are computed
 *    by init.ts from real local state and injected; this component invents neither.
 *  - Every write routes through the SAME injected callbacks the static/headless surfaces use:
 *    `onEnable` (production wraps the real installers; tests pass a fake) runs ONLY on the explicit
 *    Plan confirmation; `onPersistMode` (production wraps `writeOptimizationMode` + narrow
 *    authorizations) runs on the same consent.
 *  - Discovery and target screens write nothing. Confirming the plan starts setup and is the first write.
 *
 * Invariants: no network call or credential read; nothing is written until the plan confirmation
 * consent; no savings/cost/output-token figure is shown; the Wordmark is preserved.
 */

export type EnableFn = (keys: ReadyToolKey[]) => Promise<EnableResult>;
export type PersistModeFn = (mode: OptimizationModeKey, workflows: ReadyToolKey[]) => Promise<void>;
/** Persist the plan's apply posture; resolves with the mode that was ACTUALLY written. */
export type PersistPlanFn = (plan: OnboardingPlanKey) => Promise<OnboardingProductMode>;

/**
 * THE PRO HANDOFF SEAM — the entire boundary between this module and the browser.
 *
 * It carries a URL out and nothing back, deliberately. The TUI must not build the waitlist URL: there
 * is ONE Pro destination and `src/cli/commands/pro.ts` owns it (origin resolution, `COMPACTION_PRO_URL`
 * / `COMPACTION_WEB_ORIGIN` overrides, the `/waitlist?plan=pro` route). A second builder here would be
 * a second Pro path — the exact thing this option is not allowed to become.
 *
 * There is no success/failure result because there is no truthful one to report: the open is
 * fire-and-forget and the signup completes in the browser, out of this process's sight. The screen
 * therefore treats "opened" and "did not open" identically — it shows the link either way.
 *
 * Injected rather than imported so the plan option is offered only where the handoff can actually be
 * performed, matching how Community is gated on `onCommunityAuth`.
 */
export type OpenWaitlistFn = () => Promise<string>;

/** The onboarding outcome handed back to init.ts (same contract shape init.ts already consumes). */
export interface OnboardingResult {
  completed: boolean;
  quit: boolean;
  enabled: ReadyToolKey[];
  failed: ReadyToolKey[];
  mode: OptimizationModeKey;
}

const BLUE = "#3231cd";
const ACCENT = "#6666ff";
const DIM = "gray";
const NARROW_MIN = 44;

type Screen = "target" | "plan" | "setup" | "license" | "auth" | "waitlist" | "ready";

/**
 * What the activation screen is currently showing. `failed` is a real STATE, not a transient message:
 * the user stays there with a choice (retry / continue on Open / quit) rather than being dropped into
 * a ready screen that would have to lie about what happened.
 */
type AuthPhase =
  | { kind: "starting" }
  | { kind: "awaiting-browser"; userCode: string; verificationUri: string }
  | { kind: "polling"; userCode: string; verificationUri: string }
  | { kind: "provisioning"; step: "lease" | "engine" }
  | { kind: "failed"; reason: OnboardingAuthFailureReason; serviceStatus?: number };

// ---------------------------------------------------------------------------
// Target, select detected workflows (read-only; writes nothing). Rows come from
// the shared discovery model so state (found/ready/not-found) is honest and a
// not-found workflow can never be selected.
// ---------------------------------------------------------------------------
function TargetScreen({
  version,
  discovery,
  selection,
  cursor,
  maxWidth,
  compact
}: {
  version: string;
  discovery: WorkflowDiscovery[];
  selection: ReadonlySet<ReadyToolKey>;
  cursor: number;
  maxWidth: number;
  compact: boolean;
}): React.ReactElement {
  const allDetectedSelected = discovery
    .filter((workflow) => workflow.state !== "not-found")
    .every((workflow) => selection.has(workflow.key));
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <WelcomeHeader version={version} maxWidth={maxWidth} color={ACCENT} compact={compact} />
      <Box marginTop={1} flexDirection="column">
        <Text color="white">{ONBOARDING_TARGET_HEADER}</Text>
        <Text color={DIM}>{ONBOARDING_TARGET_READONLY}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {discovery.map((w, i) => {
          const tool = findOnboardingTool(w.key);
          const active = i === cursor;
          const selectable = w.state !== "not-found";
          const stateWord = w.state === "ready" ? "ready" : w.state === "found" ? "detected" : "not found";
          const title = tool?.title ?? w.title;
          const marker = selectable ? (selection.has(w.key) ? "[x]" : "[ ]") : "[-]";
          return (
            <Text key={w.key} color={active ? ACCENT : selectable ? "white" : DIM} bold={active}>
              {`${active ? "› " : "  "}${marker} ${title}  · ${stateWord}${tool ? `  · ${tool.selectionSummary}` : ""}`}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={DIM}>
          {`↑/↓ Move   Space Select/deselect   Enter ${allDetectedSelected ? "Continue with all detected" : `Continue with ${selection.size} selected`}   Esc Exit`}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Waitlist - the Pro handoff. Renders only; the browser open is the injected
// seam. Reached AFTER the enable has already written the Open floor, so this
// screen is never the difference between a working setup and a broken one.
// ---------------------------------------------------------------------------
function WaitlistScreen({ url }: { url: string }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color="white" bold>{ONBOARDING_PRO_WAITLIST_HEADLINE}</Text>
      <Box marginTop={1} flexDirection="column">
        {onboardingProWaitlistLines(url).map((l, i) => (
          <Text key={i} color={l.startsWith("Opening: ") ? ACCENT : DIM}>{l === "" ? " " : l}</Text>
        ))}
      </Box>
      <Box marginTop={1}><Text color={DIM}>Enter Continue   O Open waitlist again   Esc Exit</Text></Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Plan - the open-core choice ("authorize" in the canonical flow). THREE
// options: Open and Community provision, Pro hands off to the waitlist. Enter
// is the first-write confirmation. Each option states its exact effects before
// it can be chosen, because Open
// persists a mode that attaches an instruction before generation - and because
// Pro must not be mistaken for a purchase.
// ---------------------------------------------------------------------------
function PlanScreen({
  planIndex,
  recommendedPlan,
  signedIn,
  communityAuthorized,
  selectedTools,
  plans = ONBOARDING_PLAN_OPTIONS
}: {
  planIndex: number;
  recommendedPlan: OnboardingPlanKey;
  signedIn: boolean;
  /** Valid Community lease on this device — distinct from mere identity (credentials present). */
  communityAuthorized: boolean;
  selectedTools: readonly string[];
  plans?: readonly (typeof ONBOARDING_PLAN_OPTIONS)[number][];
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color="white" bold>{ONBOARDING_PLAN_HEADER}</Text>
      <Box marginTop={1} flexDirection="column">
        {ONBOARDING_PLAN_SUBLINES.map((l) => (
          <Text key={l} color={DIM}>{l}</Text>
        ))}
        <Text color={DIM}>{`Selected: ${selectedTools.join(", ")}`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {plans.map((p, i) => {
          const active = i === planIndex;
          return (
            <Box key={p.key} flexDirection="column">
              <Text color={active ? ACCENT : DIM} bold={active}>
                {`${active ? "› " : "  "}${p.title}${p.key === "pro" ? " · waitlist" : ""}${p.key === recommendedPlan ? "  (recommended)" : ""}${p.key === "community" && communityAuthorized ? "  · Community active" : p.key === "community" && signedIn ? "  · signed in" : ""}  ${p.summary}`}
              </Text>
              {p.details?.map((detail) => (
                <Text key={detail} color={active ? ACCENT : DIM}>{`     ${detail}`}</Text>
              ))}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={DIM}>
          {`↑/↓ Choose   Enter ${plans[planIndex]?.key === "pro" ? "Join Pro waitlist" : `Set up ${plans[planIndex]?.title ?? "plan"} for ${selectedTools.length} selected ${selectedTools.length === 1 ? "tool" : "tools"}`}   ← Back   Esc Exit`}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Auth - Community activation. The component OWNS NO I/O: it calls the injected
// `onCommunityAuth` and renders the content-free progress it reports back. The
// verification URL and code are rendered HERE because a browser open silently
// no-ops on a headless/SSH shell, and because the alt screen would swallow
// anything printed underneath this frame.
// ---------------------------------------------------------------------------
function AuthScreen({ phase }: { phase: AuthPhase }): React.ReactElement {
  if (phase.kind === "failed") {
    const { headline, detail } = onboardingAuthFailureLines(phase.reason, phase.serviceStatus);
    return (
      <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
        <Text color="yellow" bold>{headline}</Text>
        <Box marginTop={1}><Text color="white">{detail}</Text></Box>
        <Box marginTop={1} flexDirection="column">
          {ONBOARDING_AUTH_FALLBACK_LINES.map((l, i) => (
            <Text key={i} color={i === 1 ? "yellow" : DIM}>{l}</Text>
          ))}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={ACCENT}>{"› 1. Try again"}</Text>
          <Text color={ACCENT}>{"  2. Continue on Open"}</Text>
          <Text color={ACCENT}>{"  3. Quit"}</Text>
        </Box>
        <Box marginTop={1}><Text color={DIM}>{"1 retry · 2 continue on Open · 3/q quit"}</Text></Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color="white" bold>Activating your free Community account</Text>
      {phase.kind === "starting" ? (
        <Box marginTop={1}><Text color={ACCENT}>Contacting the Compaction service…</Text></Box>
      ) : phase.kind === "provisioning" ? (
        // The browser half is done. These two lines name the remaining work in product terms; the
        // user is never asked to run either one, and never sees the words "lease" or "root key".
        <Box marginTop={1}>
          <Text color={ACCENT}>
            {phase.step === "lease" ? "Setting up your Community access…" : "Installing the private engine…"}
          </Text>
        </Box>
      ) : (
        <>
          <Box marginTop={1} flexDirection="column">
            <Text color="white">Open this page and confirm:</Text>
            <Text color={ACCENT} bold>{`  ${phase.verificationUri}`}</Text>
            <Text color="white">{`Confirmation code: ${phase.userCode}`}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={DIM}>
              {phase.kind === "polling"
                ? "Waiting for you to confirm in the browser…"
                : "Opening your browser (if it does not open, use the link above)…"}
            </Text>
          </Box>
        </>
      )}
      <Box marginTop={1}><Text color={DIM}>Esc / Ctrl-C to stop and continue on Open</Text></Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Setup - shown after Plan Enter becomes the explicit first-write consent.
// ---------------------------------------------------------------------------
/**
 * The Engine licence step — shown ONLY on the Community path, and only when this device has not
 * already accepted the current agreement version.
 *
 * WHY IT IS ITS OWN SCREEN. Choosing Community is what causes the separately distributed Hybrid
 * Engine to be fetched, and that artifact is licensed rather than sold. Folding the agreement into
 * the plan screen's copy would make acceptance a side effect of pressing Enter on something
 * else; a screen whose only question is the licence cannot be mistaken for anything but consent.
 * The Open path never renders this, and a device that has accepted this version never sees it again.
 */
function LicenseScreen({ url }: { url: string }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color="white" bold>Compaction Engine License Agreement (version {ENGINE_EULA_VERSION})</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="white">Community includes the free Hybrid Engine, which is delivered separately</Text>
        <Text color="white">from this package and licensed under this agreement.</Text>
      </Box>
      <Box marginTop={1}><Text color={ACCENT}>{url}</Text></Box>
      <Box marginTop={1} flexDirection="column">
        {ENGINE_EULA_SUMMARY.map((l, i) => (
          <Text key={i} color={DIM}>- {l}</Text>
        ))}
      </Box>
      <Box marginTop={1}><Text color={ACCENT}>› Accept and continue</Text></Box>
      <Box marginTop={1}><Text color={DIM}>a Accept   ← Back   Esc Exit</Text></Box>
    </Box>
  );
}

function SetupScreen({ selected, plan }: { selected: ReadyToolKey[]; plan: OnboardingPlanKey }): React.ReactElement {
  const hasInputReduction =
    plan === "community" && selected.some((key) => findOnboardingTool(key)?.supportsInputCompaction === true);
  const planLabel = plan === "pro" ? "Pro waitlist · Open setup" : plan === "community" ? "Community" : "Open";
  const capability = hasInputReduction ? "Input + output token reduction" : "Output token reduction";
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color="white" bold>Setting up Compaction</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="white">{`${planLabel} · ${capability}`}</Text>
        <Text color="white">{selected.map((key) => findOnboardingTool(key)?.title ?? key).join(", ")}</Text>
      </Box>
      <Box marginTop={1}><Text color={ACCENT}>Connecting selected tools and verifying setup…</Text></Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Ready - compact actual setup results plus the two follow-up commands.
// ---------------------------------------------------------------------------
function ReadyScreen({
  enabled,
  failed,
  status,
  communityActive,
  chosenPlan,
  fullOptimizationActive,
  shapingReady,
  codexShapingState
}: {
  enabled: ReadyToolKey[];
  failed: ReadyToolKey[];
  status: OnboardingReadyStatus;
  communityActive: boolean;
  chosenPlan: OnboardingPlanKey;
  fullOptimizationActive: boolean;
  shapingReady: readonly ReadyToolKey[];
  codexShapingState?: "active" | "configured" | "not-installed";
}): React.ReactElement {
  const shellActivationPending =
    failed.length === 0 &&
    !status.healthy &&
    status.launcher === "installed · waiting for a new shell (PATH not active yet)";
  const incomplete = failed.length > 0 || (!status.healthy && !shellActivationPending);
  const successful = enabled;
  const failedWithoutConnection = failed.filter((key) => !enabled.includes(key));
  const hasPendingTool =
    successful.some((key) => !shapingReady.includes(key)) || codexShapingState === "configured";
  const hasVerifiedInputTool = successful.some(
    (key) =>
      findOnboardingTool(key)?.supportsInputCompaction === true &&
      shapingReady.includes(key) &&
      (key !== "codex" || codexShapingState === "active")
  );
  const showIllustrativeExamples =
    communityActive &&
    fullOptimizationActive &&
    !incomplete &&
    !shellActivationPending &&
    !hasPendingTool &&
    hasVerifiedInputTool;
  const plan = communityActive
    ? "Community"
    : chosenPlan === "pro"
      ? "Open (Pro waitlist)"
      : "Open";
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color={incomplete ? "yellow" : "green"}>
        {incomplete ? "! " : "✓ "}
        <Text bold>{incomplete ? "Setup incomplete" : "Compaction is ready"}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="white">{communityActive ? "Community active" : `Plan: ${plan}`}</Text>
        {successful.length === 0 ? <Text color="white">Configured: none</Text> : successful.map((key) => (
          <Text key={key} color="white">
            {shellActivationPending && key === "claude-code"
              ? "Claude Code   Output token reduction · new terminal required"
              : onboardingReadyToolLine(key, fullOptimizationActive, shapingReady.includes(key), codexShapingState)}
          </Text>
        ))}
        {failedWithoutConnection.map((key) => (
          <Text key={key} color="yellow">{`${findOnboardingTool(key)?.title ?? key}   Setup incomplete`}</Text>
        ))}
      </Box>
      {!incomplete && successful.includes("codex") && codexShapingState === "configured" ? (
        <Box marginTop={1}><Text color="yellow">{CODEX_TRUST_ONBOARDING_INSTRUCTION}</Text></Box>
      ) : null}
      {failed.length > 0 ? (
        <Box marginTop={1}><Text color="yellow">{`Retry: compaction init --connect ${failed.join(",")}`}</Text></Box>
      ) : null}
      {shellActivationPending ? (
        <Box marginTop={1}><Text color="yellow">Open a new terminal, or reload your shell config.</Text></Box>
      ) : !status.healthy && failed.length === 0 ? (
        <Box marginTop={1}><Text color="yellow">{status.headline}</Text></Box>
      ) : null}
      {status.nextAction && failed.length === 0 && !shellActivationPending ? (
        <Box marginTop={1}><Text color="yellow">{status.nextAction}</Text></Box>
      ) : null}
      {showIllustrativeExamples ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="white">Illustrative examples, not your activity:</Text>
          <Text color={DIM}>Subscription: compaction · input 8,388,356→7,212,095 (−14%) · output 14,393→10,795 (−25%, est.) · +~3.08m</Text>
          <Text color={DIM}>API key: compaction · input 91,472→74,769 (−18%) · output 857→463 (−46%, est.) · −$0.05 (list price)</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text color="white">Use your tools normally.</Text>
        <Text color={DIM}>{"compaction status     Check setup"}</Text>
        <Text color={DIM}>{"compaction activity   See recent results"}</Text>
        <Text color={DIM}>{"compaction init       Reconfigure"}</Text>
        <Text color={DIM}>{"compaction stop       Disable"}</Text>
      </Box>
      <Box marginTop={1}><Text color={DIM}>Enter Finish   Esc Exit</Text></Box>
    </Box>
  );
}

export interface OnboardingAppProps {
  version: string;
  detection: ConnectDetection;
  /** REAL verified ready status, computed by init.ts AFTER enabling (resolve-check + gateway + auth). */
  readyStatusFor: (enabled: ReadyToolKey[], mode: OptimizationModeKey) => Promise<OnboardingReadyStatus>;
  onEnable: EnableFn;
  onPersistMode: PersistModeFn;
  /**
   * Persist the chosen PLAN's open-core posture and report what ACTUALLY persisted. Separate from
   * `onPersistMode` because it writes a different axis (`product_mode`, the apply posture) from the
   * optimization mode. init.ts performs the write; this component only asks for it.
   */
  onPersistPlan: PersistPlanFn;
  /**
   * Community activation. OPTIONAL: when it is absent the Community option is not offered at all,
   * rather than being offered and then failing — a picker must not contain a choice that cannot work.
   */
  onCommunityAuth?: CommunityAuthFn;
  onOpenWaitlist?: OpenWaitlistFn;
  /** Explicit stored choice for a returning device. Fresh devices omit this for a capability default. */
  initialPlan?: OnboardingPlanKey;
  initialOptimizationMode?: OptimizationModeKey;
  initialProductMode?: OnboardingProductMode;
  /** Whether this device is ALREADY signed in (computed by init.ts; a plain boolean, never credentials). */
  signedIn?: boolean;
  /**
   * Whether this device currently holds a VALID Community lease. Distinct from `signedIn`:
   * credentials prove identity only; a verified lease proves authorization. The plan screen must
   * not say "Community active" from identity alone.
   */
  communityAuthorized?: boolean;
  onDone: (result: OnboardingResult) => void;
}

export function App({
  version,
  detection,
  readyStatusFor,
  onEnable,
  onPersistMode,
  onPersistPlan,
  onCommunityAuth,
  onOpenWaitlist,
  initialPlan,
  initialOptimizationMode = "cache-optimize",
  initialProductMode = "observe",
  signedIn = false,
  communityAuthorized = false,
  onDone
}: OnboardingAppProps): React.ReactElement {
  // Onboarding target order (recommended Claude Code first) - NOT the Page-1 discovery order.
  const discovery = useMemo(() => orderedOnboardingDiscovery(deriveDiscovery(detection)), [detection]);
  const { exit } = useApp();
  const { cols, rows } = useTerminalSize();
  const maxWidth = Math.min(cols, FRAME_MAX) - 2;
  const compactHeader = rows < 28;

  // The first selectable discovery row (a not-found row is never a valid initial target).
  const firstSelectable = Math.max(0, discovery.findIndex((d) => d.state !== "not-found"));
  const [screen, setScreen] = useState<Screen>("target");
  const [cursor, setCursor] = useState(firstSelectable);
  const [selection, setSelection] = useState<Set<ReadyToolKey>>(
    () => initialSelection(discovery) as Set<ReadyToolKey>
  );
  const [busy, setBusy] = useState(false);
  const [finalEnabled, setFinalEnabled] = useState<ReadyToolKey[]>([]);
  const [finalFailed, setFinalFailed] = useState<ReadyToolKey[]>([]);
  const [finalStatus, setFinalStatus] = useState<OnboardingReadyStatus | null>(null);
  const [finalShapingReady, setFinalShapingReady] = useState<ReadyToolKey[]>([]);
  const [finalCodexShapingState, setFinalCodexShapingState] = useState<"active" | "configured" | "not-installed" | undefined>();
  const [authPhase, setAuthPhase] = useState<AuthPhase>({ kind: "starting" });
  const [communityActive, setCommunityActive] = useState(
    communityAuthorized && initialPlan === "community" && initialProductMode === "full"
  );
  const [waitlistUrl, setWaitlistUrl] = useState("");
  const finalOptimizationRef = useRef<OptimizationModeKey>(initialOptimizationMode);
  // Held in a ref, not state: aborting must work from the keypress handler without waiting for a
  // re-render, and re-rendering on every abort-controller swap would be pointless churn.
  const authAbortRef = useRef<AbortController | null>(null);
  // The enabled workflows, mirrored in a ref. The activation path is started from the SAME render
  // that sets `finalEnabled`, so the state it closes over is still the pre-update value — reading it
  // there computed the Ready status for an empty selection and headlined a real install as "No
  // workflow was enabled". The ref is written synchronously and is correct at every await point.
  const enabledRef = useRef<ReadyToolKey[]>([]);
  const selectedKeys = discovery.filter((d) => selection.has(d.key)).map((d) => d.key as ReadyToolKey);
  const enableKeys = workflowsToEnable(selection, discovery) as ReadyToolKey[];
  const alreadyReadyKeys = selectedReadyWorkflows(selection, discovery) as ReadyToolKey[];

  // A plan is offered ONLY when the seam that performs it was injected — a picker must never hold a
  // choice that cannot be carried out. Open needs nothing (it is the floor), Community needs the
  // activation implementation, Pro needs the browser handoff.
  const plans = useMemo(
    () =>
      ONBOARDING_PLAN_OPTIONS.filter(
        (p) => (p.key === "community" ? Boolean(onCommunityAuth) : p.key === "pro" ? Boolean(onOpenWaitlist) : true)
      ),
    [onCommunityAuth, onOpenWaitlist]
  );
  const initialRecommendedPlan = recommendedOnboardingPlan(
    discovery.filter((d) => initialSelection(discovery).has(d.key)).map((d) => d.key as ReadyToolKey)
  );
  const initialPlanKey = initialPlan ?? initialRecommendedPlan;
  const [planIndex, setPlanIndex] = useState(() => {
    const index = plans.findIndex((plan) => plan.key === initialPlanKey);
    return index >= 0 ? index : 0;
  });
  const planChoiceExplicitRef = useRef(initialPlan !== undefined);
  const chosenPlan: OnboardingPlanKey = plans[Math.min(planIndex, plans.length - 1)]?.key ?? "open";
  const recommendedPlan = plans.some((plan) => plan.key === recommendedOnboardingPlan(selectedKeys))
    ? recommendedOnboardingPlan(selectedKeys)
    : "open";

  const preserveExistingCommunity =
    chosenPlan === "community" &&
    initialPlan === "community" &&
    communityAuthorized &&
    initialProductMode === "full" &&
    initialOptimizationMode === "cache-context-optimize";

  const quit = (): void => {
    onDone({ completed: false, quit: true, enabled: [], failed: [], mode: defaultOptimizationMode() });
    exit();
  };
  const finish = (): void => {
    onDone({ completed: true, quit: false, enabled: finalEnabled, failed: finalFailed, mode: finalOptimizationRef.current });
    exit();
  };

  const continueFromSelection = (): void => {
    if (selectedKeys.length === 0) return;
    if (!planChoiceExplicitRef.current) {
      const next = plans.findIndex((plan) => plan.key === recommendedPlan);
      setPlanIndex(next >= 0 ? next : 0);
    }
    setScreen("plan");
  };

  /** Compute the REAL verified status and land on the honest end screen. */
  const showReady = async (enabled: ReadyToolKey[], mode = finalOptimizationRef.current): Promise<void> => {
    const status = await readyStatusFor(enabled, mode);
    setFinalStatus(status);
    setBusy(false);
    setScreen("ready");
  };

  // Community starts after the Open fallback is saved. authAbortRef owns one activation attempt;
  // superseded attempts cannot update the screen or credential flow.
  const runCommunityAuth = async (): Promise<void> => {
    if (!onCommunityAuth) return;
    const previous = authAbortRef.current;
    if (previous && !previous.signal.aborted) return;
    previous?.abort();
    const controller = new AbortController();
    authAbortRef.current = controller;
    /** Whether THIS attempt still owns the screen (a replaced attempt must stay silent). */
    const current = (): boolean => authAbortRef.current === controller;
    setAuthPhase({ kind: "starting" });
    setBusy(true);
    let outcome;
    try {
      outcome = await onCommunityAuth((progress: OnboardingAuthProgress) => {
        if (!current()) return;
        setAuthPhase((prev) => {
          if (progress.kind === "awaiting-browser") {
            return { kind: "awaiting-browser", userCode: progress.userCode, verificationUri: progress.verificationUri };
          }
          if (progress.kind === "polling" && prev.kind === "awaiting-browser") {
            return { kind: "polling", userCode: prev.userCode, verificationUri: prev.verificationUri };
          }
          if (progress.kind === "provisioning") return { kind: "provisioning", step: progress.step };
          return prev.kind === "starting" ? { kind: "starting" } : prev;
        });
      }, controller.signal);
    } catch {
      // A throwing implementation must not strand the user on a spinner; it is treated as the same
      // "could not complete" story as any other transport failure.
      outcome = { ok: false as const, reason: "unreachable" as const };
    }
    if (!current()) return; // superseded: the attempt that replaced this one owns the screen
    authAbortRef.current = null;

    if (!outcome.ok) {
      // STAY on this screen with a choice. Dropping to `ready` here would either have to claim
      // Community activated (false) or silently show Open (a downgrade the user never agreed to).
      setAuthPhase({
        kind: "failed",
        reason: outcome.reason,
        ...(outcome.serviceStatus === undefined ? {} : { serviceStatus: outcome.serviceStatus })
      });
      setBusy(false);
      return;
    }
    setCommunityActive(true);
    const finalMode: OptimizationModeKey = outcome.effectiveMode === "full"
      ? "cache-context-optimize"
      : "cache-optimize";
    // Community is the sole capability choice that can upgrade the optimization posture. Keep the
    // Open fallback until activation and its gates have succeeded, then persist both axes together.
    if (finalMode === "cache-context-optimize") {
      await onPersistMode(finalMode, enabledRef.current);
    }
    finalOptimizationRef.current = finalMode;
    await showReady(enabledRef.current, finalMode);
  };

  const doEnable = async (): Promise<void> => {
    setBusy(true);
    const result: EnableResult = enableKeys.length > 0
      ? await onEnable(enableKeys)
      : { connected: [], failed: [], shapingHooksInstalled: [] };
    const enabled = [...new Set([...alreadyReadyKeys, ...result.connected])] as ReadyToolKey[];
    const alreadyReadyShaping = alreadyReadyKeys.filter((key) =>
      key === "claude-code"
        ? detection.claude.hookReady === true
        : key === "cursor"
          ? detection.cursor.hookReady
          : detection.codexHookReady === true
    );
    const shapingReady = [...new Set([...alreadyReadyShaping, ...(result.shapingHooksInstalled ?? [])])] as ReadyToolKey[];
    const codexShapingState = result.codexShapingState ?? (
      alreadyReadyKeys.includes("codex")
        ? detection.codexHookReady === true
          ? "active"
          : detection.codexHooksInstalled === true
            ? "configured"
            : "not-installed"
        : undefined
    );
    enabledRef.current = enabled;
    setFinalEnabled(enabled);
    setFinalFailed(result.failed);
    setFinalShapingReady(shapingReady);
    setFinalCodexShapingState(codexShapingState);

    if (preserveExistingCommunity) {
      // Ready tools are not reinstalled, and an already-authorized device does not start another
      // browser flow. New tools still receive the existing full preference and narrow authorization.
      if (enableKeys.length > 0) await onPersistMode(initialOptimizationMode, enabled);
      setCommunityActive(true);
      finalOptimizationRef.current = initialOptimizationMode;
      await showReady(enabled, initialOptimizationMode);
      return;
    }

    // Fresh Community starts from the usable Open fallback and upgrades only after activation.
    setCommunityActive(false);
    await onPersistMode("cache-optimize", enabled);
    await onPersistPlan(chosenPlan);
    finalOptimizationRef.current = "cache-optimize";
    if (chosenPlan === "community" && onCommunityAuth) {
      setScreen("auth");
      void runCommunityAuth();
      return;
    }
    if (chosenPlan === "pro" && onOpenWaitlist) {
      // ORDER IS LOAD-BEARING: the enable and the Open floor above have already landed. Whatever
      // happens to the browser from here, the user's setup is complete and valid, and the screen
      // says so. A handoff that cannot resolve a URL is not allowed to strand the run either — it
      // falls through to Ready rather than showing a screen with nothing to point at.
      const url = await openWaitlist();
      if (url !== "") {
        // RELEASE THE BUSY GUARD. This screen is interactive — retry and continue are keypresses —
        // and the global guard above `useInput` swallows every key while `busy` is set. The
        // activation screen escapes this by handling its keys ahead of the guard; this one has no
        // reason to, so it simply stops being busy. (The enable it was covering is finished: the
        // installers ran, the mode and the Open floor are on disk.)
        setBusy(false);
        setScreen("waitlist");
        return;
      }
    }
    await showReady(enabled);
  };

  /**
   * Perform the Pro handoff and return the URL it used ("" if it could not be resolved). Safe to call
   * repeatedly — that IS the retry path, and each call is one more browser open and nothing else. No
   * local state is written here and no entitlement is issued; the only effect is the user's own
   * navigation.
   */
  const openWaitlist = async (): Promise<string> => {
    if (!onOpenWaitlist) return "";
    try {
      const url = (await onOpenWaitlist()).trim();
      if (url !== "") setWaitlistUrl(url);
      return url;
    } catch {
      // The handoff is never a reason to fail a setup that has already succeeded.
      return "";
    }
  };

  useInput((input, key) => {
    // ACTIVATION owns its own keys, INCLUDING q/Ctrl-C, and is reachable while `busy`. The approval
    // poll can run for ten minutes; if the global busy-guard swallowed keys here, both quit and
    // Ctrl-C would be dead for that whole time. Ctrl-C must ABORT the poll rather than unmount, or
    // the request keeps running with nothing left to receive it.
    if (screen === "auth") {
      if (authPhase.kind === "failed") {
        if (input === "1") {
          void runCommunityAuth();
        } else if (input === "2") {
          setBusy(true);
          void showReady(enabledRef.current);
        } else if (input === "3" || input === "q" || (key.ctrl && input === "c")) {
          finish();
        }
        return;
      }
      if (key.escape || input === "q" || (key.ctrl && input === "c")) authAbortRef.current?.abort();
      return;
    }

    if (busy) return;
    if (input === "q" || (key.ctrl && input === "c")) {
      // WAITLIST COUNTS AS DONE. By the time this screen renders, `doEnable` has already installed the
      // workflow, persisted the mode and the Open floor, and filled `finalEnabled` — the screen itself
      // opens with "Your setup is already complete". Routing `q` here to `quit()` reported
      // `completed: false, enabled: []`, so the run ended by telling the user no workflow was enabled,
      // contradicting the line directly above their cursor and hiding work that is on disk. The Pro
      // handoff is a browser tab, not a step of the setup: leaving it is finishing, exactly as it is on
      // `ready`, where `2 / Return` from this same screen would have taken them anyway.
      if (screen === "ready" || screen === "waitlist") finish();
      else quit();
      return;
    }

    if (screen === "target") {
      const selectableIndexes = discovery.map((d, i) => (d.state !== "not-found" ? i : -1)).filter((i) => i >= 0);
      if (key.upArrow || input === "k") {
        setCursor((c) => {
          const pos = selectableIndexes.indexOf(c);
          const next = selectableIndexes[(pos - 1 + selectableIndexes.length) % selectableIndexes.length];
          return next ?? c;
        });
      } else if (key.downArrow || input === "j") {
        setCursor((c) => {
          const pos = selectableIndexes.indexOf(c);
          const next = selectableIndexes[(pos + 1) % selectableIndexes.length];
          return next ?? c;
        });
      } else if (input === " ") {
        const keyAtCursor = discovery[cursor]?.key;
        if (keyAtCursor) setSelection((current) => toggleSelection(current, keyAtCursor, discovery) as Set<ReadyToolKey>);
      } else if (key.return) {
        continueFromSelection();
      } else if (key.escape) {
        quit();
      }
      return;
    }

    if (screen === "plan") {
      if (key.escape) quit();
      else if (key.leftArrow) setScreen("target");
      else if (key.upArrow || input === "k") {
        planChoiceExplicitRef.current = true;
        setPlanIndex((i) => (i - 1 + plans.length) % plans.length);
      } else if (key.downArrow || input === "j") {
        planChoiceExplicitRef.current = true;
        setPlanIndex((i) => (i + 1) % plans.length);
      } else if (input >= "1" && input <= String(plans.length)) {
        planChoiceExplicitRef.current = true;
        setPlanIndex(Number(input) - 1);
      }
      else if (key.return) {
        // THE LICENCE GATE, and it sits BEFORE the writes rather than after. Choosing Community is
        // what causes the separately distributed Engine to be fetched, so the agreement is presented
        // while nothing has happened yet and going back is free. A device that already accepted this
        // version is not asked again, and the Open path never reaches this branch.
        if (chosenPlan === "community" && onCommunityAuth && !preserveExistingCommunity && !engineEulaAccepted()) setScreen("license");
        else {
          setScreen("setup");
          void doEnable();
        }
      }
      return;
    }

    if (screen === "license") {
      if (key.escape) quit();
      else if (key.leftArrow) setScreen("plan");
      // ENTER DELIBERATELY DOES NOTHING HERE. Enter is the key this flow has trained the user to
      // press on every preceding screen, so accepting on Enter would make agreement to a licence the
      // side effect of continuing — the exact thing a dedicated screen exists to prevent. `a` is the
      // only affordance the screen advertises, and it is the only one that accepts. This mirrors the
      // CLI prompt, which takes a literal "yes" and nothing shorter.
      else if (input === "a" || input === "A") {
        // RECORDED BEFORE THE ACQUISITION RUNS. `doEnable` reaches `ensureCommunityRuntime`, whose
        // engine step now refuses on an unaccepted agreement; writing the record first is what turns
        // this keypress into the thing that lets the acquisition continue.
        recordEngineEulaAcceptance();
        setScreen("setup");
        void doEnable();
      }
      return;
    }

    if (screen === "waitlist") {
      if (input === "o" || input === "O") void openWaitlist();
      else if (key.return) {
        setBusy(true);
        void showReady(enabledRef.current);
      } else if (key.escape) {
        finish();
      }
      return;
    }

    if (screen === "ready") {
      if (key.return || key.escape) finish();
    }
  });

  if (cols < NARROW_MIN) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
        <Text color={BLUE} bold>COMPACTION</Text>
        <Text color={DIM}>Terminal too narrow - widen the window, or run `compaction init --static`.</Text>
        <Text color={DIM}>(q / Esc to quit)</Text>
      </Box>
    );
  }

  if (screen === "target") return <TargetScreen version={version} discovery={discovery} selection={selection} cursor={cursor} maxWidth={maxWidth} compact={compactHeader} />;
  if (screen === "plan") {
    return (
      <PlanScreen
        planIndex={Math.min(planIndex, plans.length - 1)}
        recommendedPlan={recommendedPlan}
        signedIn={signedIn}
        communityAuthorized={communityAuthorized}
        selectedTools={selectedKeys.map((key) => findOnboardingTool(key)?.title ?? key)}
        plans={plans}
      />
    );
  }
  if (screen === "setup") return <SetupScreen selected={selectedKeys} plan={chosenPlan} />;
  if (screen === "license") return <LicenseScreen url={engineEulaUrl()} />;
  if (screen === "auth") return <AuthScreen phase={authPhase} />;
  if (screen === "waitlist") return <WaitlistScreen url={waitlistUrl} />;
  return (
    <ReadyScreen
      enabled={finalEnabled}
      failed={finalFailed}
      status={finalStatus ?? { healthy: false, headline: "Setup incomplete", launcher: "unknown", gateway: "unknown", auth: "unknown" }}
      communityActive={communityActive}
      chosenPlan={chosenPlan}
      fullOptimizationActive={communityActive && finalOptimizationRef.current === "cache-context-optimize"}
      shapingReady={finalShapingReady}
      codexShapingState={finalCodexShapingState}
    />
  );
}

const ALT_SCREEN_ENTER = "[?1049h[H[2J";
const ALT_SCREEN_LEAVE = "[?1049l";

/**
 * Render the production onboarding flow and resolve with the ACTUAL end state. Enable/persist go
 * through the injected callbacks (the SAME real engine the headless surface uses), so init.ts
 * re-prints the durable Ready summary from `result` - the alt-screen is wiped on exit.
 */
export async function runOnboardingTui(deps: {
  version: string;
  detection: ConnectDetection;
  readyStatusFor: (enabled: ReadyToolKey[], mode: OptimizationModeKey) => Promise<OnboardingReadyStatus>;
  onEnable: EnableFn;
  onPersistMode: PersistModeFn;
  onPersistPlan: PersistPlanFn;
  onCommunityAuth?: CommunityAuthFn;
  onOpenWaitlist?: OpenWaitlistFn;
  initialPlan?: OnboardingPlanKey;
  initialOptimizationMode?: OptimizationModeKey;
  initialProductMode?: OnboardingProductMode;
  signedIn?: boolean;
  /** Valid Community lease on this device (distinct from signedIn identity). */
  communityAuthorized?: boolean;
}): Promise<OnboardingResult> {
  const out = process.stdout;
  const useAlt = Boolean(out.isTTY);
  if (useAlt) out.write(ALT_SCREEN_ENTER);
  let result: OnboardingResult = { completed: false, quit: true, enabled: [], failed: [], mode: defaultOptimizationMode() };
  try {
    const app = render(
      <App
        version={deps.version}
        detection={deps.detection}
        readyStatusFor={deps.readyStatusFor}
        onEnable={deps.onEnable}
        onPersistMode={deps.onPersistMode}
        onPersistPlan={deps.onPersistPlan}
        {...(deps.onCommunityAuth ? { onCommunityAuth: deps.onCommunityAuth } : {})}
        {...(deps.onOpenWaitlist ? { onOpenWaitlist: deps.onOpenWaitlist } : {})}
        {...(deps.initialPlan ? { initialPlan: deps.initialPlan } : {})}
        initialOptimizationMode={deps.initialOptimizationMode ?? "cache-optimize"}
        initialProductMode={deps.initialProductMode ?? "observe"}
        signedIn={deps.signedIn ?? false}
        communityAuthorized={deps.communityAuthorized ?? false}
        onDone={(r) => {
          result = r;
        }}
      />
    );
    await app.waitUntilExit();
  } finally {
    if (useAlt) out.write(ALT_SCREEN_LEAVE);
  }
  // Fallback: the no-data metric line is the honest default if nothing else was set.
  if (!result.mode) result.mode = defaultOptimizationMode();
  return result;
}
