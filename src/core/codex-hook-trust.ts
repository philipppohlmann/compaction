/**
 * Codex NATIVE HOOK TRUST — read the state, never grant it (PUBLIC CLI core).
 *
 * WHY THIS MODULE EXISTS. Writing `~/.codex/hooks.json` is NOT sufficient to make Codex run a hook.
 * Codex gates every hook behind a native, per-hash trust decision the USER makes inside Codex itself.
 * Until that decision is made the hook is inert — and, critically, SILENTLY inert: the turn completes
 * normally and nothing anywhere says the hook was skipped. So a Compaction that only checked the config
 * file told the user "output shaping is on for codex" while nothing whatsoever was attached to what the
 * model saw.
 *
 * MEASURED, not inferred (codex-cli 0.144.1, isolated `CODEX_HOME`, hooks written in exactly the shape
 * `mergeSubscriptionHooks("codex")` produces):
 *  - `codex exec --json "…"` completed a normal turn (`turn.completed`, real usage) and the hook command
 *    NEVER RAN — no marker file, no output, no warning. Repeated with an explicit `"enabled": true` on
 *    the entry: same result.
 *  - The same config, asked of Codex's OWN `hooks/list` app-server method, answered
 *    `"trustStatus": "untrusted"`. That is the whole explanation.
 *
 * THE CONTRACT THIS READS is Codex's own, not one we invented: `hooks/list` (app-server protocol v2)
 * returns `HooksListResponse { data: HooksListEntry[] }`, each entry carrying `hooks: HookMetadata[]`
 * with `key`, `command`, `eventName`, `enabled`, `currentHash`, `sourcePath` and
 * `trustStatus: "managed" | "untrusted" | "trusted" | "modified"`. Generated verbatim from the installed
 * binary via `codex app-server generate-json-schema`, so it is the shipped schema rather than a guess.
 *
 * WHAT THIS MODULE WILL NOT DO. It never writes `trusted_hash`, never edits Codex config, and never
 * passes `--dangerously-bypass-hook-trust`. Codex's trust gate exists precisely to stop a third-party
 * installer from arming its own hooks; satisfying it on the user's behalf would defeat the control
 * rather than honor it. The one-time approval is the USER's to give, inside Codex
 * (`tui/src/startup_hooks_review.rs`: "Hooks need review" → "Trust all and continue"). This module's
 * entire job is to know whether they have.
 *
 * FAIL-CLOSED. Every failure path answers `unknown`, never `active`. An unreadable probe, a missing
 * binary, a protocol change, a timeout — none of them may produce a claim that the model's input is
 * being shaped. Under-claiming is recoverable; over-claiming is the defect this exists to remove.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { isCompactionShapingHookCommand, shapingHookCommand } from "./subscription-shaping-hooks.js";
import { resolveExecutableOnPath, resolveShimDir, type ShimEnv } from "./tool-shim.js";

/**
 * Codex's own `HookTrustStatus` enum, mirrored exactly. `managed` is an administrator-provisioned hook
 * (trusted by policy, no user decision to make); `modified` means a PREVIOUSLY trusted hook whose hash
 * changed, which Codex treats as untrusted until re-approved.
 */
export type CodexHookTrustStatus = "managed" | "untrusted" | "trusted" | "modified";

/** The subset of Codex's `HookMetadata` this module reads. Unknown fields are ignored, never rejected. */
export interface CodexHookMetadata {
  key: string;
  command?: string | undefined;
  eventName: string;
  enabled: boolean;
  trustStatus: CodexHookTrustStatus;
  currentHash?: string | undefined;
  sourcePath?: string | undefined;
}

/**
 * The state of Compaction's Codex SHAPING hook, as a state machine with exactly one honest answer.
 *
 *  - `not-installed`     — no Compaction shaping hook is configured. Codex is not enabled.
 *  - `approval-required` — the hook IS configured and Codex reports it `untrusted`/`modified`: the
 *                          one-time native approval has not been given, or the command changed since
 *                          it was. Enablement is INCOMPLETE, and approving it is the remedy.
 *  - `disabled`          — the hook is configured and TRUSTED, but Codex has it switched off. A
 *                          DIFFERENT state with a different remedy: approving trust again does nothing
 *                          for a disabled hook, so the two must never share a message.
 *  - `active`            — configured, `trusted` or `managed`, and enabled. Codex will run it.
 *  - `unknown`           — the state could not be established (Codex binary absent, probe failed or
 *                          timed out, unparseable answer). NEVER treat as active.
 */
export type CodexShapingHookState = "not-installed" | "approval-required" | "disabled" | "active" | "unknown";

export interface CodexHookTrustReport {
  state: CodexShapingHookState;
  /** The trust status Codex reported for our shaping hook, when it reported one. */
  trustStatus?: CodexHookTrustStatus;
  /** True when the hook was found but Codex has it disabled (a distinct cause of `approval-required`). */
  disabled?: boolean;
  /** Why the state is `unknown`, for a diagnostic surface. Content-free; never a prompt or a path. */
  unknownReason?: "codex-not-found" | "probe-failed" | "probe-timeout" | "unparseable";
}

