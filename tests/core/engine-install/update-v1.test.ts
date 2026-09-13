import { createHash, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as manifests from "../../../src/core/engine-install/manifest.js";
import { generateDevSigningKeyPair, signManifest } from "../../../src/core/engine-install/dev-signing.js";
import { stageEngineRelease, readCurrentPointer, enginePointerPath, type EngineInstallOps } from "../../../src/core/engine-install/installer.js";
import { verifyInstalledArtifact, verifyManifestSignature } from "../../../src/core/engine-install/verify.js";
import { currentReleaseCompatibility, compatibleFull, parseReleaseCompatibility, compareReleaseVersions } from "../../../src/core/update/compatibility.js";
import { EngineSupervisor, resolveEngine } from "../../../src/core/gateway/engine-ipc/supervisor.js";
import { recordEngineEulaAcceptance, engineEulaAccepted, readEngineEulaAcceptance } from "../../../src/core/legal/engine-eula.js";
import { writeStoredCredentials } from "../../../src/core/auth/credentials.js";

const cli = currentReleaseCompatibility("0.6.8-preview.1");
const artifact = Buffer.from(`
let input = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  if(input.length < 4 || input.length < input.readUInt32BE(0) + 4) return;
  const request = JSON.parse(input.subarray(4, input.readUInt32BE(0) + 4).toString());
  const body = Buffer.from(JSON.stringify({protocol_version:1, request_id:request.request_id,
    result:'noop', applied_components:[], recovery_required:false}));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([prefix,body]), () => setTimeout(() => process.exit(0), 10));
});
`);
const manifest: manifests.EngineReleaseManifestV2 = {
  schema_version: 2, version: "0.6.8", channel: "stable", platform: "any", arch: "any",
  artifact_kind: "node-script", sha256: createHash("sha256").update(artifact).digest("hex"), size_bytes: artifact.length,
  cli_min_version: "0.6.0", cli_max_version: "0.7.0", engine_protocol: 1,
  usage_schema_version: 3, meter_version: "optimized-input-v2", eula_version: "1.0"
};
let dir: string;
let env: NodeJS.ProcessEnv;
let pair: ReturnType<typeof generateDevSigningKeyPair>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "update-engine-"));
  env = { COMPACTION_CONFIG_DIR: dir };
  pair = generateDevSigningKeyPair();
  // Synthetic production-trust fixture: real Ed25519, a throwaway root scoped to this test only.
  vi.spyOn(manifests, "pinnedRootKeys").mockReturnValue([{key_id:"test-only",public_key_spki_b64u:pair.publicKeySpkiB64u,
    authorization:{kind:"current-release",schema_version:2}}]);
  writeStoredCredentials({schema_version:1,api_url:"http://127.0.0.1:9",account_id:"test",device_id:"test",
    device_token:"test-only",device_private_key_pem:pair.privateKeyPem,device_public_key:pair.publicKeySpkiB64u,
    created_at:new Date().toISOString()}, env);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
function ops(value = manifest): EngineInstallOps & { download: ReturnType<typeof vi.fn> } {
  return {
    fetchLatestRelease: async () => ({manifest:manifests.canonicalManifestBytes(value).toString(),
      signature:signManifest(value,pair.privateKeyPem),artifact_url:"http://127.0.0.1:9/artifact"}),
    download:vi.fn(async (_url, target) => { writeFileSync(target, artifact); })
  };
}

