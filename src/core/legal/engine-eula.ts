/**
 * Engine License Agreement acceptance (PUBLIC CLI/core, network-free, engine-free).
 *
 * THE OPEN CLIENT ASKS FOR NOTHING. Apache-2.0 governs everything in this package, and a user who
 * never acquires the Hybrid Engine is never shown this and never records anything. The agreement
 * exists for exactly one act: putting the SEPARATELY DISTRIBUTED Engine on the machine. So the gate
 * sits at acquisition, not at install, not at first run, and not in onboarding generally.
 *
 * WHY A LOCAL RECORD AND NOT A SERVER FLAG. Acceptance is a statement about THIS DEVICE receiving
 * THIS ARTIFACT. Recording it locally keeps the gate on the client. Signed manifest v2 names the
 * required agreement version; legacy v1 uses the shipped agreement version. Records contain only
 * a version and timestamp, with prior acceptances retained for pinned older releases.
 *
 * RE-ACCEPTANCE IS BUILT IN. The recorded version is compared against `ENGINE_EULA_VERSION`. A future
 * agreement version simply stops matching, so the next acquisition asks again. Nothing has to
 * remember to invalidate anything.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compactionConfigDir, type ConfigDirEnv } from "../config-dir.js";
import { webUrl, type EnvLike } from "../web-origin.js";

/**
 * The version of the Engine License Agreement this build asks users to accept.
 *
 * A SHIPPED CONSTANT WITH LEGAL WEIGHT: it is what gets written to disk as the thing the user agreed
 * to. Bump it in the same change that changes the operative text, never separately.
 */
export const ENGINE_EULA_VERSION = "1.0";

/** Acquisition cannot infer informed consent to terms this CLI cannot present. */
export function canPresentEngineEula(version: string): boolean {
  return version === ENGINE_EULA_VERSION;
}

/** The canonical site route carrying the operative agreement text. */
export const ENGINE_EULA_PATH = "/eula";

/** Where the agreement can be read. Follows `COMPACTION_WEB_ORIGIN`, like every other handoff. */
export function engineEulaUrl(env: EnvLike = process.env): string {
  return webUrl(ENGINE_EULA_PATH, env);
}

/**
 * The points a user must have in front of them before accepting — a SUMMARY, never a substitute.
 * Every surface that asks for acceptance prints these and the URL, so no one is asked to agree to a
 * document they were only told the name of.
 */
export const ENGINE_EULA_SUMMARY: readonly string[] = [
  "The Hybrid Engine is licensed to you, not sold, and is delivered separately from this package.",
  "It is free for Community accounts, and running it depends on a valid entitlement.",
  "It runs locally on your machine and is never given your provider credentials.",
  "Your content stays yours; usage records carry identifiers, counts, and status labels only.",
  "The Apache-2.0 licence continues to govern the Compaction CLI and core in this package."
];

/** What is on disk once a user has accepted. Content-free by construction. */
export interface EngineEulaAcceptance {
  version: string;
  accepted_at: string;
}

/** `<config dir>/engine-eula.json`. */
export function engineEulaAcceptancePath(env: ConfigDirEnv = process.env): string {
  return join(compactionConfigDir(env), "engine-eula.json");
}

/**
 * The recorded acceptance, or nothing.
 *
 * NEVER THROWS, and a malformed file reads as NO acceptance rather than as an error or as consent.
 * The file is user-writable state, so the only safe reading of anything unexpected is "not accepted".
 */
export function readEngineEulaAcceptance(env: ConfigDirEnv = process.env, version?: string): EngineEulaAcceptance | undefined {
  let raw: unknown;
  try {
    const latest = JSON.parse(readFileSync(engineEulaAcceptancePath(env), "utf8"));
    raw = version === undefined || latest?.version === version ? latest
      : JSON.parse(readFileSync(versionedAcceptancePath(env, version), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const { version: recordedVersion, accepted_at: acceptedAt } = raw as { version?: unknown; accepted_at?: unknown };
  if (typeof recordedVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(recordedVersion)) return undefined;
  if (typeof acceptedAt !== "string" || acceptedAt.trim() === "") return undefined;
  return { version: recordedVersion, accepted_at: acceptedAt };
}

/** Whether THIS build's agreement version has been accepted on this device. */
export function engineEulaAccepted(env: ConfigDirEnv = process.env, version = ENGINE_EULA_VERSION): boolean {
  return readEngineEulaAcceptance(env, version)?.version === version;
}

function versionedAcceptancePath(env: ConfigDirEnv, version: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) throw new Error("invalid EULA version");
  return join(compactionConfigDir(env), "engine-eula-acceptances", `${version}.json`);
}

/**
 * Record an acceptance. Callers must only reach this after an EXPLICIT affirmative act by the user —
 * a typed confirmation, a chosen "Accept" item, or `--accept-license` on the command line. Nothing
 * in this module infers consent from anything.
 */
export function recordEngineEulaAcceptance(
  env: ConfigDirEnv = process.env,
  now: Date = new Date(),
  version = ENGINE_EULA_VERSION
): EngineEulaAcceptance {
  const archivePath = versionedAcceptancePath(env, version);
  const record: EngineEulaAcceptance = { version, accepted_at: now.toISOString() };
  const dir = compactionConfigDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "engine-eula-acceptances"), { recursive: true, mode: 0o700 });
  const previous = readEngineEulaAcceptance(env);
  if (previous) {
    writeFileSync(versionedAcceptancePath(env, previous.version), `${JSON.stringify(previous)}\n`, { mode: 0o600 });
  }
  writeFileSync(archivePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const path = engineEulaAcceptancePath(env);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes; the content is not secret, only tidy.
  }
  return record;
}
