/**
 * `compaction login` / `compaction logout` / `compaction devices` — Community account activation
 * via the browser device-code flow.
 *
 * HARD RAILS:
 *  - Network I/O happens ONLY inside these explicit account commands, only to the user-chosen
 *    service URL. Nothing on the Open path (mode/output-shaping) imports this module.
 *  - The device token is written ONLY to the 0600 credentials file; `maskToken` is the only form
 *    ever printed. The locally-generated private key is never printed in any form.
 *  - Logging in does NOT enable full apply by itself: entitlement checks and the narrow per-tool
 *    apply authorization are separate steps.
 *  - Dev-phase identity: accounts created through this flow are asserted-email accounts against a
 *    locally-run control plane.
 */
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import chalk from "chalk";
import type { Command } from "commander";
import { resolveTarget } from "../../core/api-client/persisted-config.js";
import { terminalSafeText } from "../../core/terminal-hyperlink.js";
import {
  credentialsPath,
  deleteStoredCredentials,
  maskToken,
  readStoredCredentials,
  type StoredCredentials
} from "../../core/auth/credentials.js";
import { listAccountDevices, revokeAccountDevice } from "../../core/auth/device-flow.js";
import {
  communityRuntimeReady,
  describeRepairActions,
  engineBlockedReason,
  ensureCommunityRuntime,
  leaseBlockedReason
} from "../../core/entitlement/community-runtime.js";
import {
  performDeviceLogin,
  type DeviceLoginFailureReason,
  type DeviceLoginProgress
} from "../../core/auth/device-login.js";

/** Best-effort browser open (`open`/`xdg-open`). Failure is fine — the URL is printed/rendered anyway,
 *  which is the only path on a headless or SSH shell. Shared with the onboarding Community step. */
export function openBrowser(url: string, env: NodeJS.ProcessEnv): void {
  if (env.COMPACTION_NO_BROWSER === "1") return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Printed URL is the fallback.
  }
}

function printLoggedIn(credentials: StoredCredentials): void {
  console.log(chalk.green(`  Logged in — free Community account (1 device).`));
  if (credentials.email) console.log(`  Account: ${chalk.bold(credentials.email)}`);
  console.log(`  Device:  ${chalk.bold(credentials.device_name ?? credentials.device_id)} (${credentials.device_id})`);
  console.log(chalk.dim(`  Service: ${credentials.api_url}`));
  console.log(chalk.dim(`  Device token: ${maskToken(credentials.device_token)} (stored at ${credentialsPath()})`));
}

/**
 * The honest, DISTINCT message for each failure reason. Seven reasons, seven messages: an offline
 * install and a denied approval are different user stories with different remedies, and one generic
 * "login failed" would be wrong for most of them.
 *
 * `unreachable`, `endpoint_not_found` and `service_error` are the trio that matters most here. All
 * three read as "it did not work" to a skim, and their remedies point at three different places —
 * the network, the configured URL, and the service operator. Offering the wrong one is how a user
 * ends up debugging a network that is working, or waiting on a service-side repair for a URL only
 * they can fix.
 */
function loginFailureLines(reason: DeviceLoginFailureReason, apiUrl: string, serviceStatus?: number): string[] {
  switch (reason) {
    case "denied":
      return [
        "  The request was declined in the browser — no account was connected.",
        "  Nothing was written. Run `compaction login` again to retry."
      ];
    case "expired":
      return [
        "  The verification code expired before it was approved.",
        "  Nothing was written. Run `compaction login` again for a fresh code."
      ];
    case "timeout":
      return [
        "  Timed out waiting for the browser approval.",
        "  Nothing was written. Run `compaction login` again when you can finish the browser step."
      ];
    case "cancelled":
      return ["  Cancelled — nothing was written."];
    case "unreachable":
      return [
        `  Could not reach the Compaction service at ${apiUrl}.`,
        "  Nothing was written. Check your connection, or pass --api-url (or set COMPACTION_API_URL).",
        "  Run `compaction login` again when the service is reachable."
      ];
    case "endpoint_not_found":
      // A server answered, but not as the device-authorization endpoint. The URL guidance is KEPT
      // here, and only here among the answered failures: this is what a wrong host or base path
      // looks like, and it is the one thing the user can change. The line stops at what was
      // observed — it does not tell the user their URL is wrong, because a real service can 404 its
      // own route mid-deploy, and asserting fault we cannot see would be inventing one.
      return [
        `  A server answered at ${apiUrl}, but not as the Compaction device sign-in endpoint${
          serviceStatus === undefined ? "" : ` (HTTP ${serviceStatus})`
        }.`,
        "  Nothing was written. Check that URL — pass --api-url (or set COMPACTION_API_URL) to point at your Compaction service.",
        "  Run `compaction login` again once the URL reaches a service that can start device sign-in."
      ];
    case "service_error":
      // No connection advice and no --api-url here, deliberately: the endpoint was there and
      // answered, so re-pointing the URL is not the fix. The status is named and not interpreted —
      // what it MEANS is the service operator's to say, and guessing a cause here would be
      // inventing one.
      return [
        `  The Compaction service at ${apiUrl} answered, but could not sign this device in${
          serviceStatus === undefined ? "" : ` (HTTP ${serviceStatus})`
        }.`,
        "  Nothing was written. This is a problem on the service side, not with your connection.",
        "  Run `compaction login` again once the service can start device sign-in."
      ];
  }
}

