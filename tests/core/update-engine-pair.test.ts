import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as installer from "../../src/core/engine-install/installer.js";
import * as manifests from "../../src/core/engine-install/manifest.js";
import { signManifest, generateDevSigningKeyPair } from "../../src/core/engine-install/dev-signing.js";
import { recordEngineEulaAcceptance, engineEulaAccepted } from "../../src/core/legal/engine-eula.js";
import { selectCandidateEngine, stageManagedEngine } from "../../src/core/update/engine-pair.js";
import { createPair } from "../../src/core/update/pair.js";
import { bootstrapManagedInstall, inventoryRelease, loadExecutingManagedInstallation } from "../../src/core/update/ownership.js";
import { currentReleaseCompatibility } from "../../src/core/update/compatibility.js";
import { atomicWrite, readState } from "../../src/core/update/state.js";
import { stagePair, tryActivate } from "../../src/core/update/activation.js";
import type { PairDescriptor } from "../../src/core/update/types.js";
import { registerEngineCommand } from "../../src/cli/commands/engine.js";
import { engineAvailability } from "../../src/core/engine-availability.js";
import { ensureCommunityRuntime, communityRuntimeReady } from "../../src/core/entitlement/community-runtime.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { writeUpdatePreferences } from "../../src/core/onboarding-preferences.js";
import * as usageClient from "../../src/core/auth/usage-reconcile-client.js";
import * as leaseClient from "../../src/core/auth/lease-client.js";

let dir: string, root: string, env: NodeJS.ProcessEnv, cli: PairDescriptor["cli"], oldEntry: string;
let signer: ReturnType<typeof generateDevSigningKeyPair>;
const body = Buffer.from("process.exitCode = 0;\n");
const actualStage = installer.stageEngineRelease;
const downloads = vi.fn();
let manifest: manifests.EngineReleaseManifestV2;

function cliFixture(version: string): PairDescriptor["cli"] {
  const installRoot = join(root,"releases",version);
  const packageRoot = join(installRoot,"node_modules","@compaction","cli");
  mkdirSync(join(packageRoot,"dist","cli"),{recursive:true});
  // Bootstrap admission verifies its complete static import closure before any runtime import.
  cpSync(fileURLToPath(new URL("../../dist/core", import.meta.url)), join(packageRoot,"dist","core"), { recursive: true });
  const compatibility = currentReleaseCompatibility(version);
  writeFileSync(join(packageRoot,"package.json"),JSON.stringify({name:"@compaction/cli",version,type:"module",compactionRelease:compatibility}));
  writeFileSync(join(packageRoot,"dist","cli","index.js"),"process.exitCode = 0;\n");
  return {root:packageRoot,installRoot,version,compatibility,integrity:`sha512-test-${version}`,files:inventoryRelease(installRoot)};
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(),"managed-engine-pair-")));
  root = join(dir,"managed"); env = {COMPACTION_CONFIG_DIR:dir}; oldEntry = process.argv[1];
  cli = cliFixture("0.6.8-preview.1");
  signer = generateDevSigningKeyPair();
  manifest = {schema_version:2,version:"0.6.8",channel:"stable",platform:"any",arch:"any",artifact_kind:"node-script",
    sha256:createHash("sha256").update(body).digest("hex"),size_bytes:body.length,cli_min_version:"0.6.0",cli_max_version:"0.8.0",
    engine_protocol:1,usage_schema_version:3,meter_version:"optimized-input-v2",eula_version:"1.0"};
  vi.spyOn(manifests,"pinnedRootKeys").mockReturnValue([{key_id:"synthetic-test-root",public_key_spki_b64u:signer.publicKeySpkiB64u,
    authorization:{kind:"current-release",schema_version:2}}]);
  downloads.mockReset();
  vi.spyOn(installer,"stageEngineRelease").mockImplementation(input => actualStage({...input,ops:{
    fetchLatestRelease:async (_url,_token,channel) => {
      expect(channel).toBe("stable");
      return {manifest:manifests.canonicalManifestBytes(manifest).toString(),signature:signManifest(manifest,signer.privateKeyPem),artifact_url:"http://127.0.0.1:9/engine"};
    },
    download:async (_url,target) => { downloads(); writeFileSync(target,body); }
  }}));
});
afterEach(() => {
  process.argv[1] = oldEntry; process.exitCode = 0; vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(dir,{recursive:true,force:true});
});
function entitlement(): void { provisionValidLease(dir); recordEngineEulaAcceptance(env); }
async function managed(): Promise<PairDescriptor> {
  const pair = createPair(cli,{mode:"basic"});
  await bootstrapManagedInstall(root,pair,{launcherPath:join(dir,"bin","compaction")});
  process.argv[1] = join(cli.root,"dist","cli","index.js");
  return pair;
}

