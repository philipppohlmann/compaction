import React, { useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import { BRAND_HEX, GATEWAY_PROVIDERS, GATEWAY_MODES, GATEWAY_DEFAULT_LISTEN } from "./model.js";
import { isInputCompactionAvailable } from "../../core/gateway/input-compaction-seam.js";

/**
 * Guided Gateway setup TUI, a sibling of the onboarding stepper (`OnboardingTui`) on the same Ink/React stack.
 * Opened by selecting the "Gateway setup" card in `compaction` / `compaction init`.
 *
 * Invariants (as in OnboardingTui): no text input, no network call, no credential read. This is a
 * configurator that resolves a validated config; the caller starts the real gateway. Raw flags
 * (custom upstream / listen address / manual baseURL) live under "Advanced", copy-and-run only.
 */
const BLUE = BRAND_HEX;
const DIM = "gray";

/** The deterministic apply policy the TUI can arm. Deterministic only, no LCM, no semantics. */
export const GATEWAY_APPLY_POLICY = "deterministic-dedupe";

export interface GatewayTuiConfig {
  provider: string;
  upstream: string;
  listen: string;
  /** record is the byte-safe default; `apply` is the EXPERIMENTAL deterministic mode (explicit opt-in only). */
  mode: "record" | "apply";
  /** Present only when mode is `apply`. */
  policy?: string;
}

export type GatewayTuiResult =
  | { action: "dev"; config: GatewayTuiConfig }
  | { action: "configure"; config: GatewayTuiConfig }
  | { action: "start"; config: GatewayTuiConfig }
  | { action: "back" }
  | { action: "quit" };

interface GatewayAppProps {
  onDone: (result: GatewayTuiResult) => void;
  /**
   * Whether this build actually contains the deterministic input compactor. Resolved by the CALLER
   * (`runGatewayTui`) and passed in, so the component keeps its "no async work, no I/O" invariant.
   *
   * It exists because the arming panel below describes what apply mode will do, and in a public build
   * the mutating half is excluded — so the unconditional description promised a capability the binary
   * does not have. Defaults to `false`: an unanswered question must never render
   * as a capability claim.
   */
  inputCompactionAvailable?: boolean;
}

// Routing step, after Provider + Mode. Option 1 (run a command through Compaction) is the
// preferred, no-baseURL-copy path.
const MENU = [
  { key: "dev", label: "Run a command through the Gateway  (preferred - no baseURL copy)" },
  { key: "configure", label: "Configure this project  (approval-gated; shows a diff first)" },
  { key: "start", label: "Start the gateway now  (I'll point my client at it)" },
  { key: "advanced", label: "Show manual / advanced setup" },
  { key: "back", label: "Back to workflows" }
] as const;

export function GatewayApp({ onDone, inputCompactionAvailable = false }: GatewayAppProps): React.ReactElement {
  const [index, setIndex] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Experimental deterministic APPLY. Off by default. Arming ('x') shows the risk boundary; apply only
  // engages after an EXPLICIT confirm ('y'). Without the confirm, the started gateway stays in record mode.
  const [applyArmed, setApplyArmed] = useState(false);
  const [applyConfirmed, setApplyConfirmed] = useState(false);
  const { exit } = useApp();

  const provider = GATEWAY_PROVIDERS[0]; // OpenAI (the only available provider today)
  const applyOn = applyArmed && applyConfirmed;
  const config: GatewayTuiConfig = {
    provider: provider.key,
    upstream: provider.upstream,
    listen: GATEWAY_DEFAULT_LISTEN,
    mode: applyOn ? "apply" : "record",
    ...(applyOn ? { policy: GATEWAY_APPLY_POLICY } : {})
  };

  const choose = (key: string): void => {
    if (key === "dev") onDone({ action: "dev", config });
    else if (key === "configure") onDone({ action: "configure", config });
    else if (key === "start") onDone({ action: "start", config });
    else if (key === "back") onDone({ action: "back" });
    else {
      setShowAdvanced((a) => !a);
      return; // Advanced toggles in place; it does not exit
    }
    exit();
  };

  useInput((input, key) => {
    if (key.upArrow || input === "k") setIndex((i) => (i - 1 + MENU.length) % MENU.length);
    else if (key.downArrow || input === "j") setIndex((i) => (i + 1) % MENU.length);
    else if (key.return) choose(MENU[index].key);
    else if (input === "a") choose("advanced");
    else if (input === "x") {
      // Toggle the experimental apply arm; disarming always clears the confirmation (fail safe).
      setApplyArmed((a) => {
        if (a) setApplyConfirmed(false);
        return !a;
      });
    } else if (input === "y") {
      // Explicit confirmation ONLY matters while armed; it never silently enables apply otherwise.
      setApplyConfirmed((c) => (applyArmed ? true : c));
    } else if (input === "q") {
      onDone({ action: "quit" });
      exit();
    } else if (key.escape) {
      onDone({ action: "back" });
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color={BLUE} bold>
        ▌ GATEWAY SETUP
      </Text>
      <Text color={DIM}>A local, byte-safe proxy for your model traffic. Content-free receipts; your key never leaves the client.</Text>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={DIM}>{"  Provider   "}</Text>
          <Text color="white">{provider.label}</Text>
          <Text color={BLUE}>{"  ✓"}</Text>
        </Box>
        <Box flexDirection="column">
          {GATEWAY_MODES.map((m, i) => (
            <Box key={m.key}>
              <Text color={DIM}>{i === 0 ? "  Mode       " : "             "}</Text>
              {m.available ? (
                <Text color="white">
                  {m.label}
                  <Text color={BLUE}>{"  ✓"}</Text>
                </Text>
              ) : (
                <Text color={DIM}>{m.label}</Text>
              )}
            </Box>
          ))}
        </Box>
        <Box>
          <Text color={DIM}>{"  Listen     "}</Text>
          <Text color="white">{GATEWAY_DEFAULT_LISTEN}</Text>
        </Box>
        <Box>
          <Text color={DIM}>{"  Active     "}</Text>
          {applyOn ? (
            <Text color="yellow">APPLY · experimental · deterministic-dedupe (original retained locally)</Text>
          ) : (
            <Text color="white">RECORD · byte-safe, no mutation</Text>
          )}
        </Box>
      </Box>

      {/* Experimental deterministic apply, explicit opt-in; the risk boundary must stay visible. */}
      <Box marginTop={1} flexDirection="column">
        {!applyArmed ? (
          <Text color={DIM}>{"  x  arm experimental deterministic apply (off by default; explicit confirm required)"}</Text>
        ) : (
          <Box flexDirection="column">
            <Text color="yellow" bold>{"  ⚠ Experimental: deterministic APPLY"}</Text>
            {inputCompactionAvailable ? (
              <>
                <Text color={DIM}>  Changes model-visible input for KNOWN-SAFE shapes only (removes exact-duplicate large blocks).</Text>
                <Text color={DIM}>  Deterministic only - no summarization, no LCM. The ORIGINAL request is retained locally.</Text>
                <Text color={DIM}>  Unknown/complex shapes FAIL CLOSED (forwarded unchanged). System/developer & tool schemas are never touched.</Text>
              </>
            ) : (
              <>
                <Text color={DIM}>  This build has NO deterministic input compactor, so apply mode cannot change model-visible input.</Text>
                <Text color={DIM}>  Requests are forwarded UNCHANGED and each receipt records why. Nothing is mutated or retained.</Text>
              </>
            )}
            {applyConfirmed ? (
              <Text color="yellow">{"  ✓ apply confirmed - 'Start the gateway now' will run APPLY mode.   (x to disarm)"}</Text>
            ) : (
              <Text color="yellow">{"  press y to CONFIRM apply mode, or x to cancel   (without confirmation the gateway starts in RECORD mode)"}</Text>
            )}
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="white">How do you want to route traffic?</Text>
      </Box>
      <Box flexDirection="column">
        {MENU.map((m, i) => (
          <Box key={m.key}>
            <Text color={i === index ? BLUE : DIM}>{i === index ? "  ▌ " : "  ○ "}</Text>
            <Text color={i === index ? "white" : DIM}>{m.label}</Text>
          </Box>
        ))}
      </Box>

      {showAdvanced ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={DIM}>Advanced - for a custom provider, upstream, or port, start the gateway directly:</Text>
          <Text color={BLUE}>{`  compaction gateway start --provider openai --upstream ${provider.upstream} --listen ${GATEWAY_DEFAULT_LISTEN}`}</Text>
          <Text color={DIM}>Then point your OpenAI client's baseURL at the listen address + /v1.</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={DIM}>Already running an app? Compaction cannot safely attach to an already-running process</Text>
            <Text color={DIM}>unless it already points at the gateway. Restart it through Compaction to route future calls:</Text>
            <Text color={BLUE}>{"  compaction gateway run -- <your command>"}</Text>
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={DIM}>{"↑/↓ move   ·   Enter select   ·   a advanced   ·   x/y experimental apply   ·   Esc back   ·   q quit"}</Text>
      </Box>
    </Box>
  );
}

const ALT_SCREEN_ENTER = "[?1049h[H[2J";
const ALT_SCREEN_LEAVE = "[?1049l";

/** Render the gateway setup TUI and resolve with the user's choice (same alt-screen pattern as runOnboardingTui). */
export async function runGatewayTui(): Promise<GatewayTuiResult> {
  const out = process.stdout;
  const useAlt = Boolean(out.isTTY);
  if (useAlt) out.write(ALT_SCREEN_ENTER);
  let result: GatewayTuiResult = { action: "quit" };
  // Asked once, before the first frame, so the component itself stays synchronous and I/O-free.
  const inputCompactionAvailable = await isInputCompactionAvailable();
  try {
    const app = render(
      <GatewayApp
        inputCompactionAvailable={inputCompactionAvailable}
        onDone={(r) => {
          result = r;
        }}
      />
    );
    await app.waitUntilExit();
  } finally {
    if (useAlt) out.write(ALT_SCREEN_LEAVE);
  }
  return result;
}