/** Print the progress a login makes. The verification URL and code are the two things the user must
 *  see — a browser open is best-effort and silently no-ops on a headless/SSH shell. */
function printLoginProgress(progress: DeviceLoginProgress): void {
  if (progress.kind !== "awaiting-browser") return;
  console.log("  To connect this device to a free Community account, open:");
  console.log(`    ${chalk.bold(progress.verificationUri)}`);
  console.log(`  and confirm the code ${chalk.bold(progress.userCode)} in the browser.`);
  console.log(chalk.dim("  Waiting for browser approval… (Ctrl-C to cancel)"));
}

/**
 * `compaction login` — the RECOVERY path, not the normal one. Onboarding's Community step runs this
 * same flow inline (`performDeviceLogin`), so a user who chose Community is already logged in and
 * never needs this command. It exists for someone who explicitly logged out, or whose approval did
 * not complete the first time. This function is rendering only: the flow itself is console-free.
 */
async function runLogin(
  opts: { apiUrl?: string; deviceName?: string; browser?: boolean },
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  console.log(chalk.cyan("compaction login"));
  const outcome = await performDeviceLogin(
    {
      ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
      ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
      ...(opts.browser === false ? {} : { openBrowser: (url: string) => openBrowser(url, env) })
    },
    printLoginProgress,
    env
  );

  if (!outcome.ok) {
    console.log(chalk.red("  Login did not complete."));
    for (const line of loginFailureLines(outcome.reason, outcome.apiUrl, outcome.serviceStatus)) console.log(line);
    process.exitCode = 1;
    return;
  }

  const credentials = readStoredCredentials(env);
  if (outcome.alreadyLoggedIn) {
    console.log(chalk.yellow("  Already logged in."));
    if (credentials) printLoggedIn(credentials);
    // THE RECOVERY PATH. This branch used to return here, which made an already-authenticated device
    // with a lapsed entitlement — the month rolled over, or it activated before a signed engine
    // existed — a state nothing in the normal journey could leave. The user is not asked to know
    // what is missing, or to run a repair command per missing piece: re-running the command they
    // already know re-establishes whatever is not in place, and does nothing when everything is.
    await printCommunitySetup(env);
    console.log(chalk.dim("  Run `compaction logout` first to connect a different account or device."));
    return;
  }

  console.log(chalk.green("  Device connected."));
  if (credentials) {
    printLoggedIn(credentials);
    console.log(chalk.dim(`  Credentials written to ${credentialsPath(env)} (mode 0600).`));
  }
  await printCommunitySetup(env);
  console.log(
    chalk.dim(
      "  Note: being connected does not enable full apply by itself — the per-tool apply " +
        "authorization is a separate step."
    )
  );
}

/**
 * Put the device's Community setup in place if it is not, and report it in product terms.
 *
 * Everything the user is not required to know about — the entitlement lease, the signed engine, the
 * trust roots that verify both — is done here rather than named. On a device that already holds both
 * this is two local reads and no output beyond the confirmation line.
 *
 * Honest in every direction: it reports what the attempt actually achieved, never what it wanted to.
 * A partial result is stated as one, with the coded reason, and never as success — and, just as
 * importantly, a PARTIAL SUCCESS is not reported as nothing. What changed is named before what did
 * not, so a user whose access was renewed but whose engine download failed reads both halves.
 */
async function printCommunitySetup(env: NodeJS.ProcessEnv): Promise<void> {
  const runtime = await ensureCommunityRuntime(env);
  if (runtime.account === "absent") return; // nothing to set up, and nothing was attempted

  // WHAT THIS CALL ACTUALLY DID, one line each, and empty when it did nothing. Printed FIRST and on
  // every path: a renewed access or an installed engine is the news the user came for, whether or not
  // the other half also landed.
  const changed = describeRepairActions(runtime);
  for (const line of changed) console.log(chalk.green(`  ${line}`));

  if (communityRuntimeReady(runtime)) {
    // The lines above already say what completed just now, so this is the state, not the event. It
    // used to carry a "(completed just now)" suffix that named the moment without naming the thing.
    console.log(chalk.green("  Community access is set up on this device."));
    return;
  }

  if (runtime.lease === "unavailable") {
    // Same phrasing source as `mode full`'s refusal: two surfaces describing one failure must not
    // describe it differently, and neither may print the raw wire code at a user.
    console.log(chalk.yellow(`  Community access is not active on this device yet — ${leaseBlockedReason(runtime)}.`));
  }
  if (runtime.engine === "unavailable") {
    // DERIVED for the same reason: "not distributed yet" stops being true the day one is published.
    console.log(chalk.yellow(`  Full optimization cannot run on this device: ${engineBlockedReason(runtime)}.`));
  }
  console.log(
    chalk.dim(
      // "NOTHING WAS CHANGED" IS A CLAIM, and it was printed unconditionally — including on the
      // attempt that had just renewed this device's access and only failed to fetch the engine. It is
      // now reserved for the case it describes.
      changed.length === 0
        ? "  Nothing was changed by the attempt. Running `compaction login` again retries it."
        : "  Running `compaction login` again retries what is still missing."
    )
  );
}