/** How long the probe may take before it is killed. Status must never hang on a third-party binary. */
const PROBE_TIMEOUT_MS = 12_000;

/**
 * Resolve the REAL `codex` binary — never our own shim.
 *
 * The shim tees a measurable `codex exec --json` run through the capture bridge. Probing THROUGH it
 * would recurse into Compaction and could record a synthetic run as if the user had made it, so the
 * shim directory is excluded exactly as `installToolShim` excludes it when recording the real binary.
 */
function realCodexBinary(env: ShimEnv): string | undefined {
  let shimDir: string;
  try {
    shimDir = resolveShimDir(env);
  } catch {
    return resolveExecutableOnPath("codex", env);
  }
  return resolveExecutableOnPath("codex", env, [shimDir]);
}

/** Parse one line of app-server stdout as a JSON-RPC message. Malformed lines are skipped, not fatal. */
function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asHookMetadata(value: unknown): CodexHookMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.key !== "string" || typeof r.eventName !== "string") return undefined;
  if (typeof r.enabled !== "boolean" || typeof r.trustStatus !== "string") return undefined;
  const trust = r.trustStatus;
  if (trust !== "managed" && trust !== "untrusted" && trust !== "trusted" && trust !== "modified") return undefined;
  return {
    key: r.key,
    eventName: r.eventName,
    enabled: r.enabled,
    trustStatus: trust,
    ...(typeof r.command === "string" ? { command: r.command } : {}),
    ...(typeof r.currentHash === "string" ? { currentHash: r.currentHash } : {}),
    ...(typeof r.sourcePath === "string" ? { sourcePath: r.sourcePath } : {})
  };
}

/** Pull every `HookMetadata` out of a `hooks/list` result, across all returned cwd entries. */
function hooksFromResult(result: unknown): CodexHookMetadata[] | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const data = (result as Record<string, unknown>).data;
  if (!Array.isArray(data)) return undefined;
  const out: CodexHookMetadata[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const hooks = (entry as Record<string, unknown>).hooks;
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      const parsed = asHookMetadata(hook);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

export interface CodexHookQueryOptions {
  env?: ShimEnv;
  /** Working directory the hook list is resolved for (Codex resolves repo-local `.codex/hooks.json`). */
  cwd?: string;
  /** Override the probe timeout (tests use a short one; production uses `PROBE_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Explicit binary, for tests. Production resolves the real `codex` off PATH. */
  binary?: string;
}

/**
 * Ask Codex itself for its hook list. Read-only: `initialize` then `hooks/list`, then the child is
 * killed. Never throws — every failure becomes `undefined`, which callers map to `unknown`.
 *
 * The child inherits the caller's environment (so an injected `CODEX_HOME` is honored, which is what
 * makes this testable against a fixture home rather than the developer's own Codex install).
 */
export async function queryCodexHooks(options: CodexHookQueryOptions = {}): Promise<CodexHookMetadata[] | undefined> {
  const env = options.env ?? process.env;
  const binary = options.binary ?? realCodexBinary(env);
  if (binary === undefined) return undefined;
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  return await new Promise<CodexHookMetadata[] | undefined>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["app-server"], {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "ignore"]
      });
    } catch {
      resolve(undefined);
      return;
    }

    let settled = false;
    let buffer = "";
    const finish = (value: CodexHookMetadata[] | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* the child may already be gone; killing is best-effort cleanup, never an outcome */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);

    child.on("error", () => finish(undefined));
    child.on("close", () => finish(undefined));

    // EVERY PIPE NEEDS ITS OWN ERROR HANDLER, and this is not defensive boilerplate — it is the fix for
    // a crash this probe caused. `codex` may be gone before our first write lands (it exits early, it is
    // a stub, it is a wrapper that fails). The write then raises EPIPE, which Node delivers as an
    // `error` EVENT ON THE STREAM, not as a throw from `write()` — so the try/catch below cannot see it,
    // and an unhandled stream `error` takes down the whole process. That is a probe deciding the exit
    // code of `compaction init`, which is intolerable for something whose entire job is to answer a
    // question. It is also a RACE (whether the child dies before or after the write), so it reproduces
    // intermittently and only under load — it failed CI while passing locally.
    child.stdin?.on("error", () => finish(undefined));
    child.stdout?.on("error", () => finish(undefined));

    const send = (message: Record<string, unknown>): void => {
      // Both guards are load-bearing and neither subsumes the other: `destroyed`/`writable` catches the
      // synchronously-known-dead pipe, the try/catch catches a synchronous throw, and the `error`
      // handler above catches the asynchronous EPIPE that neither can.
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) {
        finish(undefined);
        return;
      }
      try {
        stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish(undefined);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = parseLine(line);
        if (message === undefined) continue;
        if (message.id === 1) {
          send({ jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [cwd] } });
        } else if (message.id === 2) {
          finish(hooksFromResult(message.result));
          return;
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "compaction", title: "Compaction", version: "0" } }
    });
  });
}