describe("signed update compatibility", () => {
  it("identifies the production root that authorized a compatible schema-v2 manifest", () => {
    expect(verifyManifestSignature(manifests.canonicalManifestBytes(manifest), signManifest(manifest, pair.privateKeyPem), env))
      .toEqual({ verified: true, trust: "pinned-root", key_id: "test-only" });
  });
  it("validates actual CLI release metadata and exclusive ranges without inferring from version", () => {
    expect(parseReleaseCompatibility(cli,cli.cliVersion)).toEqual(cli);
    expect(parseReleaseCompatibility(cli,"0.6.8")).toBeUndefined();
    expect(parseReleaseCompatibility({...cli,gatewayProtocol:2})).toBeUndefined();
    expect(parseReleaseCompatibility({...cli,minEngineVersion:cli.maxEngineVersion})).toBeUndefined();
    expect(compareReleaseVersions("0.6.8-preview.01","0.6.8")).toBeUndefined();
    expect(compareReleaseVersions("0.6.8-preview.2","0.6.8-preview.10")).toBe(-1);
  });
  it("keeps exact v1 canonical bytes and refuses unsigned v1 compatibility extensions", () => {
    const old: manifests.EngineReleaseManifestV1 = {schema_version:1,version:"0.6.8",channel:"stable",platform:"any",
      arch:"any",artifact_kind:"node-script",sha256:"a".repeat(64),size_bytes:12};
    expect(manifests.canonicalManifestBytes(old).toString()).toBe('{"schema_version":1,"version":"0.6.8","channel":"stable","platform":"any","arch":"any","artifact_kind":"node-script","sha256":"'+"a".repeat(64)+'","size_bytes":12}');
    const parsed = manifests.parseEngineReleaseManifest(JSON.stringify({...manifest,...old}));
    expect(parsed).toEqual(old);
    expect(compatibleFull(cli,{verified:true,trust:"pinned-root",manifest:parsed!},"1.0")).toBe(false);
  });
  it("allows a preview CLI with a stable production-signed compatible engine", () => {
    expect(compatibleFull(cli,{verified:true,trust:"pinned-root",manifest},"1.0")).toBe(true);
    expect(compatibleFull(cli,{verified:true,trust:"dev-root",manifest},"1.0")).toBe(false);
    expect(compatibleFull({...cli,cliVersion:"0.7.0"},{verified:true,trust:"pinned-root",manifest},"1.0")).toBe(false);
    expect(compatibleFull({...cli,maxEngineVersion:"0.6.8"},{verified:true,trust:"pinned-root",manifest},"1.0")).toBe(false);
  });
  it.each([
    {cli_min_version:"0.6.9"},{cli_max_version:"0.6.8-preview.1"},{engine_protocol:2},
    {usage_schema_version:2},{meter_version:"optimized-input-v1"},{eula_version:"2.0"}
  ])("rejects incompatible field %j and cryptographically covers it", (change) => {
    const changed = {...manifest,...change};
    expect(compatibleFull(cli,{verified:true,trust:"pinned-root",manifest:changed},"1.0")).toBe(false);
    expect(verifyManifestSignature(manifests.canonicalManifestBytes(changed),signManifest(manifest,pair.privateKeyPem),env).verified).toBe(false);
  });
});