async function runLogout(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  console.log(chalk.cyan("compaction logout"));
  const credentials = readStoredCredentials(env);
  if (!credentials) {
    console.log(chalk.dim("  Not logged in — nothing to do."));
    return;
  }
  // Delete the LOCAL credentials FIRST: they are the source of truth for "logged in", so a slow or
  // hung remote revoke (a stalled connection can block for the transport's long default timeout) must
  // never leave the user logged in locally. The in-memory token still drives a best-effort remote
  // revoke, itself bounded by a short abort timeout so logout can never hang on an unresponsive service.
  deleteStoredCredentials(env);
  const revokeTimeoutMs = Number(env.COMPACTION_REVOKE_TIMEOUT_MS) || 10_000;
  try {
    await revokeAccountDevice(credentials.api_url, credentials.device_token, credentials.device_id, revokeTimeoutMs);
    console.log(chalk.dim("  Device revoked on the service."));
  } catch {
    console.log(chalk.dim("  Service unreachable — device not revoked remotely (local credentials removed anyway)."));
  }
  console.log(chalk.green("  Logged out. Local credentials deleted."));
}

async function runDevicesList(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  console.log(chalk.cyan("compaction devices"));
  const credentials = readStoredCredentials(env);
  if (!credentials) {
    console.log(chalk.yellow("  Not logged in. Run `compaction login` first."));
    process.exitCode = 1;
    return;
  }
  let devices;
  try {
    devices = await listAccountDevices(credentials.api_url, credentials.device_token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  Could not list devices: ${message}`));
    process.exitCode = 1;
    return;
  }
  if (devices.length === 0) {
    console.log(chalk.dim("  No devices registered."));
    return;
  }
  for (const device of devices) {
    const marker = device.id === credentials.device_id ? chalk.green(" (this device)") : "";
    // Every field below is whatever the origin answered with, so none of it reaches the terminal raw.
    const statusText = terminalSafeText(device.status);
    const status = device.status === "active" ? chalk.green(statusText) : chalk.dim(statusText);
    const label = terminalSafeText(device.name) || terminalSafeText(device.id);
    console.log(`  ${chalk.bold(label)}${marker}`);
    console.log(
      chalk.dim(
        `    id ${terminalSafeText(device.id)} · ${status} · registered ${terminalSafeText(device.createdAt)}`
      )
    );
  }
  console.log(chalk.dim("  Community includes 1 device. Revoke with `compaction devices revoke <device-id>`."));
}

async function runDevicesRevoke(deviceId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  console.log(chalk.cyan("compaction devices revoke"));
  const credentials = readStoredCredentials(env);
  if (!credentials) {
    console.log(chalk.yellow("  Not logged in. Run `compaction login` first."));
    process.exitCode = 1;
    return;
  }
  try {
    const revoked = await revokeAccountDevice(credentials.api_url, credentials.device_token, deviceId);
    if (!revoked) {
      console.log(chalk.yellow("  No active device with that id in your account."));
      process.exitCode = 1;
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  Could not revoke: ${message}`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green("  Device revoked — its token stops working immediately."));
  if (deviceId === credentials.device_id) {
    deleteStoredCredentials(env);
    console.log(chalk.dim("  That was this device: local credentials deleted (logged out)."));
  }
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description(
      "Connect this device to a free Community account via the browser device flow. Generates a local " +
        "device key pair, opens the verification page, and stores the issued device token at " +
        "~/.compaction/credentials.json (0600). Community includes 1 registered device. Login alone does " +
        "not enable full apply — entitlements and per-tool apply authorization are separate."
    )
    .option("--api-url <url>", "Compaction service base URL (default: configured/env/local-dev URL)")
    .option("--device-name <name>", "display name for this device (default: hostname)")
    .option("--no-browser", "do not try to open the verification page in a browser")
    .action(async (opts: { apiUrl?: string; deviceName?: string; browser?: boolean }) => {
      await runLogin(opts, process.env);
    });
}

export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description(
      "Disconnect this device: best-effort revoke of the device on the service, then delete the local " +
        "credentials file."
    )
    .action(async () => {
      await runLogout(process.env);
    });
}

export function registerDevicesCommand(program: Command): void {
  const devices = program
    .command("devices")
    .description(
      "List or revoke the registered devices of your Community account (1 device included). " +
        "`compaction devices` lists; `compaction devices revoke <device-id>` revokes."
    );
  devices
    .command("list", { isDefault: true })
    .description("List the registered devices of your account.")
    .action(async () => {
      await runDevicesList(process.env);
    });
  devices
    .command("revoke <deviceId>")
    .description("Revoke a device; its token stops working immediately. Never silent — explicit id required.")
    .action(async (deviceId: string) => {
      await runDevicesRevoke(deviceId, process.env);
    });
}
