import type { EngineReleaseManifest } from "../engine-install/manifest.js";
import type { EngineTrustSource } from "../engine-install/verify.js";

/** Content-free contracts a CLI release can actually speak. */
export interface ReleaseCompatibility {
  cliVersion: string;
  launcherProtocol: number;
  integrationProtocol: number;
  gatewayProtocol: number;
  controlPlaneProtocol: number;
  engineProtocol: number;
  minEngineVersion: string;
  /** Exclusive upper bound; minimum is inclusive. */
  maxEngineVersion: string;
  usageSchemaVersion: number;
  meterVersion: string;
}

export function currentReleaseCompatibility(cliVersion: string): ReleaseCompatibility {
  return {
    cliVersion, launcherProtocol: 1, integrationProtocol: 1, gatewayProtocol: 1,
    controlPlaneProtocol: 1, engineProtocol: 1,
    minEngineVersion: "0.0.0", maxEngineVersion: "1.0.0",
    usageSchemaVersion: 3, meterVersion: "optimized-input-v2"
  };
}

/**
 * WHETHER A PAIR CAN METER INPUT COMPACTION AT ALL — the ONE capability question the meter unit
 * actually decides, asked of the pair rather than of a request.
 *
 * `compatibleFull` already compares `engine.meter_version` to `cli.meterVersion`, but it is only
 * consulted on the SESSION-PIN resolution path. The ambient `current`-pointer path — the one a plain
 * `compaction gateway start` takes — checks pointer containment, signature, and digest, and never
 * evaluates the compatibility tuple. So an engine whose manifest predates the tuple (schema v1, which
 * has no field to declare a meter unit in) is admitted, spawned, and does the work; the client then
 * refuses to place the debit at request time and forwards the original unchanged. The capability is
 * dead and the only signal is a per-request log line.
 *
 * This predicate is the missing half: the same declared contract, readable WITHOUT a session pin, so
 * an incompatible pair is a named state a surface can show instead of a silent per-request discard.
 *
 * THREE STATES, because two would have to lie about one of them:
 *  - `supported`   — a signed manifest declares exactly this client's active unit.
 *  - `unsupported` — a signed manifest that declares a DIFFERENT unit, or (schema v1) cannot declare
 *                    one at all. A positive, signed statement that no debit can be placed.
 *  - `unknown`     — there is no signed manifest to read (dev build, `COMPACTION_ENGINE_PATH`, an
 *                    explicit path option, or no engine). NOT a claim in either direction: the
 *                    request-time guard stays the authority for these, exactly as before.
 *
 * `unknown` is deliberately NOT folded into `unsupported`. The dev build stamps the active unit at
 * runtime and carries no manifest, so collapsing the two would switch input compaction off for every
 * dev and test run on the strength of a declaration that was never meant to exist there.
 *
 * This NEVER infers a unit. An undeclared unit stays unplaceable (see `USAGE_METER_VERSION_UNDECLARED`);
 * nothing here makes an unknown quantity debitable.
 */
export type EngineInputCompactionSupport =
  | { support: "supported"; meterVersion: string }
  | { support: "unsupported"; reason: "meter-undeclared" | "meter-mismatch"; declaredMeterVersion?: string }
  | { support: "unknown" };

export function engineInputCompactionSupport(
  cli: Pick<ReleaseCompatibility, "meterVersion">,
  manifest: EngineReleaseManifest | undefined
): EngineInputCompactionSupport {
  if (manifest === undefined) return { support: "unknown" };
  // A schema v1 manifest has no `meter_version` field, so its silence is not an omission the engine
  // could have corrected — the schema predates the contract. Named distinctly from a mismatch so a
  // surface can tell "too old to say" from "says something else".
  if (manifest.schema_version !== 2) return { support: "unsupported", reason: "meter-undeclared" };
  if (manifest.meter_version !== cli.meterVersion) {
    return { support: "unsupported", reason: "meter-mismatch", declaredMeterVersion: manifest.meter_version };
  }
  return { support: "supported", meterVersion: manifest.meter_version };
}

