// Fixed scenarios for an internal, manually invoked UX prototype. These values are not
// machine discovery, installation results, provider evidence, billing data, or readiness proof.
export type PrototypeScenario = "happy" | "new-shell" | "verification-failed" | "already-installed";
export type PrototypeTarget = "claude" | "codex" | "cursor";
// Honest optimization choice (replaces the older cache-centric framing): output shaping is the
// primary lever and works on any auth; input compaction is a modest add-on that needs an API key.
export type PrototypeMode = "full" | "output";

export interface TargetOption {
  key: PrototypeTarget;
  title: string;
  description: string;
  availability: string;
}

// All three tools now support response-length (output) optimization on a subscription; input
// compaction and per-turn control are the parts that need an API key (the gateway route).
export const TARGET_OPTIONS: TargetOption[] = [
  {
    key: "claude",
    title: "Claude Code",
    description: "Subscription or Anthropic API key - shorter responses on both; add input savings with a key",
    availability: "detected · recommended"
  },
  {
    key: "codex",
    title: "Codex CLI",
    description: "ChatGPT plan or OpenAI API key - shorter responses on both; full optimization with a key",
    availability: "detected"
  },
  {
    key: "cursor",
    title: "Cursor",
    description: "Shorter responses via a session-level instruction; input savings need an API key",
    availability: "detected · output only"
  }
];

export const MODE_OPTIONS = [
  {
    key: "full" as const,
    title: "Full optimization",
    description: "Shorter responses plus input compaction where it helps (the input side needs an API key)"
  },
  {
    key: "output" as const,
    title: "Output only",
    description: "Asks for shorter responses; your input is sent exactly as written - works on your subscription"
  }
];

export interface PrototypeStatus {
  headline: string;
  gateway: string;
  launcher: string;
  nextAction?: string;
  healthy: boolean;
}

export function statusForScenario(scenario: PrototypeScenario, mode: PrototypeMode): PrototypeStatus {
  const modeLabel = mode === "full" ? "Full optimization" : "Output only";
  if (scenario === "new-shell") {
    return {
      headline: `${modeLabel} is configured, but routing is not active in this shell`,
      gateway: "ready on 127.0.0.1",
      launcher: "installed · waiting for a new shell",
      nextAction: "Open a new terminal, then run `claude` normally.",
      healthy: false
    };
  }
  if (scenario === "verification-failed") {
    return {
      headline: "Setup finished, but the Claude route could not be verified",
      gateway: "ready on 127.0.0.1",
      launcher: "installed · verification failed",
      nextAction: "Run `/status` for the failed check and recovery command.",
      healthy: false
    };
  }
  return {
    headline: `${modeLabel} is active for Claude Code`,
    gateway: "ready on 127.0.0.1",
    launcher: "active · fail-open",
    healthy: true
  };
}

export function parseScenario(value: string | undefined): PrototypeScenario {
  if (value === "new-shell" || value === "verification-failed" || value === "already-installed") {
    return value;
  }
  return "happy";
}
