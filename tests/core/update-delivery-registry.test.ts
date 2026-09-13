import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { currentReleaseCompatibility } from "../../src/core/update/compatibility.js";
import { discoverVersion, downloadPackage, registryRelease, verifyIntegrity } from "../../src/core/update/registry.js";
import { assertRootAuditOutput, isolatedPackageEnvironment } from "../../src/core/update/package-stage.js";

const bytes = Buffer.from("controlled public package fixture");
function metadata() { return { name: "@compaction/cli", version: "0.6.9", compactionRelease: currentReleaseCompatibility("0.6.9"),
  dist: { tarball: "https://registry.npmjs.org/@compaction/cli/-/cli-0.6.9.tgz", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } }; }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("public delivery discovery and verification", () => {
  it.each([["stable", "latest"], ["preview", "next"]] as const)("maps %s only to public npm %s without account or environment data", async (channel, tag) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(metadata()))); vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("NPM_TOKEN", "fixture-secret"); vi.stubEnv("OPENAI_API_KEY", "fixture-provider");
    await discoverVersion(channel);
    expect(fetcher.mock.calls[0][0]).toBe(`https://registry.npmjs.org/@compaction%2fcli/${tag}`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error", headers: { accept: "application/json" } });
    expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/fixture-secret|fixture-provider|device|repository/);
  });
  it("fails offline and on mismatched exact identity without a fallback request", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline")); vi.stubGlobal("fetch", fetcher);
    await expect(discoverVersion("stable")).rejects.toThrow("offline"); expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response(JSON.stringify(metadata())));
    await expect(discoverVersion("stable", "0.6.8")).rejects.toThrow("identity");
  });
  it("verifies downloaded bytes and rejects corrupt SRI or foreign artifact origins", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes)));
    expect(await downloadPackage(registryRelease(metadata()))).toEqual(bytes);
    expect(() => verifyIntegrity(Buffer.from("changed"), metadata().dist.integrity)).toThrow("integrity mismatch");
    for (const tarball of ["https://evil.invalid/cli.tgz", "https://registry.npmjs.org/@compaction/cli/-/cli.tgz?token=x"]) {
      expect(() => registryRelease({ ...metadata(), dist: { ...metadata().dist, tarball } })).toThrow("Untrusted");
    }
    expect(() => registryRelease({ ...metadata(), compactionRelease: { ...currentReleaseCompatibility("0.6.9"), meterVersion: "optimized-input-v3" } })).toThrow("metadata");
  });
  it.each(["https://slsa.dev/provenance/v0.2", "https://slsa.dev/provenance/v1"])("recognizes supported advertised predicate %s without treating it as verification", (predicateType) => {
    const release = registryRelease({ ...metadata(), dist: { ...metadata().dist, attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/@compaction%2fcli@0.6.9", provenance: { predicateType } } } });
    expect(release.hasProvenance).toBe(true);
    expect(() => assertRootAuditOutput('{"invalid":[],"missing":[]}', true)).toThrow("exact package root");
  });
  it("rejects malformed or unsupported advertisements; null cannot establish provenance", () => {
    expect(registryRelease({ ...metadata(), dist: { ...metadata().dist, attestations: null } }).hasProvenance).toBe(false);
    for (const attestations of [false, {}, { url: "https://evil.invalid/a" }, { url: "https://registry.npmjs.org/-/npm/v1/attestations/a", provenance: { predicateType: "https://slsa.dev/provenance/v0" } }]) {
      expect(() => registryRelease({ ...metadata(), dist: { ...metadata().dist, attestations } })).toThrow();
    }
  });
  it("requires discriminating exact-root signature and advertised attestation evidence", () => {
    const signed = "audited 1 package in 1s\n1 package has a verified registry signature\n";
    expect(() => assertRootAuditOutput(signed, false)).not.toThrow();
    expect(() => assertRootAuditOutput(signed, true)).toThrow();
    expect(() => assertRootAuditOutput(signed + "1 package has a verified attestation\n", true)).not.toThrow();
    for (const omitted of ["audited 0 packages in 1s", signed.replace("audited 1 package", "audited 2 packages"), signed.replace("verified registry signature", "missing registry signature")]) {
      expect(() => assertRootAuditOutput(omitted, false)).toThrow();
    }
  });
  it("isolates credential, proxy, npm and executable-option environment variables", () => {
    for (const key of ["NPM_TOKEN", "NODE_OPTIONS", "TAR_OPTIONS", "HTTP_PROXY", "npm_execpath", "OPENAI_API_KEY"]) vi.stubEnv(key, "fixture-private");
    const env = isolatedPackageEnvironment("/tmp/controlled-package-fixture");
    expect(JSON.stringify(env)).not.toContain("fixture-private");
    expect(env.NPM_CONFIG_IGNORE_SCRIPTS).toBe("true");
    expect(env.NPM_CONFIG_USERCONFIG).toBe("/tmp/controlled-package-fixture/npmrc");
  });
});