describe("managed engine selection", () => {
  it("downloads no private artifact without credentials, a valid lease, or accepted terms", async () => {
    expect(await selectCandidateEngine(cli,undefined,{env})).toMatchObject({engine:{mode:"basic"},reason:"no-account"});
    provisionValidLease(dir);
    expect(await selectCandidateEngine(cli,undefined,{env})).toMatchObject({reason:"eula-not-accepted",requiredEulaVersion:"1.0"});
    recordEngineEulaAcceptance(env); rmSync(join(dir,"lease.json"));
    expect(await selectCandidateEngine(cli,undefined,{env})).toMatchObject({reason:"lease-unavailable"});
    expect(installer.stageEngineRelease).toHaveBeenCalledTimes(1); expect(downloads).not.toHaveBeenCalled();
  });
  it("requires newly signed terms without accepting them or downloading the artifact", async () => {
    entitlement(); manifest.eula_version="2.0";
    expect(await selectCandidateEngine(cli,undefined,{env,refresh:true})).toMatchObject({engine:{mode:"basic"},reason:"eula-not-accepted",requiredEulaVersion:"2.0"});
    expect(engineEulaAccepted(env,"2.0")).toBe(false); expect(downloads).not.toHaveBeenCalled();
    recordEngineEulaAcceptance(env, new Date(), "2.0");
    expect(await selectCandidateEngine(cli,undefined,{env,refresh:true})).toMatchObject({engine:{mode:"basic"},reason:"eula-not-accepted",requiredEulaVersion:"2.0"});
    expect(downloads).not.toHaveBeenCalled();
  });
  it("reuses verified compatible engine locally and preserves it when a refresh fails", async () => {
    entitlement();
    const first=await selectCandidateEngine(cli,undefined,{env}); expect(first.engine.mode).toBe("signed");
    const acquired=downloads.mock.calls.length;
    const onNetwork=vi.fn();
    expect(await selectCandidateEngine(cli,first.engine,{env,onNetwork})).toEqual(first);
    expect(downloads).toHaveBeenCalledTimes(acquired); expect(onNetwork).not.toHaveBeenCalled();
    manifest.engine_protocol=2;
    expect(await selectCandidateEngine(cli,first.engine,{env,refresh:true})).toEqual({engine:first.engine,reason:"release-incompatible"});
    expect(installer.readCurrentPointer(env)).toBeUndefined();
  });
  it("retains the verified previous engine and required version when refreshed terms cannot be presented", async () => {
    entitlement();
    const first = await selectCandidateEngine(cli, undefined, { env });
    const acquired = downloads.mock.calls.length;
    manifest.eula_version = "2.0";
    recordEngineEulaAcceptance(env, new Date(), "2.0");
    expect(await selectCandidateEngine(cli, first.engine, { env, refresh: true })).toEqual({
      engine: first.engine, reason: "eula-not-accepted", requiredEulaVersion: "2.0"
    });
    expect(downloads).toHaveBeenCalledTimes(acquired);
  });
  it("falls back to Basic when the previous artifact is corrupted and refresh cannot repair it", async () => {
    entitlement();
    const first = await selectCandidateEngine(cli, undefined, { env });
    if (first.engine.mode !== "signed") throw new Error("Expected signed fixture engine");
    const lease = readFileSync(join(dir, "lease.json"));
    const credentials = readFileSync(join(dir, "credentials.json"));
    writeFileSync(first.engine.artifactPath, "changed artifact bytes");
    manifest.engine_protocol = 2;
    expect(await selectCandidateEngine(cli, first.engine, { env, refresh: true }))
      .toMatchObject({ engine: { mode: "basic" }, reason: "release-incompatible" });
    expect(readFileSync(join(dir, "lease.json"))).toEqual(lease);
    expect(readFileSync(join(dir, "credentials.json"))).toEqual(credentials);
    expect(installer.readCurrentPointer(env)).toBeUndefined();
  });
  it("stages through the coordinator, preserves a pending CLI, and leaves legacy current untouched", async () => {
    entitlement(); const current=await managed();
    const nextCli=cliFixture("0.6.9"); const next=createPair(nextCli,{mode:"basic"});
    await stagePair(root,next,"explicit");
    const result=await stageManagedEngine(root,{env,refresh:true,intent:"explicit"});
    expect(result.pair.cli).toEqual(nextCli); expect(result.pair.engine.mode).toBe("signed");
    const state=readState(root); expect(state.current).toEqual(current); expect(state.staged).toEqual(result.pair);
    expect(installer.readCurrentPointer(env)).toBeUndefined();
    const persisted = readFileSync(join(root,"state.json"),"utf8");
    const credentials = JSON.parse(readFileSync(join(dir,"credentials.json"),"utf8"));
    expect(persisted).not.toContain(credentials.device_token);
    expect(persisted).not.toContain(credentials.device_private_key_pem);
    expect(persisted).not.toContain("request_body");
  });
  it("rejects stale publication when another candidate stages during acquisition", async () => {
    entitlement(); await managed();
    const competing=createPair(cliFixture("0.6.9"),{mode:"basic"});
    const previous=vi.mocked(installer.stageEngineRelease).getMockImplementation()!;
    vi.mocked(installer.stageEngineRelease).mockImplementationOnce(async input => {
      const result=await previous(input); await stagePair(root,competing,"explicit"); return result;
    });
    await expect(stageManagedEngine(root,{env,refresh:true,intent:"explicit"})).rejects.toThrow(/changed/i);
    expect(readState(root).staged).toEqual(competing); expect(installer.readCurrentPointer(env)).toBeUndefined();
  });
  it("pair identity binds dependencies while ignoring installation location", () => {
    const a=createPair(cli,{mode:"basic"});
    expect(createPair({...cli,root:"/different",installRoot:"/different"},{mode:"basic"}).id).toBe(a.id);
    expect(createPair({...cli,files:{...cli.files,"node_modules/dependency/index.js":"different"}},{mode:"basic"}).id).not.toBe(a.id);
  });
});

