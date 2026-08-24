/**
 * Workflow auto-wiring resolver tests, the SOURCE of the gateway `--workflow` identity.
 *
 * HERMETIC: `COMPACTION_CONFIG_DIR` pinned at a per-test tmpdir; the real `~/.compaction` is never touched.
 *
 * Proven here (safety framing, this resolver may only ever SUPPLY the same narrow identity the
 * eligibility gates already check, never widen it):
 * - explicit `--workflow <tool>` always wins; `none` disables; unknown values throw a clean error;
 * - omitted/`auto` defaults ONLY to the provider-matched workflow persisted at connect time
 *   (openai → codex, anthropic → claude-code), deterministic, never ambiguous;
 * - nothing persisted → no workflow (record semantics; stored authorizations never consulted);
 * - a provider mismatch never yields a workflow (codex is never defaulted on anthropic and vice versa);
 * - `gateway run` additionally requires the launched executable to BE the workflow's own tool binary -
 *   a generic command (`npm run dev`) NEVER inherits a workflow identity.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addConnectedWorkflows } from "../../src/core/onboarding-preferences.js";
import {
  resolveWorkflowForGatewayRun,
  resolveWorkflowForGatewayStart,
  resolveProviderForGatewayStart,
  workflowForProvider,
  providerForWorkflow
} from "../../src/core/gateway/workflow-default.js";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "workflow-default-"));
  env = { COMPACTION_CONFIG_DIR: dir };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("workflowForProvider - deterministic provider-matched mapping", () => {
  it("maps openai → codex, anthropic → claude-code, anything else → undefined", () => {
    expect(workflowForProvider("openai")).toBe("codex");
    expect(workflowForProvider("anthropic")).toBe("claude-code");
    expect(workflowForProvider("azure")).toBeUndefined();
  });
});

describe("resolveWorkflowForGatewayStart", () => {
  it("explicit tool always wins (even over a persisted different setup)", () => {
    addConnectedWorkflows(["codex"], env);
    const r = resolveWorkflowForGatewayStart({ explicit: "codex", provider: "openai", env });
    expect(r).toEqual({ workflow: "codex", source: "explicit" });
  });

  it("`none` disables any default", () => {
    addConnectedWorkflows(["codex"], env);
    expect(resolveWorkflowForGatewayStart({ explicit: "none", provider: "openai", env })).toEqual({ source: "disabled" });
  });

  it("unknown explicit value throws a clean flag error (codex | claude-code | auto | none)", () => {
    expect(() => resolveWorkflowForGatewayStart({ explicit: "cursor", provider: "openai", env })).toThrow(
      /not implemented \(codex \| claude-code \| auto \| none\)/
    );
  });

  it("omitted flag + persisted provider-matched workflow → auto-connected default", () => {
    addConnectedWorkflows(["codex"], env);
    expect(resolveWorkflowForGatewayStart({ provider: "openai", env })).toEqual({ workflow: "codex", source: "auto-connected" });
    // `auto` is the same as omitted.
    expect(resolveWorkflowForGatewayStart({ explicit: "auto", provider: "openai", env })).toEqual({
      workflow: "codex",
      source: "auto-connected"
    });
  });

  it("nothing persisted → unset (record semantics; no stored authorization is ever consulted)", () => {
    expect(resolveWorkflowForGatewayStart({ provider: "openai", env })).toEqual({ source: "unset" });
  });

  it("provider mismatch never defaults a workflow (codex is never attached on anthropic)", () => {
    addConnectedWorkflows(["codex"], env);
    expect(resolveWorkflowForGatewayStart({ provider: "anthropic", env })).toEqual({ source: "unset" });
    addConnectedWorkflows(["claude-code"], env);
    expect(resolveWorkflowForGatewayStart({ provider: "anthropic", env })).toEqual({
      workflow: "claude-code",
      source: "auto-connected"
    });
    expect(resolveWorkflowForGatewayStart({ provider: "openai", env })).toEqual({ workflow: "codex", source: "auto-connected" });
  });
});

describe("resolveWorkflowForGatewayRun - the executable gate", () => {
  it("auto default applies ONLY when the launched command IS the workflow's own tool binary", () => {
    addConnectedWorkflows(["codex"], env);
    expect(resolveWorkflowForGatewayRun({ provider: "openai", command: ["codex", "exec", "--json", "t"], env })).toEqual({
      workflow: "codex",
      source: "auto-connected"
    });
    // A generic command NEVER inherits an identity, fail-safe to record.
    expect(resolveWorkflowForGatewayRun({ provider: "openai", command: ["npm", "run", "dev"], env })).toEqual({ source: "unset" });
  });

  it("claude binary + anthropic provider + persisted claude-code → auto; wrong provider → unset", () => {
    addConnectedWorkflows(["claude-code"], env);
    expect(resolveWorkflowForGatewayRun({ provider: "anthropic", command: ["claude"], env })).toEqual({
      workflow: "claude-code",
      source: "auto-connected"
    });
    expect(resolveWorkflowForGatewayRun({ provider: "openai", command: ["claude"], env })).toEqual({ source: "unset" });
  });

  it("explicit tool and `none` behave exactly as on gateway start (no executable gate)", () => {
    expect(resolveWorkflowForGatewayRun({ explicit: "codex", provider: "openai", command: ["npm", "x"], env })).toEqual({
      workflow: "codex",
      source: "explicit"
    });
    addConnectedWorkflows(["codex"], env);
    expect(resolveWorkflowForGatewayRun({ explicit: "none", provider: "openai", command: ["codex"], env })).toEqual({
      source: "disabled"
    });
  });

  it("a path-qualified tool binary still matches (basename gate), but a lookalike does not", () => {
    addConnectedWorkflows(["codex"], env);
    expect(resolveWorkflowForGatewayRun({ provider: "openai", command: ["/usr/local/bin/codex", "exec"], env })).toEqual({
      workflow: "codex",
      source: "auto-connected"
    });
    expect(resolveWorkflowForGatewayRun({ provider: "openai", command: ["codex-helper"], env })).toEqual({ source: "unset" });
  });
});

describe("resolveProviderForGatewayStart - the upstream provider is inferred, never silently mismatched", () => {
  it("explicit --provider always wins (even over --workflow and a persisted setup)", () => {
    addConnectedWorkflows(["claude-code"], env);
    expect(
      resolveProviderForGatewayStart({ explicitProvider: "openai", explicitWorkflow: "claude-code", env })
    ).toEqual({ provider: "openai", source: "explicit" });
  });

  it("--workflow claude-code → anthropic; --workflow codex → openai (no connect needed)", () => {
    expect(resolveProviderForGatewayStart({ explicitWorkflow: "claude-code", env })).toEqual({
      provider: "anthropic",
      source: "workflow",
      workflow: "claude-code"
    });
    expect(resolveProviderForGatewayStart({ explicitWorkflow: "codex", env })).toEqual({
      provider: "openai",
      source: "workflow",
      workflow: "codex"
    });
  });

  it("no flags + exactly one connected workflow → its provider (claude-code → anthropic)", () => {
    addConnectedWorkflows(["claude-code"], env);
    expect(resolveProviderForGatewayStart({ env })).toEqual({
      provider: "anthropic",
      source: "connected",
      workflow: "claude-code"
    });
  });

  it("no signal → openai fallback; several connected workflows are ambiguous → fallback too", () => {
    expect(resolveProviderForGatewayStart({ env })).toEqual({ provider: "openai", source: "fallback" });
    addConnectedWorkflows(["codex", "claude-code"], env);
    expect(resolveProviderForGatewayStart({ env })).toEqual({ provider: "openai", source: "fallback" });
  });

  it("--workflow none / auto do not drive workflow inference (fall through to connected/fallback)", () => {
    expect(resolveProviderForGatewayStart({ explicitWorkflow: "none", env })).toEqual({
      provider: "openai",
      source: "fallback"
    });
    addConnectedWorkflows(["claude-code"], env);
    expect(resolveProviderForGatewayStart({ explicitWorkflow: "auto", env })).toEqual({
      provider: "anthropic",
      source: "connected",
      workflow: "claude-code"
    });
  });

  it("providerForWorkflow is the exact inverse of workflowForProvider on the routable set", () => {
    expect(providerForWorkflow("codex")).toBe("openai");
    expect(providerForWorkflow("claude-code")).toBe("anthropic");
    expect(providerForWorkflow("cursor")).toBeUndefined();
  });
});
