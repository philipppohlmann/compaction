/**
 * SESSION CORRELATION — tying a gateway receipt to the tool session that produced it, without
 * storing the tool's own session identifier anywhere.
 *
 * THE FACT THAT MAKES THIS POSSIBLE. Supported Claude Code requests carry a session id in the
 * Anthropic body's `metadata.user_id`, encoded as a JSON string. The parser requires only the
 * `session_id` field, treats every other field as optional, and returns unavailable when the shape
 * is absent or malformed. The gateway therefore needs no correlation header or text heuristic.
 *
 * WHY THE RECEIPT MUST RECORD IT AT REQUEST TIME. Only APPLY receipts retain a body (for byte-exact
 * recovery); RECORD receipts retain nothing. Recording correlation once, while the request is in
 * memory, lets later run aggregation include record-mode and applied calls without retaining content.
 *
 * WHAT IS PERSISTED IS A KEYED HASH, NEVER THE SESSION ID. `sessionCorrelationId` is
 * HMAC-SHA256(device salt, session id), truncated. It is:
 *  - DETERMINISTIC on this device, so the hook's run marker and the gateway's receipt equality-match
 *    without either ever writing the raw id;
 *  - STABLE across processes and restarts, because the salt is a file, not process state;
 *  - LOCAL, because the salt is generated on this device and never leaves it — this adds no new
 *    remotely transmitted identifier;
 *  - NON-REVERSIBLE in practice: recovering the session id needs the salt, which never leaves the
 *    device, and the input space is a v4 UUID.
 *
 * THE SALT IS THE ONLY NEW SECRET, and it is deliberately the smallest possible one: 32 random bytes
 * in `<config>/session-correlation-salt`, mode 0600, created on first use. It is not a credential, it
 * authenticates nothing, and losing it costs only the ability to correlate receipts written before it
 * changed. There was no existing device-local keyed-hash primitive to reuse: `credentials.json` holds
 * a device key pair but exists only after Community login, and correlation must work on an
 * account-free Open device too.
 */
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compactionConfigDir, type ConfigDirEnv } from "../config-dir.js";

/** The device-local salt file. Not a credential: it keys a local hash and authenticates nothing. */
export const SESSION_CORRELATION_SALT_FILE = "session-correlation-salt";

/** Hex characters kept from the HMAC. 16 bytes of a keyed digest — collision risk is not a concern. */
const CORRELATION_ID_LENGTH = 32;

/** Canonical shape emitted by every device-local session/turn correlation producer. */
export function validCorrelationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

/**
 * Read the device salt, creating it on first use. Returns `undefined` if the salt can neither be read
 * nor created — correlation then degrades to "unavailable", which callers treat as "cannot attribute",
 * never as "attribute to whatever run is open".
 */
const saltCache = new Map<string, Buffer | undefined>();

/** Drop the in-process salt cache. Tests that swap config dirs call this; production never needs it. */
export function resetSessionCorrelationCache(): void {
  saltCache.clear();
}

export function deviceCorrelationSalt(env: ConfigDirEnv = process.env): Buffer | undefined {
  const dir = compactionConfigDir(env);
  // MEMOISED PER CONFIG DIR. The gateway proxies EVERY request through here, and an uncached read
  // meant a synchronous `readFileSync` on the hot path of every provider call — measurable enough to
  // time out a parallel test suite, and pure waste in production since the salt never changes for the
  // life of a process. Keyed by directory so a test swapping `COMPACTION_CONFIG_DIR` is not served
  // another directory's salt.
  if (saltCache.has(dir)) return saltCache.get(dir);
  const salt = readOrCreateSalt(dir);
  saltCache.set(dir, salt);
  return salt;
}