describe("managed engine acquisition intent", () => {
  it.each(["persisted-off", "environment-off", "CI"])("default Gateway-style repair leaves engine requests/progress/state untouched with %s", async (setting) => {
    entitlement(); await managed();
    if (setting === "persisted-off") writeUpdatePreferences({ autoUpdates: false }, env);
    if (setting === "environment-off") env.COMPACTION_AUTO_UPDATE = "0";
    if (setting === "CI") env.CI = "1";
    const before = readFileSync(join(root, "state.json"));
    const usage = vi.spyOn(usageClient, "reconcileStoredUsage");
    const progress = vi.fn();
    expect(await ensureCommunityRuntime(env, progress)).toMatchObject({ lease: "valid", engine: "unavailable", reason: "automatic-updates-disabled", networkUsed: false });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled(); expect(installer.stageEngineRelease).not.toHaveBeenCalled(); expect(downloads).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "state.json"))).toEqual(before);
  });

  it("still repairs a missing lease and runs usage reconciliation while automatic engine acquisition is off", async () => {
    entitlement(); await managed(); writeUpdatePreferences({ autoUpdates: false }, env);
    const leaseFile = join(dir, "lease.json"); const signedLease = JSON.parse(readFileSync(leaseFile, "utf8")); rmSync(leaseFile);
    const acquire = vi.spyOn(leaseClient, "acquireLease").mockResolvedValueOnce(signedLease);
    const usage = vi.spyOn(usageClient, "reconcileStoredUsage");
    const progress = vi.fn(), before = readFileSync(join(root, "state.json"));
    expect(await ensureCommunityRuntime(env, progress)).toMatchObject({ lease: "renewed", reason: "automatic-updates-disabled", networkUsed: true });
    expect(acquire).toHaveBeenCalledTimes(1); expect(usage).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls.map(([step]) => step)).toEqual(["lease"]);
    expect(installer.stageEngineRelease).not.toHaveBeenCalled(); expect(readFileSync(join(root, "state.json"))).toEqual(before);
  });

  it("default enabled repair stages an automatic pair", async () => {
    entitlement(); const current = await managed(); writeUpdatePreferences({ autoUpdates: true }, env);
    expect(await ensureCommunityRuntime(env)).toMatchObject({ reason: "engine-staged-next-session", networkUsed: true });
    expect(readState(root)).toMatchObject({ current, stagedIntent: "automatic" });
    expect(readState(root).staged?.engine.mode).toBe("signed");
  });

  it("refuses automatic publication when opt-out changes during a real fixture artifact acquisition", async () => {
    entitlement(); await managed(); const before = readFileSync(join(root, "state.json"));
    downloads.mockImplementationOnce(() => { writeUpdatePreferences({ autoUpdates: false }, env); });
    await expect(stageManagedEngine(root, { env, intent: "automatic" })).rejects.toThrow("preferences changed");
    expect(downloads).toHaveBeenCalledTimes(1); expect(readFileSync(join(root, "state.json"))).toEqual(before);
  });

  it.each(["persisted-off", "environment-off", "CI"])("explicit initial setup against current Basic stays explicit with %s", async (setting) => {
    entitlement(); const current = await managed();
    if (setting === "persisted-off") writeUpdatePreferences({ autoUpdates: false }, env);
    if (setting === "environment-off") env.COMPACTION_AUTO_UPDATE = "0";
    if (setting === "CI") env.CI = "1";
    expect(await ensureCommunityRuntime(env, undefined, { engineIntent: "explicit" })).toMatchObject({ reason: "engine-staged-next-session", networkUsed: true });
    expect(readState(root)).toMatchObject({ current, stagedIntent: "explicit" });
    expect(readState(root).staged?.engine.mode).toBe("signed");
  });

  it.each([
    { inherited: "automatic", operation: "explicit", result: "automatic" },
    { inherited: "explicit", operation: "automatic", result: "automatic" },
    { inherited: "explicit", operation: "explicit", result: "explicit" },
    { inherited: "automatic", operation: "automatic", result: "automatic" },
  ] as const)("composes inherited $inherited CLI and $operation engine as $result", async ({ inherited, operation, result }) => {
    entitlement(); const current = await managed();
    const nextCli = cliFixture("0.6.9"); await stagePair(root, createPair(nextCli, { mode: "basic" }), inherited);
    await stageManagedEngine(root, { env, intent: operation });
    expect(readState(root)).toMatchObject({ current, stagedIntent: result });
    expect(readState(root).staged?.cli).toEqual(nextCli);
    expect(readState(root).staged?.engine.mode).toBe("signed");
  });

  it.each([undefined, "invalid"])("never acquires or publishes from unknown inherited intent: %s", async (stagedIntent) => {
    entitlement(); await managed(); await stagePair(root, createPair(cliFixture("0.6.9"), { mode: "basic" }), "automatic");
    atomicWrite(join(root, "state.json"), JSON.stringify({ ...readState(root), stagedIntent }));
    const before = readFileSync(join(root, "state.json")), onNetwork = vi.fn();
    expect(await stageManagedEngine(root, { env, intent: "explicit", onNetwork })).toMatchObject({ reason: "staged-intent-unknown" });
    expect(onNetwork).not.toHaveBeenCalled(); expect(installer.stageEngineRelease).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "state.json"))).toEqual(before);
  });

  it("allows compatible local reuse under opt-out without demoting an explicit staged pair", async () => {
    entitlement(); await managed(); const selected = await selectCandidateEngine(cli, undefined, { env });
    await stagePair(root, createPair(cli, selected.engine), "explicit");
    writeUpdatePreferences({ autoUpdates: false }, env); vi.mocked(installer.stageEngineRelease).mockClear(); downloads.mockClear();
    const before = readFileSync(join(root, "state.json")), onNetwork = vi.fn();
    const result = await stageManagedEngine(root, { env, intent: "automatic", onNetwork });
    expect(result.pair.engine.mode).toBe("signed"); expect(result.reason).toBeUndefined();
    expect(onNetwork).not.toHaveBeenCalled(); expect(installer.stageEngineRelease).not.toHaveBeenCalled();
    expect(downloads).not.toHaveBeenCalled(); expect(readFileSync(join(root, "state.json"))).toEqual(before);
  });
});