/**
 * Reduce a hook list to the state of OUR shaping hook (pure — the whole state machine, no I/O).
 *
 * Identity is the EXACT command match `isCompactionShapingHookCommand` defines, the same rule install
 * and uninstall use, so the three cannot disagree about which entry is ours. `eventName` is checked too:
 * Codex also carries our model-INVISIBLE `stop` turn-line entry, and that one says nothing about whether
 * anything reaches the model.
 *
 * When several entries match (a user-level and a repo-local config both carrying it), the STRONGEST
 * state wins: one runnable shaping hook is enough to mutate what the model sees, so reporting
 * `approval-required` because a second copy is untrusted would understate what is actually happening.
 */
export function codexShapingStateFromHooks(hooks: CodexHookMetadata[] | undefined): CodexHookTrustReport {
  if (hooks === undefined) return { state: "unknown", unknownReason: "probe-failed" };
  const ours = hooks.filter(
    (h) => h.eventName === "userPromptSubmit" && isCompactionShapingHookCommand(h.command, "codex")
  );
  if (ours.length === 0) return { state: "not-installed" };

  const runnable = ours.find((h) => h.enabled && (h.trustStatus === "trusted" || h.trustStatus === "managed"));
  if (runnable) return { state: "active", trustStatus: runnable.trustStatus };

  // NOT RUNNABLE - and WHY decides what we tell the user to do, so the two causes stay separate.
  // Trust is the remedy for `untrusted`/`modified`; it does NOTHING for a hook Codex has switched off,
  // and offering it there sends the user to a screen that cannot fix their problem.
  const untrusted = ours.find(
    (h) => h.enabled && (h.trustStatus === "untrusted" || h.trustStatus === "modified")
  );
  if (untrusted) return { state: "approval-required", trustStatus: untrusted.trustStatus };

  // Trusted (or managed) but switched off: a pure enablement problem, no approval involved.
  const disabledButTrusted = ours.find(
    (h) => !h.enabled && (h.trustStatus === "trusted" || h.trustStatus === "managed")
  );
  if (disabledButTrusted) {
    return { state: "disabled", trustStatus: disabledButTrusted.trustStatus, disabled: true };
  }

  // Disabled AND untrusted: both are true, and approving trust alone still would not run it. Report the
  // one whose remedy is not sufficient on its own, so no message promises a fix that is not one.
  const first = ours[0]!;
  return { state: "disabled", trustStatus: first.trustStatus, disabled: true };
}

/**
 * The Codex shaping-hook state for this machine, asked of Codex itself.
 *
 * `codexInstalled: false` is `not-installed` rather than `unknown`: with no Codex on PATH there is no
 * Codex to shape, and calling that "unknown" would put an unanswerable question on the status surface.
 * A Codex that IS installed but cannot be probed stays `unknown`, because there the question is real
 * and we simply do not have the answer.
 */
export async function codexShapingHookTrust(options: CodexHookQueryOptions = {}): Promise<CodexHookTrustReport> {
  const env = options.env ?? process.env;
  const binary = options.binary ?? realCodexBinary(env);
  if (binary === undefined) return { state: "unknown", unknownReason: "codex-not-found" };
  const hooks = await queryCodexHooks({ ...options, binary });
  if (hooks === undefined) return { state: "unknown", unknownReason: "probe-failed" };
  return codexShapingStateFromHooks(hooks);
}

/**
 * The NATIVE action a user must perform to complete Codex enablement, named exactly as Codex names it.
 *
 * Sourced from the shipped binary's own startup review flow (`tui/src/startup_hooks_review.rs`), whose
 * strings are "Hooks need review", "Hooks can run outside the sandbox after you trust them.",
 * "Review hooks", "Trust all and continue", "Continue without trusting (hooks won't run)". Quoting
 * Codex's own labels is deliberate: a paraphrase would send the user hunting for a control that does
 * not exist under the name we gave it.
 *
 * It is ONE-TIME per hook hash. It is not a per-session or per-turn step, and nothing in Compaction
 * should ever ask for it twice for the same installed hook — a `modified` status means the COMMAND
 * changed, which is a genuinely new decision, not a repeat of the old one.
 */
export const CODEX_TRUST_ACTION_COMMAND = "codex";

/** The exact on-screen control the user selects, quoted from Codex. */
export const CODEX_TRUST_ACTION_CONTROL = "Trust all and continue";

/** The Codex-side heading that prompt appears under, so the instruction matches what is on screen. */
export const CODEX_TRUST_ACTION_HEADING = "Hooks need review";

/** The hook command whose trust is at stake, for a surface that wants to name it. */
export const CODEX_SHAPING_HOOK_COMMAND = shapingHookCommand("codex");

/** Absolute path of the user-level Codex hooks config, for a diagnostic that wants to point at it. */
export function codexUserHooksConfigPath(home: string): string {
  return path.join(home, ".codex", "hooks.json");
}
