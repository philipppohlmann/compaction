/**
 * `compaction engine status|install|update` — signed private-engine delivery.
 *
 * HARD RAILS:
 *  - `engine status` is a LOCAL READ: resolution source + installed version + verified state.
 *    No network call, ever.
 *  - `engine install` / `engine update` make network calls ONLY inside these explicit commands,
 *    only to the service stored at `compaction login` (device-token authenticated) and the
 *    artifact URL that service returned. There is NO default release URL in this build.
 *  - CLAIMS HONESTY: every distribution statement this command prints is DERIVED from
 *    `pinnedRootKeys()` and from the install path's own error code — none is asserted. That matters
 *    because the answer has now changed twice: the production root was a placeholder, then it was
 *    pinned with no release behind it, and a signed stable release is now published. A refusal
 *    today means this DEVICE has not installed one (or could not verify one), not that none
 *    exists; the `root-key-not-pinned` and `no-published-release` branches below say which, and
 *    both remain reachable for a rollback or a channel with nothing on it. A dev/test release
 *    verifies ONLY via the explicit `--dev-root-key` flow and is loudly labeled DEV-SIGNED — never
 *    presented as a release.
 *  - The supervisor re-verifies signature + digest before every run; installing does not bypass
 *    verify-before-run, and an unverified install degrades fail-open (original forwarded).
 */
import { readFileSync } from "node:fs";
import * as readline from "node:readline/promises";
import chalk from "chalk";
import type { Command } from "commander";
import { readStoredCredentials } from "../../core/auth/credentials.js";
import {
  EngineInstallError,
  enginePointerPath,
  installDevRootKey,
  installEngineRelease,
  readCurrentPointer
} from "../../core/engine-install/installer.js";
import { ENGINE_CHANNELS, pinnedRootKeys, type EngineChannel } from "../../core/engine-install/manifest.js";
import { devRootKeyPath, readDevRootKey } from "../../core/engine-install/verify.js";
import {
  ENGINE_EULA_SUMMARY,
  ENGINE_EULA_VERSION,
  engineEulaAccepted,
  engineEulaUrl,
  readEngineEulaAcceptance,
  recordEngineEulaAcceptance
} from "../../core/legal/engine-eula.js";
import { resolveEngine } from "../../core/gateway/engine-ipc/supervisor.js";

const DEV_SIGNED_WARNING =
  "DEV-SIGNED engine: this install was verified against a LOCAL dev root key, not a Compaction " +
  "release key. It is not a release. Remove it with `rm -r` on the engine directory shown by " +
  "`compaction engine status` if you did not set this up yourself.";

function describeTrust(trust: "pinned-root" | "dev-root"): string {
  return trust === "pinned-root" ? "release root (pinned)" : chalk.yellow("DEV root (DEV-SIGNED, not a release)");
}