function readOrCreateSalt(dir: string): Buffer | undefined {
  const path = join(dir, SESSION_CORRELATION_SALT_FILE);
  try {
    const existing = readFileSync(path);
    if (existing.length >= 16) return existing;
  } catch {
    // fall through to creation
  }
  try {
    mkdirSync(dir, { recursive: true });
    const salt = randomBytes(32);
    // `wx` so two processes racing on first use cannot clobber each other's salt; the loser re-reads.
    try {
      writeFileSync(path, salt, { flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
      return salt;
    } catch {
      const raced = readFileSync(path);
      return raced.length >= 16 ? raced : undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * The stable, device-local correlation id for one tool session id. NOT a run id: a single Claude Code
 * session contains many user runs, and run identity is the `UserPromptSubmit`→`Stop` interval recorded
 * separately (see `run-boundary.ts`). Conflating them would merge every prompt in a session.
 */
export function sessionCorrelationId(sessionId: string, env: ConfigDirEnv = process.env): string | undefined {
  if (typeof sessionId !== "string" || sessionId.trim() === "") return undefined;
  const salt = deviceCorrelationSalt(env);
  if (salt === undefined) return undefined;
  return createHmac("sha256", salt).update(`claude-code|${sessionId.trim()}`).digest("hex").slice(0, CORRELATION_ID_LENGTH);
}

/**
 * Device-local identity for one exact Claude Code session/prompt pair. Unlike the session-only
 * correlation above, the values are not trimmed: transcript reconciliation must bind the exact hook
 * identifiers byte-for-byte. Length prefixes keep the tuple unambiguous without persisting either id.
 */
export function claudePromptCorrelationId(
  sessionId: string,
  promptId: string,
  env: ConfigDirEnv = process.env
): string | undefined {
  if (
    typeof sessionId !== "string" ||
    typeof promptId !== "string" ||
    sessionId.length === 0 ||
    promptId.length === 0 ||
    sessionId.length > 512 ||
    promptId.length > 512
  ) return undefined;
  const salt = deviceCorrelationSalt(env);
  if (salt === undefined) return undefined;
  return createHmac("sha256", salt)
    .update(`claude-task-notification|${sessionId.length}:${sessionId}|${promptId.length}:${promptId}`)
    .digest("hex")
    .slice(0, CORRELATION_ID_LENGTH);
}

/** Strict, content-free Codex hook/header identifiers. Raw values are used only in memory. */
export function validCodexIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function codexCorrelationId(
  domain: "session" | "turn",
  values: readonly string[],
  env: ConfigDirEnv
): string | undefined {
  if (!values.every(validCodexIdentity)) return undefined;
  const salt = deviceCorrelationSalt(env);
  if (salt === undefined) return undefined;
  return createHmac("sha256", salt)
    .update(`codex-${domain}|${values.join("|")}`)
    .digest("hex")
    .slice(0, CORRELATION_ID_LENGTH);
}

/** Device-local keyed hash for a Codex session. The raw hook/header value is never persisted. */
export function codexSessionCorrelationId(
  sessionId: string,
  env: ConfigDirEnv = process.env
): string | undefined {
  return codexCorrelationId("session", [sessionId], env);
}

/** Device-local keyed hash for one Codex session+turn identity. */
export function codexTurnCorrelationId(
  sessionId: string,
  turnId: string,
  env: ConfigDirEnv = process.env
): string | undefined {
  return codexCorrelationId("turn", [sessionId, turnId], env);
}

/**
 * Extract the one exact `session-id` header Codex sends on model requests. `rawHeaders` is used so
 * duplicate fields cannot be collapsed by Node before validation. Missing, malformed, or repeated
 * values are uncorrelated; no first-value fallback is permitted.
 */
export function codexSessionCorrelationFromRawHeaders(
  rawHeaders: readonly string[],
  env: ConfigDirEnv = process.env
): string | undefined {
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === "session-id") values.push(rawHeaders[index + 1]);
  }
  if (values.length !== 1 || !validCodexIdentity(values[0])) return undefined;
  return codexSessionCorrelationId(values[0], env);
}

/**
 * The gateway's workflow-specific correlation rule. Codex uses only its artifact-proven request
 * header; every other workflow retains the existing Claude-compatible body extraction. Keeping the
 * branch here gives the hot path one tested decision and prevents either source from silently serving
 * as fallback for the other.
 */
export function gatewaySessionCorrelation(input: {
  workflow?: string;
  rawHeaders: readonly string[];
  bodyText: string;
  env?: ConfigDirEnv;
}): string | undefined {
  const env = input.env ?? process.env;
  return input.workflow === "codex"
    ? codexSessionCorrelationFromRawHeaders(input.rawHeaders, env)
    : sessionCorrelationFromRequestBody(input.bodyText, env);
}

/**
 * CONTENT-FREE extraction of the tool session id from a request body, in the same spirit as the
 * gateway's existing `model` extraction: one metadata field is read, no message content is touched.
 * Returns `undefined` for any shape we do not recognise — an unknown client is uncorrelated, not
 * guessed at.
 */
export function toolSessionIdFromRequestBody(bodyText: string): string | undefined {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const metadata = body.metadata as Record<string, unknown> | undefined;
  const userId = metadata?.user_id;
  if (typeof userId !== "string") return undefined;
  try {
    const parsed = JSON.parse(userId) as Record<string, unknown>;
    const sessionId = parsed.session_id;
    return typeof sessionId === "string" && sessionId.trim() !== "" ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

/** The correlation id for a request body, or `undefined` when the client carries no session id. */
export function sessionCorrelationFromRequestBody(
  bodyText: string,
  env: ConfigDirEnv = process.env
): string | undefined {
  const sessionId = toolSessionIdFromRequestBody(bodyText);
  return sessionId === undefined ? undefined : sessionCorrelationId(sessionId, env);
}