describe("verified staging and session pin", () => {
  it("refuses an incompatible signed release before downloading", async () => {
    recordEngineEulaAcceptance(env);
    const io = ops({...manifest,engine_protocol:2});
    await expect(stageEngineRelease({env,ops:io,compatibility:cli})).rejects.toMatchObject({code:"release-incompatible"});
    expect(io.download).not.toHaveBeenCalled();
  });
  it("refuses terms this CLI cannot present even with a matching helper record, preserving older acceptances", async () => {
    const previous = recordEngineEulaAcceptance(env);
    const changed = {...manifest,eula_version:"2.0"};
    const io = ops(changed);
    await expect(stageEngineRelease({env,ops:io,compatibility:cli})).rejects.toMatchObject({code:"eula-not-accepted",requiredEulaVersion:"2.0"});
    expect(io.download).not.toHaveBeenCalled();
    expect(readCurrentPointer(env)).toBeUndefined();
    recordEngineEulaAcceptance(env,new Date(),"2.0");
    expect(engineEulaAccepted(env,"1.0")).toBe(true);
    expect(readEngineEulaAcceptance(env,"1.0")).toEqual(previous);
    await expect(stageEngineRelease({env,ops:io,compatibility:cli})).rejects.toMatchObject({code:"eula-not-accepted",requiredEulaVersion:"2.0"});
    expect(io.download).not.toHaveBeenCalled();
    expect(readCurrentPointer(env)).toBeUndefined();
  });
  it.each(["unsigned", "tampered", "malformed", "noncanonical", "malformed-version"])("does not trust EULA metadata from a %s manifest", async kind => {
    const changed = { ...manifest, eula_version: "2.0" };
    const text = kind === "malformed" ? "{\"eula_version\":\"2.0\"" :
      kind === "noncanonical" ? JSON.stringify(changed, null, 2) :
      kind === "malformed-version" ? JSON.stringify({ ...changed, eula_version: "2.0 invalid" }) :
      manifests.canonicalManifestBytes(changed).toString();
    const signature = kind === "unsigned" ? "" : kind === "tampered" ? signManifest(manifest, pair.privateKeyPem) :
      sign(null, Buffer.from(text), pair.privateKeyPem).toString("base64url");
    const io = ops();
    io.fetchLatestRelease = async () => ({ manifest: text, signature, artifact_url: "http://127.0.0.1:9/artifact" });
    const error = await stageEngineRelease({ env, ops: io, compatibility: cli }).catch(error => error);
    expect(error.code).toBe(["unsigned", "tampered"].includes(kind) ? "signature-invalid" : "manifest-invalid");
    expect(error.requiredEulaVersion).toBeUndefined();
    expect(io.download).not.toHaveBeenCalled();
  });
  it("reports the verified known version before consent and reverifies metadata on retry", async () => {
    const io = ops();
    await expect(stageEngineRelease({ env, ops: io, compatibility: cli })).rejects.toMatchObject({
      code: "eula-not-accepted", requiredEulaVersion: "1.0"
    });
    expect(io.download).not.toHaveBeenCalled();
    recordEngineEulaAcceptance(env);
    io.fetchLatestRelease = async () => ({ manifest: manifests.canonicalManifestBytes(manifest).toString(),
      signature: "invalid", artifact_url: "http://127.0.0.1:9/artifact" });
    await expect(stageEngineRelease({ env, ops: io, compatibility: cli })).rejects.toMatchObject({ code: "signature-invalid" });
    expect(io.download).not.toHaveBeenCalled();
  });
  it("stages concurrent releases in distinct verified directories without promoting either", async () => {
    recordEngineEulaAcceptance(env);
    const [a,b] = await Promise.all([stageEngineRelease({env,ops:ops(),compatibility:cli}),stageEngineRelease({env,ops:ops(),compatibility:cli})]);
    expect(a.artifactPath).not.toBe(b.artifactPath);
    expect(readCurrentPointer(env)).toBeUndefined();
    for (const value of [a,b]) {
      expect(verifyInstalledArtifact(value.artifactPath,env)).toEqual({verified:true,trust:"pinned-root",key_id:"test-only",manifest});
      expect(readFileSync(join(dirname(value.artifactPath),"manifest.json"),"utf8")).toBe(manifests.canonicalManifestBytes(manifest).toString());
    }
  });
  it("rejects altered download bytes without publishing a pointer", async () => {
    recordEngineEulaAcceptance(env);
    const io=ops(); io.download.mockImplementation(async (_url,target) => writeFileSync(target,"altered"));
    await expect(stageEngineRelease({env,ops:io,compatibility:cli})).rejects.toMatchObject({code:"artifact-digest-mismatch"});
    expect(readCurrentPointer(env)).toBeUndefined();
  });
  it("restarts the pinned signed artifact after current changes, and refuses subsequent artifact tamper", async () => {
    recordEngineEulaAcceptance(env);
    const staged = await stageEngineRelease({env,ops:ops(),compatibility:cli});
    const pin = {artifactPath:staged.artifactPath,manifest:staged.manifest,compatibility:cli};
    expect(resolveEngine({env,verifiedInstalledArtifact:pin})).toMatchObject({source:"installed",path:realpathSync(staged.artifactPath),installed:{trust:"pinned-root"}});
    const supervisor = new EngineSupervisor({env,verifiedInstalledArtifact:pin});
    try {
      expect(await supervisor.ping()).toBe(true);
      await new Promise(resolve => setTimeout(resolve,300));
      writeFileSync(enginePointerPath(env),join(dir,"missing-engine"));
      pin.artifactPath = join(dir,"caller-mutated");
      expect(await supervisor.ping()).toBe(true);
      await new Promise(resolve => setTimeout(resolve,300));
      writeFileSync(staged.artifactPath,"throw Error('never execute')");
      expect(await supervisor.ping()).toBe(false);
    } finally { supervisor.dispose(); }
  });
  it("Basic suppresses ambient overrides, and production pins reject escaping realpaths", async () => {
    recordEngineEulaAcceptance(env);
    const staged = await stageEngineRelease({env,ops:ops(),compatibility:cli});
    expect(resolveEngine({env:{...env,COMPACTION_ENGINE_PATH:staged.artifactPath},enginePath:staged.artifactPath,
      verifiedInstalledArtifact:null})).toMatchObject({path:null,source:"none"});
    const outside = join(dir,"outside"); writeFileSync(outside,artifact);
    const link = join(dirname(staged.artifactPath),"escape"); symlinkSync(outside,link);
    expect(resolveEngine({env,verifiedInstalledArtifact:{artifactPath:link,manifest,compatibility:cli}})).toMatchObject({path:null,unverifiedReason:"pointer-escape"});
  });
  it("rejects changed signed metadata even when artifact bytes still verify", async () => {
    recordEngineEulaAcceptance(env);
    const staged = await stageEngineRelease({env,ops:ops(),compatibility:cli});
    const changed = {...manifest,cli_max_version:"0.8.0"};
    writeFileSync(join(dirname(staged.artifactPath),"manifest.json"),manifests.canonicalManifestBytes(changed));
    writeFileSync(join(dirname(staged.artifactPath),"manifest.sig"),signManifest(changed,pair.privateKeyPem));
    expect(verifyInstalledArtifact(staged.artifactPath,env).verified).toBe(true);
    expect(resolveEngine({env,verifiedInstalledArtifact:{artifactPath:staged.artifactPath,manifest,compatibility:cli}}))
      .toMatchObject({path:null,unverifiedReason:"release-incompatible"});
  });
});