/** `compaction engine status` — local read only. */
function runStatus(env: NodeJS.ProcessEnv = process.env): void {
  console.log(chalk.cyan("compaction engine status"));
  const resolved = resolveEngine({ env });

  if (resolved.source === "installed" && resolved.installed) {
    const { manifest, trust } = resolved.installed;
    console.log(chalk.green("  Installed engine: verified"));
    console.log(`  Version:  ${chalk.bold(manifest.version)} (${manifest.channel} channel, ${manifest.artifact_kind})`);
    console.log(`  Trust:    ${describeTrust(trust)}`);
    console.log(chalk.dim(`  Artifact: ${resolved.path}`));
    if (trust === "dev-root") console.log(chalk.yellow(`  ${DEV_SIGNED_WARNING}`));
  } else if (resolved.source === "installed" && resolved.unverifiedReason !== undefined) {
    console.log(chalk.red(`  Installed engine: NOT verified (${resolved.unverifiedReason})`));
    console.log(chalk.dim(`  Pointer:  ${enginePointerPath(env)} -> ${readCurrentPointer(env) ?? "(unreadable)"}`));
    console.log(
      chalk.dim(
        "  An unverified install never runs: the gateway degrades fail-open (requests are forwarded " +
          "unchanged). Reinstall with `compaction engine install`."
      )
    );
  } else if (resolved.source === "env" || resolved.source === "option") {
    console.log(`  Engine path override in effect (${resolved.source}): ${chalk.bold(resolved.path ?? "(unset)")}`);
    console.log(chalk.dim("  Overrides are for dev/test; they bypass the signed-install resolution."));
  } else if (resolved.source === "dev-build") {
    console.log(`  No signed engine installed; using the local dev build: ${chalk.bold(resolved.path ?? "")}`);
    console.log(chalk.dim("  (Dev checkouts only — the published package does not contain a dev build.)"));
  } else {
    console.log("  No engine installed. The gateway runs fully degraded-open without one (requests forwarded unchanged).");
  }

  // Honest trust-root state, READ FROM THE RUNTIME rather than asserted. This build pins a
  // production release root, so the "nothing is distributed" line below is correctly silent here —
  // it is kept, not deleted, because a build that pins no root must still say so.
  if (pinnedRootKeys().length === 0) {
    console.log(
      chalk.dim(
        "  This build pins no release root key, so release verification fails closed by design — " +
          "no release can install here, whatever the service publishes."
      )
    );
  }
  if (readDevRootKey(env)) {
    console.log(chalk.yellow(`  A local DEV trust root is installed (${devRootKeyPath(env)}). DEV-SIGNED installs verify against it.`));
  }
  console.log(chalk.dim("  This command read local files only — no network call was made."));
}

/**
 * The licence gate that stands in front of every acquisition.
 *
 * WHERE THE GATE SITS AND WHY. The Apache-2.0 client asks for nothing; the SEPARATELY DISTRIBUTED
 * Hybrid Engine is the licensed thing. So acceptance is required exactly once, at the moment this
 * device is about to receive that artifact — not at install of the CLI, not at first run, and never
 * on the Open path, which never reaches this code at all.
 *
 * FAIL CLOSED WITHOUT A TERMINAL. `engine install` can be run from a script or a CI step, where
 * there is no one to ask. Downloading a separately licensed artifact on a device that has not
 * accepted its terms because nobody was watching is precisely the outcome the gate exists to
 * prevent, so a non-interactive run is refused and told the one command that resolves it.
 */
async function ensureEngineEulaAccepted(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (engineEulaAccepted(env)) return true;
  printEngineEulaOffer(env);
  if (!process.stdin.isTTY) {
    console.log(
      chalk.red("  The Compaction Engine License Agreement has not been accepted on this device.")
    );
    console.log(
      chalk.dim("  This run has no terminal to ask in. Accept it with `compaction engine license --accept`.")
    );
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question("  Accept the Compaction Engine License Agreement? Type yes to accept: ");
  } finally {
    rl.close();
  }
  // ONLY `yes`. A bare Enter, a `y`, or a stray keystroke is not an agreement to licence terms, and
  // the default on anything else is to decline and change nothing on disk.
  if (answer.trim().toLowerCase() !== "yes") {
    console.log(chalk.yellow("  Not accepted. Nothing was downloaded and nothing was recorded."));
    return false;
  }
  const record = recordEngineEulaAcceptance(env);
  console.log(chalk.green(`  Accepted version ${record.version}. Recorded on this device.`));
  return true;
}

/** The agreement, its address, and the short statement of what it covers. Printing only. */
function printEngineEulaOffer(env: NodeJS.ProcessEnv = process.env): void {
  console.log(chalk.bold(`  Compaction Engine License Agreement (version ${ENGINE_EULA_VERSION})`));
  console.log(`  ${engineEulaUrl(env)}`);
  for (const line of ENGINE_EULA_SUMMARY) console.log(chalk.dim(`    - ${line}`));
}