describe("managed command and repair entrypoints", () => {
  it("explicit engine update cannot authorize an automatically staged CLI", async () => {
    entitlement(); const current = await managed();
    const nextCli = cliFixture("0.6.9");
    const selected = await selectCandidateEngine(nextCli, undefined, { env });
    expect(selected.engine.mode).toBe("signed");
    const staged = createPair(nextCli, selected.engine);
    await stagePair(root, staged, "automatic");
    downloads.mockClear();
    const before = readState(root);
    const bytes = readFileSync(join(root, "state.json"));
    vi.stubEnv("COMPACTION_CONFIG_DIR", dir); vi.stubEnv("COMPACTION_HOME", ""); vi.stubEnv("COMPACTION_AUTO_UPDATE", "0");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const command = new Command(); registerEngineCommand(command);
    await command.parseAsync(["engine", "update"], { from: "user" });
    expect(readState(root)).toMatchObject({ current, staged, stagedIntent: "automatic", revision: before.revision });
    expect(readFileSync(join(root, "state.json"))).toEqual(bytes);
    expect(downloads).not.toHaveBeenCalled();
    expect(await tryActivate(root, { env: { ...env, COMPACTION_AUTO_UPDATE: "0" }, gatewayBarrier: async () => ({ ok: true }) }))
      .toMatchObject({ status: "deferred", reason: "automatic-updates-disabled" });
  });

  it("engine update preserves Basic and explains terms this CLI cannot present", async () => {
    entitlement(); const current = await managed(); manifest.eula_version = "2.0";
    vi.stubEnv("COMPACTION_CONFIG_DIR", dir); vi.stubEnv("COMPACTION_HOME", "");
    const output: string[] = []; vi.spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
    const command = new Command(); registerEngineCommand(command);
    await command.parseAsync(["engine", "update"], { from: "user" });
    expect(output.join("\n")).toContain("signed engine release requires EULA 2.0");
    expect(output.join("\n")).toContain("can present only EULA 1.0");
    expect(output.join("\n")).toContain("compaction engine license");
    expect(readState(root).current).toEqual(current);
    expect(readState(root).staged).toBeUndefined();
    expect(downloads).not.toHaveBeenCalled();
    expect(engineEulaAccepted(env, "2.0")).toBe(false);
  });
  it("a stale receipt never adopts a source invocation", async () => {
    await managed(); process.argv[1]=oldEntry;
    expect(loadExecutingManagedInstallation(env)).toBeUndefined();
  });
  it("engine update stages a pair and status reports active Basic despite a legacy pointer", async () => {
    entitlement(); const current=await managed();
    vi.stubEnv("COMPACTION_CONFIG_DIR",dir);
    vi.stubEnv("COMPACTION_HOME","");
    const output:string[]=[]; vi.spyOn(console,"log").mockImplementation((...args) => { output.push(args.join(" ")); });
    const command=new Command(); registerEngineCommand(command);
    await command.parseAsync(["engine","update"],{from:"user"});
    expect(readState(root).current).toEqual(current); expect(readState(root).staged?.engine.mode).toBe("signed");
    expect(installer.readCurrentPointer(env)).toBeUndefined();
    expect(output.join("\n")).toMatch(/staged for a safe next session/);
    const staged=readState(root).staged!;
    if(staged.engine.mode!=="signed") throw new Error("Expected staged engine");
    writeFileSync(installer.enginePointerPath(env),staged.engine.artifactPath);
    output.length=0;
    await command.parseAsync(["engine","status"],{from:"user"});
    expect(output.join("\n")).toContain("Active managed engine: Basic");
    expect(output.join("\n")).not.toContain("Installed engine: verified");
    expect(await engineAvailability(env)).toBe("installable");
  });
  it("Community repair stages without claiming this Basic session has acquired Full", async () => {
    entitlement(); const current=await managed();
    const outcome=await ensureCommunityRuntime(env);
    expect(outcome).toMatchObject({account:"present",lease:"valid",engine:"unavailable",reason:"engine-staged-next-session",networkUsed:true});
    expect(communityRuntimeReady(outcome)).toBe(false);
    expect(readState(root).current).toEqual(current); expect(readState(root).staged?.engine.mode).toBe("signed");
    expect(installer.readCurrentPointer(env)).toBeUndefined();
    expect(existsSync(join(dir,"engine-eula.json"))).toBe(true);
  });
});
