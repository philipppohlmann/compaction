import { createHash, timingSafeEqual } from "node:crypto";
import { parseReleaseCompatibility, compareReleaseVersions, type ReleaseCompatibility } from "./compatibility.js";

export const PACKAGE_NAME = "@compaction/cli";
export const REGISTRY = "https://registry.npmjs.org";
export type UpdateChannel = "stable" | "preview";

export interface RegistryRelease {
  name: typeof PACKAGE_NAME;
  version: string;
  tarball: string;
  integrity: string;
  compatibility: ReleaseCompatibility;
  hasProvenance: boolean;
}

export function releaseCompatibility(value: unknown, version: string): ReleaseCompatibility {
  const parsed = parseReleaseCompatibility(value, version);
  if (!parsed) throw new Error("Missing or incompatible release metadata.");
  return parsed;
}

export function parseIntegrity(value: unknown): { algorithm: "sha256" | "sha512"; digest: Buffer } {
  if (typeof value !== "string") throw new Error("Missing package integrity.");
  const match = /^(sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error("Unsupported package integrity.");
  const algorithm = match[1] as "sha256" | "sha512";
  const digest = Buffer.from(match[2], "base64");
  if (digest.length !== (algorithm === "sha512" ? 64 : 32) || digest.toString("base64") !== match[2]) {
    throw new Error("Invalid package integrity.");
  }
  return { algorithm, digest };
}

export function verifyIntegrity(bytes: Uint8Array, integrity: string): void {
  const { algorithm, digest } = parseIntegrity(integrity);
  if (!timingSafeEqual(createHash(algorithm).update(bytes).digest(), digest)) {
    throw new Error("Package integrity mismatch.");
  }
}

export function publicTarballUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing package artifact URL.");
  const url = new URL(value);
  if (url.origin !== REGISTRY || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith("/@compaction/cli/-/")) throw new Error("Untrusted package artifact URL.");
  return url.href;
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`Public registry returned HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("Registry response exceeds the size limit.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

export async function discoverVersion(channel: UpdateChannel, exactVersion?: string): Promise<Record<string, unknown>> {
  if (channel !== "stable" && channel !== "preview") throw new Error("Unknown update channel.");
  if (exactVersion !== undefined && compareReleaseVersions(exactVersion, exactVersion) === undefined) {
    throw new Error("Expected an exact package version.");
  }
  const target = exactVersion ?? (channel === "stable" ? "latest" : "next");
  const response = await fetch(`${REGISTRY}/@compaction%2fcli/${encodeURIComponent(target)}`, {
    headers: { accept: "application/json" }, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10_000)
  });
  const value: unknown = JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid registry metadata.");
  const record = value as Record<string, unknown>;
  if (record.name !== PACKAGE_NAME || typeof record.version !== "string" ||
      compareReleaseVersions(record.version, record.version) === undefined ||
      (exactVersion !== undefined && record.version !== exactVersion)) throw new Error("Registry package identity mismatch.");
  return record;
}

export function registryRelease(metadata: Record<string, unknown>): RegistryRelease {
  const version = metadata.version;
  const dist = metadata.dist as Record<string, unknown> | undefined;
  if (metadata.name !== PACKAGE_NAME || typeof version !== "string" || !dist) throw new Error("Invalid package metadata.");
  parseIntegrity(dist.integrity);
  let hasProvenance = false;
  if (dist.attestations != null) {
    if (typeof dist.attestations !== "object" || Array.isArray(dist.attestations)) throw new Error("Invalid attestation metadata.");
    const attestations = dist.attestations as Record<string, unknown>;
    const url = new URL(String(attestations.url));
    if (url.origin !== REGISTRY || url.username || url.password || url.search || url.hash ||
        !url.pathname.startsWith("/-/npm/v1/attestations/")) throw new Error("Invalid attestation URL.");
    const provenance = attestations.provenance as Record<string, unknown> | undefined;
    if (provenance !== undefined) {
      if (!provenance || !["https://slsa.dev/provenance/v0.2", "https://slsa.dev/provenance/v1"].includes(String(provenance.predicateType))) throw new Error("Unsupported provenance predicate.");
      hasProvenance = true;
    }
  }
  return {
    name: PACKAGE_NAME, version, tarball: publicTarballUrl(dist.tarball), integrity: dist.integrity as string,
    compatibility: releaseCompatibility(metadata.compactionRelease, version), hasProvenance
  };
}

export async function downloadPackage(release: RegistryRelease): Promise<Buffer> {
  const response = await fetch(publicTarballUrl(release.tarball), {
    redirect: "error", credentials: "omit", signal: AbortSignal.timeout(60_000)
  });
  const bytes = await readBounded(response, 64 * 1024 * 1024);
  verifyIntegrity(bytes, release.integrity);
  return bytes;
}