/** `compaction engine license [--accept]` — read the agreement, see acceptance state, accept it. */
async function runLicense(opts: { accept?: boolean }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  console.log(chalk.cyan("compaction engine license"));
  const existing = readEngineEulaAcceptance(env);
  if (existing?.version === ENGINE_EULA_VERSION) {
    console.log(chalk.green(`  Accepted: version ${existing.version} on ${existing.accepted_at}.`));
    console.log(`  ${engineEulaUrl(env)}`);
    // ALREADY ACCEPTED IS NOT A REASON TO ASK AGAIN. `--accept` here is a no-op that reports the
    // truth rather than rewriting the timestamp, so re-running it in a script stays idempotent.
    return;
  }
  if (existing !== undefined) {
    // A DIFFERENT version was accepted. Re-acceptance is the whole point of recording the version.
    console.log(
      chalk.yellow(`  Version ${existing.version} was accepted on ${existing.accepted_at}; version ${ENGINE_EULA_VERSION} has not been.`)
    );
  }
  if (opts.accept !== true) {
    printEngineEulaOffer(env);
    console.log(chalk.dim("  Not accepted on this device. Accept it with `compaction engine license --accept`."));
    process.exitCode = 1;
    return;
  }
  const record = recordEngineEulaAcceptance(env);
  console.log(chalk.green(`  Accepted version ${record.version}. Recorded on this device.`));
  console.log(`  ${engineEulaUrl(env)}`);
}

