import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseReleaseCompatibility, type ReleaseCompatibility } from "./compatibility.js";

const ENTRY_SUFFIX = path.join("lib", "node_modules", "@compaction", "cli", "dist", "cli", "index.js");

export interface OfficialNpmGlobalInstallation {
  kind: "official-npm-global";
  prefix: string;
  launcherPath: string;
  packageRoot: string;
  entryPath: string;
  version: string;
  compatibility: ReleaseCompatibility;
}

export type NpmGlobalOwnership = OfficialNpmGlobalInstallation | {
  kind: "unsupported";
  reason: string;
  /** True only after the canonical npm-global package location itself was proven. */
  officialLayoutCandidate: boolean;
};

/** Exact supported npm-global layout. No path search, package-manager guess, or foreign launcher adoption. */
export function classifyOfficialNpmGlobalEntry(entry: string | undefined): NpmGlobalOwnership {
  if (!entry || !path.isAbsolute(entry)) return { kind: "unsupported", reason: "entrypoint is not an absolute installed path", officialLayoutCandidate: false };
  let officialLayoutCandidate = false;
  try {
    const resolvedEntry = realpathSync(entry);
    if (/(?:^|[\\/])(?:Cellar|Caskroom)(?:[\\/])/.test(resolvedEntry)) {
      return { kind: "unsupported", reason: "entrypoint is owned by another package manager", officialLayoutCandidate: false };
    }
    if (!resolvedEntry.endsWith(`${path.sep}${ENTRY_SUFFIX}`)) {
      return { kind: "unsupported", reason: "entrypoint is not in the supported npm-global layout", officialLayoutCandidate: false };
    }
    const prefix = resolvedEntry.slice(0, -(ENTRY_SUFFIX.length + 1));
    const packageRoot = path.join(prefix, "lib", "node_modules", "@compaction", "cli");
    const canonicalEntry = path.join(packageRoot, "dist", "cli", "index.js");
    const launcherPath = path.join(prefix, "bin", "compaction");
    const packageFile = path.join(packageRoot, "package.json");
    if (!existsSync(launcherPath) || !existsSync(packageFile)) {
      return { kind: "unsupported", reason: "npm-global ownership could not be verified", officialLayoutCandidate: false };
    }
    officialLayoutCandidate = true;
    if (!prefix || realpathSync(prefix) !== prefix || realpathSync(packageRoot) !== packageRoot
      || realpathSync(canonicalEntry) !== canonicalEntry || resolvedEntry !== canonicalEntry
      || !lstatSync(canonicalEntry).isFile() || lstatSync(canonicalEntry).isSymbolicLink()
      || !lstatSync(packageFile).isFile() || lstatSync(packageFile).isSymbolicLink()) {
      return { kind: "unsupported", reason: "npm-global package paths are linked or noncanonical", officialLayoutCandidate: true };
    }
    const launcher = lstatSync(launcherPath);
    if (!launcher.isSymbolicLink()
      || path.resolve(path.dirname(launcherPath), readlinkSync(launcherPath)) !== canonicalEntry
      || realpathSync(launcherPath) !== canonicalEntry) {
      return { kind: "unsupported", reason: "npm-global launcher does not exactly target the package entrypoint", officialLayoutCandidate: true };
    }
    const pkg: unknown = JSON.parse(readFileSync(packageFile, "utf8"));
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
      return { kind: "unsupported", reason: "npm-global package metadata is invalid", officialLayoutCandidate: true };
    }
    const record = pkg as Record<string, unknown>;
    const bin = record.bin;
    const version = record.version;
    const compatibility = typeof version === "string" ? parseReleaseCompatibility(record.compactionRelease, version) : undefined;
    if (record.name !== "@compaction/cli" || typeof version !== "string" || !bin || typeof bin !== "object" || Array.isArray(bin)
      || JSON.stringify(Object.keys(bin as object).sort()) !== JSON.stringify(["compaction"])
      || (bin as Record<string, unknown>).compaction !== "dist/cli/index.js" || !compatibility
      || JSON.stringify(record.compactionRelease) !== JSON.stringify(compatibility)) {
      return { kind: "unsupported", reason: "npm-global package identity or release metadata does not match", officialLayoutCandidate: true };
    }
    return { kind: "official-npm-global", prefix, launcherPath, packageRoot, entryPath: canonicalEntry, version, compatibility };
  } catch {
    return { kind: "unsupported", reason: "npm-global ownership could not be verified", officialLayoutCandidate };
  }
}
