import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import {
  ONBOARDING_TOOLS,
  ONBOARDING_TARGET_HEADER,
  ONBOARDING_TARGET_READONLY,
  ONBOARDING_MODE_OPTIONS,
  onboardingModeOptions,
  type OnboardingModeOption,
  onboardingModeHeader,
  onboardingModeSublines,
  ONBOARDING_PLAN_OPTIONS,
  ONBOARDING_PLAN_HEADER,
  ONBOARDING_PLAN_SUBLINES,
  ONBOARDING_PRO_WAITLIST_HEADLINE,
  onboardingProWaitlistLines,
  ONBOARDING_AUTH_FALLBACK_LINES,
  onboardingAuthFailureLines,
  onboardingLimitedLines,
  onboardingReviewContent,
  onboardingUncoveredWorkflowsLine,
  onboardingModeToOptimizationKey,
  findOnboardingTool,
  orderedOnboardingDiscovery,
  deriveDiscovery,
  buildReadySummaryLines,
  deriveReadyRouting,
  defaultOptimizationMode,
  isLocalFullApplyGateReason,
  READY_HEADER,
  FULL_APPLY_REQUIREMENT_LINE,
  type ConnectDetection,
  type WorkflowDiscovery,
  type ReadyToolKey,
  type EnableResult,
  type OptimizationModeKey,
  type OnboardingReadyStatus,
  type ReadyRoutingInputs,
  type OnboardingPlanKey,
  type OnboardingHookDisclosure,
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
import { READY_METRIC_NO_DATA_LINE, readyPerTurnLinesForTools, type ReadyMetric } from "./ready-metrics.js";
import { WelcomeHeader, FRAME_MAX, useTerminalSize } from "./WelcomeHeader.js";

/**
 * Production interactive onboarding for `compaction init` (Ink/React). It walks a real user
 * through the reframed flow, pick a detected workflow (target) → choose how Compaction optimizes
 * Claude Code (mode) or see the honest limited state for Codex/Cursor → review the exact real
 * effects → run the REAL installers → an honest ready screen with a REAL measured metric (or the
 * "unavailable until measured" state).
 *
 * ARCHITECTURE (what keeps this testable + honest):
 *  - Detection (`ConnectDetection`), the routing/cache-proof inputs (`ReadyRoutingInputs`), the
 *    verified ready STATUS (`OnboardingReadyStatus`), and the honest METRIC (`ReadyMetric`) are all
 *    computed by init.ts from REAL local state and injected, this component invents none of them.
 *  - Every write routes through the SAME injected callbacks the static/headless surfaces use:
 *    `onEnable` (production wraps the real installers; tests pass a fake) runs ONLY on the explicit
 *    review "Enable" consent; `onPersistMode` (production wraps `writeOptimizationMode` + narrow
 *    authorizations) runs on the same consent.
 *  - Discovery, target, mode, and review screens write NOTHING. Enabling is the first write.
 *  - The metric is NEVER a simulated number: it is the injected `ReadyMetric`, which is `no-data`
 *    ("run a session to see your delta") at first install and a measured count only from receipts.
 *
 * Invariants: no network call or credential read; nothing is written until the review Enable
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

type Screen = "target" | "limited" | "mode" | "plan" | "review" | "license" | "auth" | "waitlist" | "ready";

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

/** Honest colour for a discovery state: green = ready/active, yellow = found (enable available), dim = not found. */
function stateColor(state: WorkflowDiscovery["state"]): string {
  return state === "ready" ? "green" : state === "found" ? "yellow" : DIM;
}

// ---------------------------------------------------------------------------
// Target, pick a detected workflow (read-only; writes nothing). Rows come from
// the shared discovery model so state (found/ready/not-found) is honest and a
// not-found workflow can never be selected.
// ---------------------------------------------------------------------------
function TargetScreen({
  version,
  discovery,
  cursor,
  maxWidth,
  compact
}: {
  version: string;
  discovery: WorkflowDiscovery[];
  cursor: number;
  maxWidth: number;
  compact: boolean;
}): React.ReactElement {
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
          return (
            <Box key={w.key} flexDirection="column">
              <Box>
                <Text color={active ? ACCENT : DIM}>{active ? "› " : "  "}</Text>
                <Text color={active ? ACCENT : selectable ? "white" : DIM} bold={active}>
                  {`${i + 1}. ${title}`}
                </Text>
                <Text color={stateColor(w.state)}>{`  · ${stateWord}`}</Text>
                {tool ? <Text color={DIM}>{`  · ${tool.availabilityTag}`}</Text> : null}
              </Box>
              {active && tool ? <Text color={DIM}>{`     ${tool.capability}`}</Text> : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={DIM}>{"↑/↓ move · 1/2/3 · Enter continue · q quit"}</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Limited - the honest per-tool/per-auth summary for a non-Claude workflow
// (Codex/Cursor). It is a FORWARD STEP, not a terminal screen: the user reads
// what this tool can and cannot get, then CONTINUES to configure it. It used to
// offer only "Press Enter to go back", which made setup unreachable for anyone
// whose current workflow was Codex or Cursor. Writes nothing.
// ---------------------------------------------------------------------------
function LimitedScreen({
  target,
  fullOptimizationReachable
}: {
  target: ReadyToolKey;
  fullOptimizationReachable: boolean;
}): React.ReactElement {
  const tool = findOnboardingTool(target);
  const lines = onboardingLimitedLines(target, fullOptimizationReachable);
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color="white" bold>{tool?.title ?? target}</Text>
      <Box marginTop={1} flexDirection="column">
        {lines.map((l, i) => (
          <Text key={i} color={i === 0 ? "white" : DIM}>{l}</Text>
        ))}
      </Box>
      <Box marginTop={1}><Text color={ACCENT}>{`› Continue setting up ${tool?.title ?? target}`}</Text></Box>
      <Box marginTop={1}><Text color={DIM}>Enter continue · ←/Esc back to the workflow list · q quit</Text></Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Mode - how Compaction optimizes Claude Code (output-only default / full).
// Writes nothing here; the write is the review Enable consent.
// ---------------------------------------------------------------------------
function ModeScreen({
  target,
  modeIndex,
  modes,
  unavailable
}: {
  /** The workflow being configured — the header and the auth sub-line are per-tool, never Claude's. */
  target: ReadyToolKey;
  modeIndex: number;
  modes: OnboardingModeOption[];
  /** Modes this build cannot deliver — shown as a reason line so they are not silently missing. */
  unavailable: OnboardingModeOption[];
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color="white" bold>{onboardingModeHeader(target)}</Text>
      <Box marginTop={1} flexDirection="column">
        {onboardingModeSublines(target).map((l) => (
          <Text key={l} color={DIM}>{l}</Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {modes.map((m, i) => {
          const active = i === modeIndex;
          return (
            <Box key={m.key} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={active ? ACCENT : DIM}>{active ? "› " : "  "}</Text>
                <Text color={active ? "white" : DIM} bold={active}>{`${i + 1}. ${m.title}`}</Text>
                <Text color={m.recommended ? "green" : DIM}>{m.recommended ? "  (recommended · default)" : "  (opt-in)"}</Text>
              </Box>
              <Box paddingLeft={5}>
                <Text color={active ? ACCENT : DIM}>{m.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      {unavailable.map((m) => (
        <Box key={m.key} paddingLeft={1} marginBottom={1}>
          <Text color={DIM}>{`${m.title}: ${m.description}`}</Text>
        </Box>
      ))}
      <Box marginTop={1}><Text color={DIM}>{"↑/↓ · 1/2 · Enter continue · ←/Esc back · q quit"}</Text></Box>
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
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Plan - the open-core choice ("authorize" in the canonical flow). THREE
// options: Open and Community provision, Pro hands off to the waitlist. Writes
// nothing: the write is the review Enable consent on the next screen. Each
// option states its exact effects BEFORE it can be chosen, because Open
// persists a mode that attaches an instruction before generation - and because
// Pro must not be mistaken for a purchase.
// ---------------------------------------------------------------------------
function PlanScreen({
  planIndex,
  signedIn,
  plans = ONBOARDING_PLAN_OPTIONS
}: {
  planIndex: number;
  signedIn: boolean;
  plans?: readonly (typeof ONBOARDING_PLAN_OPTIONS)[number][];
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color="white" bold>{ONBOARDING_PLAN_HEADER}</Text>
      <Box marginTop={1} flexDirection="column">
        {ONBOARDING_PLAN_SUBLINES.map((l) => (
          <Text key={l} color={DIM}>{l}</Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {plans.map((p, i) => {
          const active = i === planIndex;
          return (
            <Box key={p.key} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={active ? ACCENT : DIM}>{active ? "› " : "  "}</Text>
                <Text color={active ? "white" : DIM} bold={active}>{`${i + 1}. ${p.title}`}</Text>
                <Text color={DIM}>{`  · ${p.summary}`}</Text>
                {p.recommended ? <Text color="green">{"  (recommended)"}</Text> : null}
                {p.key === "community" && signedIn ? <Text color="green">{"  · already signed in"}</Text> : null}
              </Box>
              {active
                ? p.effects.map((e, j) => (
                    <Box key={j} paddingLeft={5}>
                      <Text color={ACCENT}>{e}</Text>
                    </Box>
                  ))
                : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={DIM}>
          {`↑/↓ · ${plans.map((_, i) => i + 1).join("/")} · Enter continue · ←/Esc back · q quit`}
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
// Review - the exact real effects of enabling (installers, PATH, on-demand
// gateway, mode memory). Enter is the FIRST write (the enable consent).
// ---------------------------------------------------------------------------
/**
 * The Engine licence step — shown ONLY on the Community path, and only when this device has not
 * already accepted the current agreement version.
 *
 * WHY IT IS ITS OWN SCREEN. Choosing Community is what causes the separately distributed Hybrid
 * Engine to be fetched, and that artifact is licensed rather than sold. Folding the agreement into
 * the review screen's fine print would make acceptance a side effect of pressing Enter on something
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
      <Box marginTop={1}><Text color={DIM}>a accept · ←/Esc back · q quit</Text></Box>
    </Box>
  );
}

function ReviewScreen({
  target,
  modeKey,
  plan,
  hooks,
  busy
}: {
  target: ReadyToolKey;
  modeKey: "full" | "output";
  plan: OnboardingPlanKey;
  /** The hook config this enable will write (Codex/Cursor), or undefined when none will be written. */
  hooks?: OnboardingHookDisclosure;
  busy: boolean;
}): React.ReactElement {
  // The chosen plan AND every file this enable writes come from the ONE shared model, so the screen
  // cannot describe a smaller write than the one that follows. Region-splitting is structural (headline
  // / effects / boundaries) rather than index-based, so adding an effect can never silently push a
  // boundary line into the effects list.
  const content = onboardingReviewContent(target, modeKey, { plan, ...(hooks ? { hooks } : {}) });
  if (busy) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
        <Text color="white" bold>Setting up {findOnboardingTool(target)?.title ?? target}</Text>
        <Box marginTop={1}><Text color={ACCENT}>Installing the reversible launcher, configuring PATH, verifying…</Text></Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color="white" bold>{content.headline}</Text>
      <Box marginTop={1} flexDirection="column">
        {content.bullets.map((l, i) => (
          <Text key={i} color="white">{l}</Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {content.notes.map((l, i) => (
          <Text key={i} color={DIM}>{l}</Text>
        ))}
      </Box>
      <Box marginTop={1}><Text color={ACCENT}>› Enable Compaction</Text></Box>
      <Box marginTop={1}><Text color={DIM}>Enter enable · ←/Esc back · q quit</Text></Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Ready - the honest end state. The setup rows come from REAL verified status
// (OnboardingReadyStatus); the metric line is the REAL injected ReadyMetric
// (never a simulated number); the Ready summary reuses the shared model.
// ---------------------------------------------------------------------------
function ReadyScreen({
  enabled,
  discovery,
  mode,
  status,
  metric,
  readyRouting,
  shapingHooksInstalled,
  productMode,
  communityActive,
  fullApplyPendingReason
}: {
  enabled: ReadyToolKey[];
  /** The REAL detection rows, so the "one workflow was configured" line names actual other workflows. */
  discovery: WorkflowDiscovery[];
  mode: OptimizationModeKey;
  status: OnboardingReadyStatus;
  metric: ReadyMetric;
  readyRouting?: ReadyRoutingInputs;
  /**
   * The workflows whose native hooks the enable CONFIRMED on disk. Passed separately from
   * `readyRouting` (which carries the same set) because the per-turn block must follow it even when
   * there are no routing inputs at all — otherwise "no routing inputs" would silently become
   * "the hook is installed".
   */
  shapingHooksInstalled: readonly ReadyToolKey[];
  /** The posture that ACTUALLY persisted (never the one that was requested). */
  productMode: OnboardingProductMode;
  communityActive: boolean;
  fullApplyPendingReason?: string;
}): React.ReactElement {
  const routing = readyRouting ? deriveReadyRouting(enabled, readyRouting) : undefined;
  const summary = buildReadySummaryLines(enabled, mode, routing);
  // ONE target was configured. Automatic shaping covers that workflow and no other, so any other
  // detected workflow is named here rather than left to be inferred from silence.
  const uncovered = enabled.length > 0 ? onboardingUncoveredWorkflowsLine(discovery, enabled) : undefined;
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color={status.healthy ? "green" : "yellow"}>
        {status.healthy ? "✓ " : "! "}
        <Text bold>{status.headline}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="white">{`Launcher   ${status.launcher}`}</Text>
        <Text color="white">{`Gateway    ${status.gateway}`}</Text>
        <Text color="white">{`Auth       ${status.auth}`}</Text>
      </Box>
      {status.nextAction ? (
        <Box marginTop={1}><Text color="yellow">{status.nextAction}</Text></Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text color="white">
          {`Plan       ${communityActive ? "Community (free account, this device registered)" : "Open (no account)"}`}
        </Text>
        <Text color="white">
          {`Per turn   ${productMode === "full" ? "full apply" : productMode === "basic" ? "basic shaping" : "apply off"}`}
        </Text>
        {communityActive && productMode !== "full" ? (
          <Text color="yellow">
            {`Full apply is not active on this device yet${fullApplyPendingReason ? ` (${fullApplyPendingReason})` : ""}; you are on Open shaping.`}
          </Text>
        ) : null}
        {communityActive && productMode !== "full" && isLocalFullApplyGateReason(fullApplyPendingReason) ? (
          <Text color={DIM}>{FULL_APPLY_REQUIREMENT_LINE}</Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={DIM}>
          {metric.state === "no-data" ? "Measured activity (none yet)" : "Measured activity (from your local receipts)"}
        </Text>
        <Text color={metric.state === "no-data" ? DIM : ACCENT}>{metric.line}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {readyPerTurnLinesForTools(enabled, shapingHooksInstalled).map((l, i) => (
          <Text key={i} color={DIM}>{l}</Text>
        ))}
      </Box>
      {summary.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {summary.map((l, i) => (
            <Text key={i} color={l === READY_HEADER ? "white" : DIM} bold={l === READY_HEADER}>{l}</Text>
          ))}
        </Box>
      ) : (
        <Box marginTop={1}><Text color={DIM}>No workflow was enabled. Re-run `compaction` anytime to enable one.</Text></Box>
      )}
      {uncovered ? (
        <Box marginTop={1}><Text color="yellow">{uncovered}</Text></Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text color={DIM}>{"compaction status     setup and routing health"}</Text>
        <Text color={DIM}>{"compaction activity   recent runs"}</Text>
        <Text color={DIM}>{"compaction init       reconfigure later"}</Text>
      </Box>
      <Box marginTop={1}><Text color={DIM}>Enter / q to finish</Text></Box>
    </Box>
  );
}

export interface OnboardingAppProps {
  version: string;
  detection: ConnectDetection;
  readyRouting?: ReadyRoutingInputs;
  /** REAL verified ready status, computed by init.ts AFTER enabling (resolve-check + gateway + auth). */
  readyStatusFor: (enabled: ReadyToolKey[], mode: OptimizationModeKey) => Promise<OnboardingReadyStatus>;
  /** REAL honest metric, computed by init.ts from the local activity receipts (never simulated). */
  readyMetric: ReadyMetric;
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
  /**
   * Whether the adaptive engine could actually run for this user (computed by init.ts from
   * `core/engine-availability.ts`). DEFAULT true so existing callers/tests are unchanged. When
   * false, "Full optimization" is not selectable: it is named with its reason instead, because
   * choosing it would take an apply authorization for input compaction that cannot happen.
   */
  fullOptimizationReachable?: boolean;
  /** Whether this device is ALREADY signed in (computed by init.ts; a plain boolean, never credentials). */
  signedIn?: boolean;
  /**
   * The hook-config write enabling `key` will perform, from the REAL installer (init.ts resolves the
   * path and the entry list; this component never derives them). Returning undefined means NO hook
   * config will be written — because the tool has none, or because output shaping is switched off
   * (`compaction stop` / COMPACTION_SHAPING_HOOKS=0). The review screen states either case explicitly:
   * onboarding must not write a file it never disclosed, and it must not disclose one it will not write.
   */
  hookDisclosure?: (key: ReadyToolKey) => OnboardingHookDisclosure | undefined;
  onDone: (result: OnboardingResult) => void;
}

export function App({
  version,
  detection,
  readyRouting,
  readyStatusFor,
  readyMetric,
  onEnable,
  onPersistMode,
  onPersistPlan,
  onCommunityAuth,
  onOpenWaitlist,
  fullOptimizationReachable = true,
  signedIn = false,
  hookDisclosure,
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
  const [target, setTarget] = useState<ReadyToolKey>(discovery[firstSelectable]?.key ?? "claude-code");
  const [modeIndex, setModeIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [finalEnabled, setFinalEnabled] = useState<ReadyToolKey[]>([]);
  const [finalFailed, setFinalFailed] = useState<ReadyToolKey[]>([]);
  // Which workflows' native shaping hooks the enable CONFIRMED on disk. Held separately from
  // `finalEnabled` because a hook failure must never un-connect the shim, and equally must never let
  // the ready screen describe a shaping effect that is not wired.
  const [shapingHooksInstalled, setShapingHooksInstalled] = useState<ReadyToolKey[]>([]);
  const [finalStatus, setFinalStatus] = useState<OnboardingReadyStatus | null>(null);
  const [planIndex, setPlanIndex] = useState(0);
  const [authPhase, setAuthPhase] = useState<AuthPhase>({ kind: "starting" });
  const [productMode, setProductMode] = useState<OnboardingProductMode>("observe");
  const [communityActive, setCommunityActive] = useState(false);
  const [waitlistUrl, setWaitlistUrl] = useState("");
  const [fullApplyPendingReason, setFullApplyPendingReason] = useState<string | undefined>(undefined);
  // Held in a ref, not state: aborting must work from the keypress handler without waiting for a
  // re-render, and re-rendering on every abort-controller swap would be pointless churn.
  const authAbortRef = useRef<AbortController | null>(null);
  // The enabled workflows, mirrored in a ref. The activation path is started from the SAME render
  // that sets `finalEnabled`, so the state it closes over is still the pre-update value — reading it
  // there computed the Ready status for an empty selection and headlined a real install as "No
  // workflow was enabled". The ref is written synchronously and is correct at every await point.
  const enabledRef = useRef<ReadyToolKey[]>([]);

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
  const chosenPlan: OnboardingPlanKey = plans[Math.min(planIndex, plans.length - 1)]?.key ?? "open";

  // A picker must not contain a choice that cannot work (the same rule the Community plan option
  // follows above). With no engine reachable, "Full optimization" would take a real authorization for
  // input compaction that never runs, so it is not selectable — and it is named in a reason line
  // rather than vanishing, so the capability is not hidden either.
  const modes = useMemo(
    () => onboardingModeOptions(fullOptimizationReachable).filter((m) => m.available !== false),
    [fullOptimizationReachable]
  );
  const unavailableModes = useMemo(
    () => onboardingModeOptions(fullOptimizationReachable).filter((m) => m.available === false),
    [fullOptimizationReachable]
  );
  const chosenModeKey: "full" | "output" = (modes[Math.min(modeIndex, modes.length - 1)] ?? ONBOARDING_MODE_OPTIONS[0]).key;
  const chosenOptimizationKey = onboardingModeToOptimizationKey(chosenModeKey);

  const quit = (): void => {
    onDone({ completed: false, quit: true, enabled: [], failed: [], mode: defaultOptimizationMode() });
    exit();
  };
  const finish = (): void => {
    onDone({ completed: true, quit: false, enabled: finalEnabled, failed: finalFailed, mode: chosenOptimizationKey });
    exit();
  };

  /**
   * THE PER-TARGET ROUTE. Exactly ONE workflow is configured per run — the one the user is currently
   * working in — and every supported target must reach `ready`. No target may end on a screen whose
   * only forward outcome is "go back".
   *
   *   claude-code → mode → plan → review → ready       (unchanged)
   *   codex       → limited → mode → plan → review → ready
   *   cursor      → limited → plan → review → ready
   *
   * Codex keeps the MODE screen because it genuinely has two modes (`supportsFullOptimization: true`)
   * and its own limited copy advertises the API-key/full-optimization path — advertising a choice and
   * then silently persisting one would be worse than showing the picker. Cursor SKIPS it: it is
   * `supportsFullOptimization: false`, so the picker would hold exactly one option, which is not a
   * choice, it is a confirmation dialog wearing a picker's clothes.
   */
  const modeScreenApplies = (key: ReadyToolKey): boolean =>
    findOnboardingTool(key)?.supportsFullOptimization !== false;
  /** Where BACK from the plan screen lands, per target (the exact reverse of the route above). */
  const planBackScreen = (key: ReadyToolKey): Screen =>
    modeScreenApplies(key) ? "mode" : "limited";
  /** Where BACK from the mode screen lands: Claude Code came from the list, others from `limited`. */
  const modeBackScreen = (key: ReadyToolKey): Screen => (key === "claude-code" ? "target" : "limited");

  const pickTarget = (key: ReadyToolKey): void => {
    const row = discovery.find((d) => d.key === key);
    if (!row || row.state === "not-found") return; // not-found is never selectable
    setTarget(key);
    // A target with NO mode picker must not inherit a mode the user chose for a different tool. Picking
    // "Full optimization" for Codex, backing out, and then choosing Cursor left `modeIndex` at 1, so the
    // review read `use "Full optimization" as the default … (the only mode available for Cursor)` and
    // the enable persisted `cache-context-optimize` for a `supportsFullOptimization: false` workflow.
    // The mode index belongs to the screen that is shown; a target that skips it gets the default.
    if (!modeScreenApplies(key)) setModeIndex(0);
    // Claude Code goes straight to its mode picker; Codex/Cursor read the honest per-tool/per-auth
    // summary FIRST (it is a step, not a dead end) and then continue into the same flow.
    setScreen(key === "claude-code" ? "mode" : "limited");
  };

  /** Compute the REAL verified status and land on the honest end screen. */
  const showReady = async (enabled: ReadyToolKey[]): Promise<void> => {
    const status = await readyStatusFor(enabled, chosenOptimizationKey);
    setFinalStatus(status);
    setBusy(false);
    setScreen("ready");
  };

  /**
   * Community activation. Runs AFTER the install and after the Open floor is persisted, so a user who
   * abandons this screen still has a working setup — Open is the honest fallback, never a broken one.
   *
   * EXACTLY ONE ATTEMPT AT A TIME (load-bearing). "Try again" used to overwrite `authAbortRef`
   * without aborting what it replaced: two presses inside one render frame both saw the `failed`
   * phase and both started a device-code flow, so two logins polled and wrote `credentials.json` over
   * each other, and the loser kept running with nothing left to receive it. Three rules close it:
   *  - a press while an attempt is genuinely in flight is IGNORED (the running attempt wins);
   *  - an attempt the user already cancelled is ABORTED before its replacement starts;
   *  - a superseded attempt reports NOTHING — its progress and its outcome are dropped rather than
   *    clobbering the run that replaced it (`authAbortRef` doubles as "who owns this screen").
   */
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
    setProductMode(outcome.effectiveMode);
    setFullApplyPendingReason(outcome.fullApplyPendingReason);
    await showReady(enabledRef.current);
  };

  const doEnable = async (): Promise<void> => {
    setBusy(true);
    // The ONE write path: the real installers (via onEnable), then the optimization mode, then the
    // plan's apply posture. The posture is persisted for BOTH plans before any account step — so a
    // Community user who never finishes the browser confirmation still ends up on the Open floor
    // rather than below it.
    const result = await onEnable([target]);
    await onPersistMode(chosenOptimizationKey, result.connected);
    const persisted = await onPersistPlan(chosenPlan);
    enabledRef.current = result.connected;
    setFinalEnabled(result.connected);
    setFinalFailed(result.failed);
    setShapingHooksInstalled(result.shapingHooksInstalled ?? []);
    setProductMode(persisted);
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
    await showReady(result.connected);
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
      } else if (input >= "1" && input <= String(discovery.length)) {
        const idx = Number(input) - 1;
        if (discovery[idx] && discovery[idx].state !== "not-found") {
          setCursor(idx);
          pickTarget(discovery[idx].key);
        }
      } else if (key.return) {
        pickTarget(discovery[cursor]?.key ?? target);
      }
      return;
    }

    if (screen === "limited") {
      // Enter CONTINUES (this screen is informational, not terminal); ←/Esc is the way back.
      if (key.escape || key.leftArrow) setScreen("target");
      else if (key.return) setScreen(modeScreenApplies(target) ? "mode" : "plan");
      return;
    }

    if (screen === "mode") {
      if (key.escape || key.leftArrow) setScreen(modeBackScreen(target));
      else if (key.upArrow || input === "k") setModeIndex((i) => (i - 1 + modes.length) % modes.length);
      else if (key.downArrow || input === "j") setModeIndex((i) => (i + 1) % modes.length);
      else if (input >= "1" && input <= String(modes.length)) setModeIndex(Number(input) - 1);
      else if (key.return) setScreen("plan");
      return;
    }

    if (screen === "plan") {
      if (key.escape || key.leftArrow) setScreen(planBackScreen(target));
      else if (key.upArrow || input === "k") setPlanIndex((i) => (i - 1 + plans.length) % plans.length);
      else if (key.downArrow || input === "j") setPlanIndex((i) => (i + 1) % plans.length);
      else if (input >= "1" && input <= String(plans.length)) setPlanIndex(Number(input) - 1);
      else if (key.return) setScreen("review");
      return;
    }

    if (screen === "review") {
      if (key.escape || key.leftArrow) setScreen("plan");
      else if (key.return || input === "1") {
        // THE LICENCE GATE, and it sits BEFORE the writes rather than after. Choosing Community is
        // what causes the separately distributed Engine to be fetched, so the agreement is presented
        // while nothing has happened yet and going back is free. A device that already accepted this
        // version is not asked again, and the Open path never reaches this branch.
        if (chosenPlan === "community" && onCommunityAuth && !engineEulaAccepted()) setScreen("license");
        else void doEnable();
      }
      return;
    }

    if (screen === "license") {
      if (key.escape || key.leftArrow) setScreen("review");
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
        void doEnable();
      }
      return;
    }

    if (screen === "waitlist") {
      if (input === "1") void openWaitlist();
      else if (input === "2" || key.return) {
        setBusy(true);
        void showReady(enabledRef.current);
      }
      return;
    }

    if (screen === "ready") {
      if (key.return) finish();
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

  if (screen === "target") return <TargetScreen version={version} discovery={discovery} cursor={cursor} maxWidth={maxWidth} compact={compactHeader} />;
  if (screen === "limited") return <LimitedScreen target={target} fullOptimizationReachable={fullOptimizationReachable} />;
  if (screen === "mode") return <ModeScreen target={target} modeIndex={Math.min(modeIndex, modes.length - 1)} modes={modes} unavailable={unavailableModes} />;
  if (screen === "plan") return <PlanScreen planIndex={Math.min(planIndex, plans.length - 1)} signedIn={signedIn} plans={plans} />;
  if (screen === "review") {
    const hooks = hookDisclosure?.(target);
    return <ReviewScreen target={target} modeKey={chosenModeKey} plan={chosenPlan} {...(hooks ? { hooks } : {})} busy={busy} />;
  }
  if (screen === "license") return <LicenseScreen url={engineEulaUrl()} />;
  if (screen === "auth") return <AuthScreen phase={authPhase} />;
  if (screen === "waitlist") return <WaitlistScreen url={waitlistUrl} />;
  return (
    <ReadyScreen
      enabled={finalEnabled}
      discovery={discovery}
      mode={chosenOptimizationKey}
      status={finalStatus ?? { healthy: false, headline: "Setup incomplete", launcher: "unknown", gateway: "unknown", auth: "unknown" }}
      metric={readyMetric}
      readyRouting={readyRouting ? { ...readyRouting, shapingHooksInstalled } : undefined}
      shapingHooksInstalled={shapingHooksInstalled}
      productMode={productMode}
      communityActive={communityActive}
      {...(fullApplyPendingReason ? { fullApplyPendingReason } : {})}
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
  readyRouting?: ReadyRoutingInputs;
  readyStatusFor: (enabled: ReadyToolKey[], mode: OptimizationModeKey) => Promise<OnboardingReadyStatus>;
  readyMetric: ReadyMetric;
  onEnable: EnableFn;
  onPersistMode: PersistModeFn;
  onPersistPlan: PersistPlanFn;
  onCommunityAuth?: CommunityAuthFn;
  onOpenWaitlist?: OpenWaitlistFn;
  /** Whether the adaptive engine could actually run (init.ts computes it; default true). */
  fullOptimizationReachable?: boolean;
  signedIn?: boolean;
  /** The hook-config write the enable will perform, per target (init.ts resolves it; see the prop). */
  hookDisclosure?: (key: ReadyToolKey) => OnboardingHookDisclosure | undefined;
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
        readyRouting={deps.readyRouting}
        readyStatusFor={deps.readyStatusFor}
        readyMetric={deps.readyMetric}
        onEnable={deps.onEnable}
        onPersistMode={deps.onPersistMode}
        onPersistPlan={deps.onPersistPlan}
        {...(deps.onCommunityAuth ? { onCommunityAuth: deps.onCommunityAuth } : {})}
        {...(deps.onOpenWaitlist ? { onOpenWaitlist: deps.onOpenWaitlist } : {})}
        fullOptimizationReachable={deps.fullOptimizationReachable ?? true}
        signedIn={deps.signedIn ?? false}
        {...(deps.hookDisclosure ? { hookDisclosure: deps.hookDisclosure } : {})}
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

export { READY_METRIC_NO_DATA_LINE };