/** Shared install/update runner (update = install latest; reports up-to-date honestly). */
async function runInstall(
  opts: { channel?: string; devRootKey?: string },
  env: NodeJS.ProcessEnv = process.env,
  verb: "install" | "update" = "install"
): Promise<void> {
  console.log(chalk.cyan(`compaction engine ${verb}`));

  const channel = (opts.channel ?? "stable").trim().toLowerCase();
  if (!ENGINE_CHANNELS.includes(channel as EngineChannel)) {
    console.error(`unknown channel ${JSON.stringify(opts.channel)}. Valid channels: ${ENGINE_CHANNELS.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  if (opts.devRootKey !== undefined) {
    let spki: string;
    try {
      spki = readFileSync(opts.devRootKey, "utf8");
    } catch {
      console.log(chalk.red(`  Could not read the dev root key file at ${opts.devRootKey}.`));
      process.exitCode = 1;
      return;
    }
    try {
      const path = installDevRootKey(spki, env);
      console.log(chalk.yellow(`  ${DEV_SIGNED_WARNING}`));
      console.log(chalk.dim(`  Dev trust root written to ${path}.`));
    } catch (error) {
      const message = error instanceof EngineInstallError ? error.message : String(error);
      console.log(chalk.red(`  Dev root key rejected: ${message}`));
      process.exitCode = 1;
      return;
    }
  }

  try {
    // THE ACCOUNT PRECONDITION IS READ BEFORE THE LICENCE IS OFFERED. Engine releases are a
    // Community-account feature, so a logged-out device cannot receive the artifact whatever it
    // agrees to; offering the agreement first would collect consent for something that cannot
    // happen, and would bury the one thing the user actually has to fix. Both checks are local
    // reads — neither reaches the network. `installEngineRelease` re-checks the same store, so this
    // is a precondition on the order the two refusals are shown, not a replacement for its guard.
    if (readStoredCredentials(env) === undefined) {
      throw new EngineInstallError("not logged in — run `compaction login` first", "not-logged-in");
    }

    if (!(await ensureEngineEulaAccepted(env))) {
      process.exitCode = 1;
      return;
    }

    const result = await installEngineRelease({ channel: channel as EngineChannel, env });
    if (!result.updated) {
      console.log(chalk.green(`  Already up to date: engine ${chalk.bold(result.version)} (${result.channel} channel).`));
    } else {
      console.log(chalk.green(`  Installed engine ${chalk.bold(result.version)} (${result.channel} channel, ${result.artifactKind}).`));
    }
    console.log(`  Trust:    ${describeTrust(result.trust)}`);
    console.log(chalk.dim(`  Artifact: ${result.artifactPath}`));
    if (result.trust === "dev-root") console.log(chalk.yellow(`  ${DEV_SIGNED_WARNING}`));
    console.log(chalk.dim("  The gateway verifies the signature + digest again before every engine run."));
  } catch (error) {
    if (error instanceof EngineInstallError) {
      console.log(chalk.red(`  Engine ${verb} did not complete: ${error.message} (${error.code})`));
      if (error.code === "not-logged-in") {
        console.log(
          chalk.dim(
            "  Engine releases are a Community-account feature. Run `compaction` and choose Community — " +
              "or `compaction login` if you previously logged out."
          )
        );
      } else if (error.code === "root-key-not-pinned") {
        console.log(
          chalk.dim(
            "  This build pins no release root key, so release verification fails closed by design. " +
              "This is a property of the build you installed, not an outage."
          )
        );
      } else if (error.code === "no-published-release") {
        console.log(chalk.dim(`  The service has no published release on the ${channel} channel.`));
      }
    } else {
      console.log(chalk.red(`  Engine ${verb} did not complete: ${error instanceof Error ? error.message : String(error)}`));
    }
    process.exitCode = 1;
  }
}

export function registerEngineCommand(program: Command): void {
  const engine = program
    .command("engine")
    .description(
      "Signed private-engine delivery: `status` shows the installed engine + verified state (local " +
        "read, no network); `install`/`update` fetch and verify a signed release from your " +
        "Compaction service (requires a Community account — run `compaction` to set one up). " +
        // DERIVED, not asserted. This sentence used to be a hardcoded "no engine release is
        // distributed yet", which was true only while no release root was pinned — the exact class
        // of claim that goes stale silently the moment the runtime behind it changes. It now reads
        // the same predicate the install path enforces, so help text and behavior cannot disagree,
        // and the unpinned branch describes the BUILD rather than the world: a release exists now,
        // so "nothing is distributed" would be false even in a build that cannot verify one.
        (pinnedRootKeys().length === 0
          ? "This build pins no release root key, so release verification fails closed and nothing installs."
          : "Releases are verified against a pinned release root key; an unverified release never installs and never runs.")
    );
  engine
    .command("status")
    .description("Show the resolved engine, its version, and its verified state. Local read only — no network.")
    .action(() => {
      runStatus(process.env);
    });
  engine
    .command("license")
    .description(
      "Show the Compaction Engine License Agreement and this device's acceptance state; `--accept` records acceptance."
    )
    .option("--accept", "Record acceptance of the current agreement version on this device")
    .action(async (opts: { accept?: boolean }) => {
      await runLicense(opts, process.env);
    });
  engine
    .command("install")
    .description(
      "Download, verify (Ed25519 signature + sha256), and install the latest published engine release " +
        "for a channel. Device-token authenticated; refuses without a Community account on this device."
    )
    .option("--channel <channel>", `release channel (${ENGINE_CHANNELS.join(" | ")})`, "stable")
    .option(
      "--dev-root-key <path>",
      "EXPLICIT dev/test trust root (base64url SPKI Ed25519 public key file). Installs it as a local " +
        "DEV root; anything it verifies is loudly labeled DEV-SIGNED and is not a release."
    )
    .action(async (opts: { channel?: string; devRootKey?: string }) => {
      await runInstall(opts, process.env, "install");
    });
  engine
    .command("update")
    .description("Fetch the latest published release for a channel and install it if newer (same verification as install).")
    .option("--channel <channel>", `release channel (${ENGINE_CHANNELS.join(" | ")})`, "stable")
    .action(async (opts: { channel?: string }) => {
      await runInstall(opts, process.env, "update");
    });
}
