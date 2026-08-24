import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  MODE_OPTIONS,
  TARGET_OPTIONS,
  statusForScenario,
  type PrototypeMode,
  type PrototypeScenario,
  type PrototypeTarget
} from "./model.js";
import { FRAME_MAX, PrototypeWordmark, useTerminalSize } from "./Wordmark.js";

// Internal UX dogfood only. Every discovery, install, verification, readiness, activity,
// and metric shown here is fixed simulated state-not observed, provider-reported, billed,
// or production behavior. This component must remain unreachable from the production CLI.
type Screen = "target" | "limited" | "mode" | "review" | "installing" | "ready" | "installed";

const ACCENT = "#6666ff";
const MUTED = "gray";

function OptionList<T extends string>({
  options,
  selected,
  onSelect,
  compact = false,
  selectedDescriptionOnly = false,
  descriptionIndent = "     "
}: {
  options: Array<{ key: T; title: string; description: string; availability?: string }>;
  selected: number;
  onSelect: (key: T) => void;
  compact?: boolean;
  selectedDescriptionOnly?: boolean;
  descriptionIndent?: string;
}): React.ReactElement {
  useInput((input, key) => {
    const numeric = Number(input);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) onSelect(options[numeric - 1].key);
    if (key.return) onSelect(options[selected].key);
  });
  return (
    <Box flexDirection="column">
      {options.map((option, index) => {
        const active = index === selected;
        return (
          <Box key={option.key} flexDirection="column" marginBottom={compact ? 0 : 1}>
            <Text color={active ? ACCENT : undefined}>
              {active ? "›" : " "} {index + 1}. <Text bold={active}>{option.title}</Text>
              {option.availability ? <Text color={MUTED}> · {option.availability}</Text> : null}
            </Text>
            {!selectedDescriptionOnly || active ? (
              <Text color={active ? ACCENT : MUTED}>{descriptionIndent}{option.description}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function Footer({ back = false, compact = false }: { back?: boolean; compact?: boolean }): React.ReactElement {
  return (
    <Box marginTop={compact ? 0 : 1}>
      <Text color={MUTED}>↑↓ move · enter continue{back ? " · ←/esc back" : ""} · q quit</Text>
    </Box>
  );
}

export function App({ scenario }: { scenario: PrototypeScenario }): React.ReactElement {
  const { exit } = useApp();
  const { cols, rows } = useTerminalSize();
  const wordmarkWidth = Math.min(cols, FRAME_MAX) - 2;
  const [screen, setScreen] = useState<Screen>(scenario === "already-installed" ? "installed" : "target");
  const [targetIndex, setTargetIndex] = useState(0);
  const [target, setTarget] = useState<PrototypeTarget>("claude");
  const [modeIndex, setModeIndex] = useState(0);
  const [mode, setMode] = useState<PrototypeMode>("full");
  const [installStep, setInstallStep] = useState(0);

  useInput((value, key) => {
    if (value === "q" || (key.ctrl && value === "c")) exit();
    if (key.upArrow) {
      if (screen === "target") setTargetIndex((current) => (current + TARGET_OPTIONS.length - 1) % TARGET_OPTIONS.length);
      if (screen === "mode") setModeIndex((current) => (current + MODE_OPTIONS.length - 1) % MODE_OPTIONS.length);
    }
    if (key.downArrow) {
      if (screen === "target") setTargetIndex((current) => (current + 1) % TARGET_OPTIONS.length);
      if (screen === "mode") setModeIndex((current) => (current + 1) % MODE_OPTIONS.length);
    }
    if (key.escape || key.leftArrow) {
      if (screen === "limited") setScreen("target");
      if (screen === "mode") setScreen("target");
      if (screen === "review") setScreen("mode");
      if (screen === "ready") setScreen("review");
    }
    if (screen === "limited" && key.return) setScreen("target");
    if (screen === "review" && (key.return || value === "1")) {
      setInstallStep(0);
      setScreen("installing");
    }
  });

  useEffect(() => {
    if (screen !== "installing") return;
    if (installStep >= 4) {
      const timer = setTimeout(() => setScreen("ready"), 450);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => setInstallStep((current) => current + 1), 550);
    return () => clearTimeout(timer);
  }, [screen, installStep]);

  const pickTarget = (key: PrototypeTarget): void => {
    const index = TARGET_OPTIONS.findIndex((option) => option.key === key);
    setTargetIndex(index);
    setTarget(key);
    setScreen(key === "claude" ? "mode" : "limited");
  };

  const pickMode = (key: PrototypeMode): void => {
    const index = MODE_OPTIONS.findIndex((option) => option.key === key);
    setModeIndex(index);
    setMode(key);
    setScreen("review");
  };

  if (screen === "target") {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
        <Box alignSelf="flex-start" borderStyle="round" borderColor={ACCENT} paddingX={1} marginBottom={1}>
          <Text color={ACCENT}>✦</Text>
          <Text> Welcome to <Text bold>Compaction</Text></Text>
        </Box>
        <Box flexShrink={0}>
          <PrototypeWordmark
            version="0.5.0"
            maxWidth={wordmarkWidth}
            color={ACCENT}
            compact={rows < 28}
          />
        </Box>
        <Box flexDirection="column">
          <Box marginTop={1} flexDirection="column">
            <Text>Choose the workflow you want to connect.</Text>
            <Text color={MUTED}>Discovery found Claude Code, Codex CLI, and Cursor on this machine.</Text>
          </Box>
          <OptionList
            options={TARGET_OPTIONS}
            selected={targetIndex}
            onSelect={pickTarget}
            compact
            selectedDescriptionOnly
          />
          <Footer />
        </Box>
      </Box>
    );
  }

  if (screen === "limited") {
    const isCodex = target === "codex";
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>&gt; <Text bold>{isCodex ? "Codex CLI" : "Cursor"}</Text></Text>
        <Box marginTop={1} flexDirection="column">
          {isCodex ? (
            <>
              <Text>Codex gets shorter responses on your ChatGPT plan - no API key needed.</Text>
              <Text color={MUTED}>Add an OpenAI API key for full optimization (input savings + per-turn control).</Text>
            </>
          ) : (
            <>
              <Text>Cursor gets shorter responses via a session-level instruction.</Text>
              <Text color={MUTED}>Per-turn control and input savings need an OpenAI API key. Output effect is not yet measured on Cursor.</Text>
            </>
          )}
        </Box>
        <Box marginTop={1}><Text color={MUTED}>Return to choose another workflow.</Text></Box>
        <Box marginTop={1}><Text color={ACCENT}>Press enter to go back</Text></Box>
      </Box>
    );
  }

  if (screen === "mode") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>&gt; <Text bold>Choose how Compaction should optimize Claude Code</Text></Text>
        <Box marginTop={1} marginBottom={1} flexDirection="column">
          <Text>Your Claude subscription remains the way Claude Code authenticates.</Text>
          <Text color={MUTED}>Compaction runs locally between the Claude launcher and supported traffic.</Text>
        </Box>
        <OptionList options={MODE_OPTIONS} selected={modeIndex} onSelect={pickMode} />
        <Footer back />
      </Box>
    );
  }

  if (screen === "review") {
    const selectedMode = MODE_OPTIONS.find((option) => option.key === mode) ?? MODE_OPTIONS[0];
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>&gt; <Text bold>Enable Compaction for Claude Code?</Text></Text>
        <Box marginTop={1} flexDirection="column">
          <Text>Compaction will:</Text>
          <Text>  • install a reversible, fail-open Claude launcher</Text>
          <Text>  • add its launcher directory to your shell PATH</Text>
          <Text>  • start the local Gateway when Claude Code needs it</Text>
          <Text>  • remember <Text color={ACCENT}>{selectedMode.title}</Text> for future runs</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={MUTED}>No API key is requested for the Claude subscription path.</Text>
          <Text color={MUTED}>Disable restores the previous PATH configuration.</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={ACCENT}>› Enable Compaction</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={MUTED}>enter enable · ←/esc back · q quit</Text>
        </Box>
      </Box>
    );
  }

  if (screen === "installing") {
    const steps = ["Checking Claude Code", "Installing the fail-open launcher", "Configuring your shell PATH", "Starting the local Gateway"];
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>&gt; <Text bold>Setting up Claude Code</Text></Text>
        <Box marginTop={1} flexDirection="column">
          {steps.map((label, index) => (
            <Text key={label} color={index < installStep ? "green" : index === installStep ? ACCENT : MUTED}>
              {index < installStep ? "✓" : index === installStep ? "●" : "○"} {label}
            </Text>
          ))}
          <Text color={installStep >= 4 ? "green" : MUTED}>{installStep >= 4 ? "✓" : "○"} Verifying a routed request</Text>
        </Box>
      </Box>
    );
  }

  if (screen === "ready") {
    const status = statusForScenario(scenario, mode);
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color={status.healthy ? "green" : "yellow"}>{status.healthy ? "✓" : "!"} <Text bold>{status.headline}</Text></Text>
        <Box marginTop={1} flexDirection="column">
          <Text>Claude launcher   {status.launcher}</Text>
          <Text>Local Gateway    {status.gateway}</Text>
          <Text>Authentication   Claude subscription</Text>
        </Box>
        {status.nextAction ? <Box marginTop={1}><Text color="yellow">{status.nextAction}</Text></Box> : null}
        <Box marginTop={1} flexDirection="column">
          <Text>Run <Text color={ACCENT}>claude</Text> normally. Compaction starts with it and remembers this mode.</Text>
          <Text color={MUTED}>Hooks and the status line can join a running local session; live request routing is verified separately.</Text>
        </Box>
        <TurnMetricsPreview mode={mode} />
        <Box marginTop={1} flexDirection="column">
          <Text><Text color={ACCENT}>compaction status</Text>     setup and routing health</Text>
          <Text><Text color={ACCENT}>compaction activity</Text>   recent requests</Text>
          <Text><Text color={ACCENT}>compaction init</Text>       reconfigure later</Text>
        </Box>
        <Box marginTop={1}><Text color={MUTED}>←/esc review setup · q close</Text></Box>
      </Box>
    );
  }

  const installedStatus = statusForScenario("already-installed", mode);
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color="green">● <Text bold>Compaction is active for Claude Code</Text></Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Mode             {mode === "full" ? "Full optimization" : "Output only"}</Text>
        <Text>Claude launcher  {installedStatus.launcher}</Text>
        <Text>Local Gateway   {installedStatus.gateway}</Text>
        <Text>Authentication  Claude subscription</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text><Text color={ACCENT}>compaction status</Text>     inspect setup and routing</Text>
        <Text><Text color={ACCENT}>compaction activity</Text>   inspect recent requests</Text>
      </Box>
      <TurnMetricsPreview mode={mode} />
      <Box marginTop={1} flexDirection="column">
        <Text color={ACCENT}>› 1. Re-run onboarding</Text>
        <Text>  2. Exit</Text>
      </Box>
      <InstalledInput onConfigure={() => setScreen("target")} onExit={exit} />
      <Box marginTop={1}><Text color={MUTED}>enter reconfigure · 2 exit · q quit</Text></Box>
    </Box>
  );
}

function InstalledInput({ onConfigure, onExit }: { onConfigure: () => void; onExit: () => void }): null {
  useInput((input, key) => {
    if (input === "1" || key.return) onConfigure();
    if (input === "2") onExit();
  });
  return null;
}

function TurnMetricsPreview({ mode }: { mode: PrototypeMode }): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={MUTED}>Claude status line after a response (example - not a measured result)</Text>
      {mode === "full" ? (
        <Text color={ACCENT}>● Compaction · out -45% 742→408 · input -7% · local</Text>
      ) : (
        <Text color={ACCENT}>● Compaction · out -45% 742→408 · local</Text>
      )}
    </Box>
  );
}