/** Parse the release tuple embedded in the CLI's own package metadata, fail closed on drift. */
export function parseReleaseCompatibility(value: unknown, cliVersion?: string): ReleaseCompatibility | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.cliVersion !== "string" || (cliVersion !== undefined && raw.cliVersion !== cliVersion) ||
      compareReleaseVersions(raw.cliVersion, raw.cliVersion) !== 0 ||
      typeof raw.minEngineVersion !== "string" || typeof raw.maxEngineVersion !== "string" ||
      compareReleaseVersions(raw.minEngineVersion, raw.maxEngineVersion) !== -1 ||
      raw.launcherProtocol !== 1 || raw.integrationProtocol !== 1 || raw.gatewayProtocol !== 1 ||
      raw.controlPlaneProtocol !== 1 || raw.engineProtocol !== 1 || raw.usageSchemaVersion !== 3 ||
      raw.meterVersion !== "optimized-input-v2") return undefined;
  return {
    cliVersion: raw.cliVersion, launcherProtocol: 1, integrationProtocol: 1, gatewayProtocol: 1,
    controlPlaneProtocol: 1, engineProtocol: 1, minEngineVersion: raw.minEngineVersion,
    maxEngineVersion: raw.maxEngineVersion, usageSchemaVersion: 3, meterVersion: "optimized-input-v2"
  };
}

/** Strict SemVer comparison; unknown version labels never establish compatibility. */
export function compareReleaseVersions(left: string, right: string): number | undefined {
  const parse = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  const a = parse(left), b = parse(right);
  if (!a || !b || [a[4], b[4]].some(part => part?.split(".").some(id => /^0\d+$/.test(id)))) return undefined;
  if ([...a.slice(1,4), ...b.slice(1,4)].some(part => !Number.isSafeInteger(Number(part)))) return undefined;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]) ? -1 : 1;
  }
  if (a[4] === b[4]) return 0;
  if (a[4] === undefined) return 1;
  if (b[4] === undefined) return -1;
  const aa = a[4].split("."), bb = b[4].split(".");
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined) return -1;
    if (bb[i] === undefined) return 1;
    if (aa[i] === bb[i]) continue;
    const an = /^\d+$/.test(aa[i]), bn = /^\d+$/.test(bb[i]);
    if (an && bn) return BigInt(aa[i]) < BigInt(bb[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return aa[i] < bb[i] ? -1 : 1;
  }
  return 0;
}

function within(version: string, min: string, max: string): boolean {
  const lower = compareReleaseVersions(version, min), upper = compareReleaseVersions(version, max);
  return lower !== undefined && upper !== undefined && lower >= 0 && upper < 0;
}

/** A v1 manifest or a dev signature is never evidence for managed Full mode. */
export function compatibleFull(
  cli: ReleaseCompatibility,
  verified: { verified: true; trust: EngineTrustSource; manifest: EngineReleaseManifest },
  acceptedEulaVersion?: string
): boolean {
  const engine = verified.manifest;
  return verified.verified === true && verified.trust === "pinned-root" && engine.schema_version === 2 &&
    cli.launcherProtocol === 1 && cli.integrationProtocol === 1 && cli.gatewayProtocol === 1 &&
    cli.controlPlaneProtocol === 1 && cli.engineProtocol === 1 && engine.engine_protocol === cli.engineProtocol &&
    cli.usageSchemaVersion === 3 && engine.usage_schema_version === cli.usageSchemaVersion &&
    cli.meterVersion === "optimized-input-v2" && engine.meter_version === cli.meterVersion &&
    engine.eula_version === acceptedEulaVersion &&
    within(cli.cliVersion, engine.cli_min_version, engine.cli_max_version) &&
    within(engine.version, cli.minEngineVersion, cli.maxEngineVersion);
}
