import type { EngineReleaseManifest } from "../engine-install/manifest.js";
import type { ReleaseCompatibility } from "./compatibility.js";

export interface PairDescriptor {
  id: string;
  cli: {
    root: string;
    installRoot: string;
    version: string;
    integrity: string;
    source?: "npm-registry" | "local-artifact";
    provenance?: "verified" | "not-present" | "local-artifact";
    /** Complete package file inventory, hashed after installation verification. */
    files: Record<string, string>;
    compatibility: ReleaseCompatibility;
  };
  engine: { mode: "basic" } | {
    mode: "signed";
    artifactPath: string;
    manifest: EngineReleaseManifest;
    compatibility: ReleaseCompatibility;
    trust: "pinned-root";
  };
}

export type StagedIntent = "automatic" | "explicit";

export interface ManagedState {
  schema: 1;
  revision: number;
  current: PairDescriptor;
  previous?: PairDescriptor;
  staged?: PairDescriptor;
  stagedIntent?: StagedIntent;
  rejectedPairIds: string[];
  integrationSchema: 1;
}

export interface InstallationReceipt {
  schema: 1;
  kind: "compaction-managed";
  packageName: "@compaction/cli";
  root: string;
  launcherPath: string;
  launcherSha256: string;
  bootstrapInstallRoot?: string;
}

export interface ProcessIdentity {
  pid: number;
  birth: string;
  nonce: string;
}

export interface SessionLease {
  schema: 1;
  id: string;
  pair: PairDescriptor;
  owners: ProcessIdentity[];
  /** A new process group belongs to the admitted tool, including surviving grandchildren. */
  processGroups?: number[];
}
