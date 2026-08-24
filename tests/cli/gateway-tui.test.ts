import React from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayApp, type GatewayTuiResult } from "../../src/cli/onboarding/GatewayTui.js";

/**
 * Guided Gateway setup TUI, a SIBLING of the init chooser, reusing the same Ink stack. It is a
 * configurator (no text input, no network here); it resolves a routing intent (dev / configure /
 * start) the caller acts on. The routing step asks "How do you want to route traffic?" with the
 * preferred no-copy `dev` path first, and honest active-session copy.
 */
const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Collapse wrapping/indent whitespace so multi-word phrases match regardless of the 80-col wrap. */
const flat = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ");

const RECORD_CONFIG = { provider: "openai", upstream: "https://api.openai.com/v1", listen: "http://127.0.0.1:8787", mode: "record" as const };

describe("GatewayApp - guided gateway setup + routing step", () => {
  const mounted: Array<{ unmount: () => void }> = [];
  afterEach(() => {
    for (const m of mounted.splice(0)) m.unmount();
  });
  /**
   * Mounts with the build reported as CAPABLE by default. That is what the dev/private build is, and
   * it keeps every pre-existing case asserting the behaviour it was written for. The incapable branch
   * is exercised explicitly below — see the F76 case.
   */
  const mount = (onDone: (r: GatewayTuiResult) => void, inputCompactionAvailable = true) => {
    const inst = render(React.createElement(GatewayApp, { onDone, inputCompactionAvailable }));
    mounted.push(inst);
    return inst;
  };

  it("renders provider OpenAI, mode Record, the routing question + options, and honest wording", () => {
    const frame = flat(mount(() => {}).lastFrame());
    expect(frame).toContain("GATEWAY SETUP");
    expect(frame).toContain("OpenAI");
    expect(frame).toContain("Record");
    expect(frame).toContain("coming soon"); // cache/apply shown disabled
    // The routing step: the question + all three routing options.
    expect(frame).toContain("How do you want to route traffic?");
    expect(frame).toContain("Run a command through the Gateway"); // option 1 (preferred, gateway-native)
    expect(frame).toContain("Configure this project"); // option 2
    expect(frame).toContain("manual / advanced setup"); // option 3 (manual under advanced)
    // honest, content-free: the key stays on the client; no savings/cost claim
    expect(frame).toContain("key never leaves the client");
    expect(frame).not.toMatch(/cost saved|reduced output|reduced model-visible/i);
  });

  it("Enter on the first option resolves to the preferred no-copy 'dev' routing", async () => {
    let result: GatewayTuiResult | null = null;
    const a = mount((r) => (result = r));
    await settle();
    a.stdin.write("\r"); // Enter on the first menu item (Run a command through Compaction)
    await settle();
    expect(result).toEqual({ action: "dev", config: RECORD_CONFIG });
  });

  it("selecting 'Configure this project' resolves to the approval-gated configure routing", async () => {
    let result: GatewayTuiResult | null = null;
    const a = mount((r) => (result = r));
    await settle();
    a.stdin.write("[B"); // ↓ to option 2 (Configure this project)
    await settle();
    a.stdin.write("\r");
    await settle();
    expect(result).toEqual({ action: "configure", config: RECORD_CONFIG });
  });

  it("selecting 'Start the gateway now' resolves to the manual-routing start", async () => {
    let result: GatewayTuiResult | null = null;
    const a = mount((r) => (result = r));
    await settle();
    a.stdin.write("[B"); // ↓ option 2
    a.stdin.write("[B"); // ↓ option 3 (Start the gateway now)
    await settle();
    a.stdin.write("\r");
    await settle();
    expect(result).toEqual({ action: "start", config: RECORD_CONFIG });
  });

  it("'a' toggles Advanced - raw CLI flags AND honest active-session copy (hidden until then)", async () => {
    const { lastFrame, stdin } = mount(() => {});
    await settle();
    expect(flat(lastFrame())).not.toContain("gateway start --provider");
    expect(flat(lastFrame())).not.toContain("cannot safely attach");
    stdin.write("a");
    await settle();
    const frame = flat(lastFrame());
    expect(frame).toContain("compaction gateway start --provider openai --upstream https://api.openai.com/v1 --listen http://127.0.0.1:8787");
    // Active-session honesty (F): no OS proxying, restart through Compaction instead.
    expect(frame).toContain("cannot safely attach to an already-running process");
    expect(frame).toContain("compaction gateway run -- <your command>");
  });

  it("experimental apply is OFF by default and shows RECORD as active", () => {
    const frame = flat(mount(() => {}).lastFrame());
    expect(frame).toContain("RECORD · byte-safe, no mutation");
    expect(frame).toContain("arm experimental deterministic apply");
    expect(frame).not.toContain("APPLY · experimental"); // not active until explicitly armed + confirmed
  });

  it("'x' arms apply and shows the risk boundary; it does NOT activate apply without a confirm", async () => {
    let result: GatewayTuiResult | null = null;
    const a = mount((r) => (result = r));
    await settle();
    a.stdin.write("x"); // arm
    await settle();
    const frame = flat(a.lastFrame());
    expect(frame).toContain("Experimental: deterministic APPLY");
    expect(frame).toContain("FAIL CLOSED");
    expect(frame).toContain("press y to CONFIRM");
    // Selecting start while armed-but-UNCONFIRMED must stay in RECORD mode (refuses apply without confirm).
    a.stdin.write("j"); // ↓ configure
    await settle();
    a.stdin.write("j"); // ↓ start
    await settle();
    a.stdin.write("\r");
    await settle();
    expect(result).toEqual({ action: "start", config: RECORD_CONFIG });
  });

  /**
   * F76. The panel above describes what apply WILL do, and a public build has no deterministic input
   * compactor — `apply-policy.ts` is excluded by the open-core boundary — so on that build the promise
   * "the ORIGINAL request is retained locally" was describing a capability the binary does not have.
   * Arming still works and the mode still resolves to apply (the user asked for it, and the request
   * path fails closed correctly); what changes is that the panel stops claiming a mutation will happen.
   */
  it("on a build with NO input compactor, the arm panel promises no mutation and no retained original", async () => {
    const a = mount(() => {}, false);
    await settle();
    a.stdin.write("x"); // arm
    await settle();
    const frame = flat(a.lastFrame());
    expect(frame).toContain("Experimental: deterministic APPLY"); // still an experimental opt-in
    expect(frame).toContain("NO deterministic input compactor");
    expect(frame).toContain("forwarded UNCHANGED");
    // The two claims that were false on this build must be gone, not merely reworded around.
    expect(frame).not.toContain("Changes model-visible input");
    expect(frame).not.toContain("retained locally");
  });

  it("'x' then 'y' CONFIRMS apply → start resolves with mode:apply + the deterministic policy", async () => {
    let result: GatewayTuiResult | null = null;
    const a = mount((r) => (result = r));
    await settle();
    a.stdin.write("x"); // arm
    await settle();
    a.stdin.write("y"); // confirm
    await settle();
    expect(flat(a.lastFrame())).toContain("apply confirmed");
    a.stdin.write("j"); // ↓ configure
    await settle();
    a.stdin.write("j"); // ↓ start
    await settle();
    a.stdin.write("\r");
    await settle();
    expect(result).toEqual({
      action: "start",
      config: { provider: "openai", upstream: "https://api.openai.com/v1", listen: "http://127.0.0.1:8787", mode: "apply", policy: "deterministic-dedupe" }
    });
  });

  it("disarming ('x' again) after confirm returns to RECORD (fail safe)", async () => {
    let result: GatewayTuiResult | null = null;
    const a = mount((r) => (result = r));
    await settle();
    a.stdin.write("x"); // arm
    a.stdin.write("y"); // confirm
    await settle();
    a.stdin.write("x"); // disarm → clears confirmation
    await settle();
    a.stdin.write("j"); // ↓ configure
    await settle();
    a.stdin.write("j"); // ↓ start
    await settle();
    a.stdin.write("\r");
    await settle();
    expect(result).toEqual({ action: "start", config: RECORD_CONFIG });
  });

  it("Esc returns to the chooser (back); q quits", async () => {
    let r1: GatewayTuiResult | null = null;
    const a = mount((r) => (r1 = r));
    await settle();
    a.stdin.write(""); // Esc
    await settle();
    expect(r1).toEqual({ action: "back" });

    let r2: GatewayTuiResult | null = null;
    const b = mount((r) => (r2 = r));
    await settle();
    b.stdin.write("q");
    await settle();
    expect(r2).toEqual({ action: "quit" });
  });
});
