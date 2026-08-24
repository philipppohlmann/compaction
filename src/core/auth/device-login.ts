/**
 * The CONSOLE-FREE device-login flow (PUBLIC client).
 *
 * `compaction login` used to own this sequence inline, interleaved with a dozen `console.log`s. That
 * is fine for a bare terminal command and fatal inside the onboarding stepper: Ink owns the frame, so
 * writes from underneath it corrupt the render, and the alt screen is wiped on exit — the verification
 * URL the user still needs would scroll past and then disappear. So the sequence lives here, reporting
 * through a callback, and `login.ts` becomes a thin printing wrapper over it. Both callers run the SAME
 * flow; only the rendering differs.
 *
 * HARD RAILS:
 *  - Network I/O only to the user-chosen service URL, only from an explicit user action (the stepper's
 *    Community choice, or `compaction login`).
 *  - WHAT LEAVES THIS MODULE IS A CLOSED LIST: the progress phase, the user code and verification URL
 *    (both meant to be read by the user), and — on success — the account's own email, the resolved
 *    service URL, and whether the device was already signed in. Email is on the list deliberately: it
 *    is identity the user just typed into the browser, not a secret, and it authorizes nothing.
 *    The device token, the device id, and the locally-generated private key are NOT: they go straight
 *    to the 0600 credentials file and are never handed to a caller, never logged, never rendered.
 *  - Every failure is a CODED reason, never a raw error string. The seven reasons are genuinely
 *    different user stories (an offline install is not a denied approval), and collapsing them into
 *    one message is how a first-run flow ends up telling a user on a plane that they were denied.
 *    On the two ANSWERED reasons (`endpoint_not_found`, `service_error`) the HTTP STATUS is on the
 *    closed list too: a bare integer from the response line, which is the one detail that lets a
 *    user check their URL and lets whoever is standing the service up act.
 *  - Logging in does NOT enable full apply by itself: the entitlement lease and the per-tool apply
 *    authorization stay separate.
 */
import { hostname } from "node:os";
import { resolveTarget } from "../api-client/persisted-config.js";
import { readStoredCredentials, writeStoredCredentials, type StoredCredentials } from "./credentials.js";
import {
  DeviceFlowError,
  generateDeviceKeyPair,
  pollForDeviceToken,
  startDeviceAuthorization
} from "./device-flow.js";

/**
 * Content-free progress reports. The stepper renders these; they are the ONLY thing that crosses back
 * into the UI while the flow runs, and they carry nothing secret.
 */
export type DeviceLoginProgress =
  | { kind: "starting" }
  /** The two things the user must see. On a headless/SSH shell the browser open silently no-ops, so a
   *  surface that does not render these leaves the user with nothing to act on. */
  | { kind: "awaiting-browser"; userCode: string; verificationUri: string }
  | { kind: "polling" };

/**
 * Why a login did not complete. Deliberately seven values, not one: `unreachable` means nothing
 * answered at all and retrying later is the answer; `endpoint_not_found` means a server answered the
 * flow's FIRST request and is not serving device authorization at that path, so the URL is the thing
 * to check; `service_error` means the Compaction service ANSWERED and could not do device auth, so
 * there is nothing on the user's side to fix; `denied` means a human said no in the browser;
 * `cancelled` means the user pressed Esc and wants to move on. A surface that renders one message
 * for all of them is telling most users something false.
 *
 * The three NON-user-action reasons are kept apart because their remedies point at different places:
 * the network, the configured URL, and the service operator. Collapsing any pair is the defect this
 * split exists to prevent — first a service answering `503` was reported as unreachable (F67), which
 * sent the user to debug a network that was working; then every answered error was reported as a
 * service-side problem, which took the URL remedy away from a user whose URL was the fixable thing;
 * then the URL remedy was offered on a poll failure, after that same URL had already answered — the
 * one case where "check your URL" sends a user to break a working configuration.
 */
export type DeviceLoginFailureReason =
  | "denied"
  | "expired"
  | "timeout"
  | "unreachable"
  | "endpoint_not_found"
  | "service_error"
  | "cancelled";

export type DeviceLoginOutcome =
  | { ok: true; email?: string; apiUrl: string; alreadyLoggedIn: boolean }
  | {
      ok: false;
      reason: DeviceLoginFailureReason;
      apiUrl: string;
      /** The status that came back. Present only on the two ANSWERED reasons — `endpoint_not_found`
       *  and `service_error`. */
      serviceStatus?: number;
    };

export interface DeviceLoginOptions {
  apiUrl?: string;
  deviceName?: string;
  /** Called with the verification URL so a caller can open a browser. Omitted → no browser is opened. */
  openBrowser?: (url: string) => void;
  /** Aborts the (long) approval poll. Without one, the only way to stop it is to kill the process. */
  signal?: AbortSignal;
  /** Overridable so tests do not wait wall-clock seconds. */
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/**
 * WHICH REQUEST FAILED. The flow makes two calls to the same base URL — `start` opens device
 * authorization, `poll` waits for the approval — and the difference decides whether the URL is
 * still a candidate explanation. It is a REQUIRED argument, not a defaulted one: a caller who
 * forgets would get the URL-blaming branch, which is the wrong direction to fail in.
 */
export type DeviceLoginPhase = "start" | "poll";

/**
 * The two statuses that answer ABOUT THE ENDPOINT rather than about the service's own state: 404
 * (nothing is served at that path) and 405 (that path exists but does not take this POST). Either
 * way some server replied and it is not serving device authorization there, which is what a wrong
 * host or a wrong base path looks like from the client — so the configured URL is the thing the
 * user can act on. No other status is read this way: a 5xx is the service's own state, and guessing
 * at the rest would be inventing a cause.
 *
 * ONLY ON THE START REQUEST. By the time the flow is polling, that same base URL has already
 * ANSWERED a device-authorization request and handed back a user code — so the URL is demonstrably
 * the right one, and a 404 on the poll is the service losing a route mid-flight (a partial rollout,
 * a proxy splitting the two paths), not a URL the user mistyped. Telling that user to change a URL
 * that just worked sends them to break a working configuration, which is the same class of defect
 * as F67 in the other direction.
 *
 * What this does NOT prove even on `start`, and the copy must not claim: that the user's URL is
 * wrong. A real Compaction service can 404 its own route mid-deploy. It proves only that the
 * endpoint was not there, which is why the remedy is offered rather than the mistake asserted.
 */
function isEndpointMiss(status: number | undefined, phase: DeviceLoginPhase): boolean {
  return phase === "start" && (status === 404 || status === 405);
}

/** Map a device-flow failure onto its coded reason. Anything unrecognised is `unreachable` — the
 *  honest default, since an unclassifiable failure is far more often a transport problem than a
 *  deliberate denial, and it is the reason whose remedy ("try again later") is harmless if wrong.
 *
 *  `http_error` is the one case that must NOT take that default: it is only ever thrown after a
 *  response came back, so the service demonstrably answered and "could not reach it" would be false.
 *  It splits again on the status AND on which request failed, because an HTTP response proves a
 *  server was reached — not that the reached server is the Compaction API, and not, once the flow is
 *  polling, that anything about the URL is still in question. The `default:` arm stays exactly as it
 *  was, for failures that really are unclassifiable transport problems — that distinction is the
 *  whole point of the split. */
export function reasonFor(error: unknown, phase: DeviceLoginPhase): DeviceLoginFailureReason {
  if (!(error instanceof DeviceFlowError)) {
    // A raw AbortError from the in-flight fetch is a cancel, not a service failure.
    return error instanceof Error && error.name === "AbortError" ? "cancelled" : "unreachable";
  }
  switch (error.code) {
    case "access_denied":
      return "denied";
    case "expired":
      return "expired";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "http_error":
      return isEndpointMiss(error.status, phase) ? "endpoint_not_found" : "service_error";
    default:
      return "unreachable";
  }
}

/** The status the service answered with, when the failure was one it answered. */
function serviceStatusFor(error: unknown): number | undefined {
  return error instanceof DeviceFlowError ? error.status : undefined;
}

/** The failure half of an outcome, with the status attached only when there is one to attach. */
function failureFor(error: unknown, apiUrl: string, phase: DeviceLoginPhase): DeviceLoginOutcome {
  const status = serviceStatusFor(error);
  return {
    ok: false,
    reason: reasonFor(error, phase),
    apiUrl,
    ...(status === undefined ? {} : { serviceStatus: status })
  };
}

/**
 * Run the browser device-code flow and persist the credentials on success.
 *
 * IDEMPOTENT: an already-logged-in device returns `{ok: true, alreadyLoggedIn: true}` without a single
 * network call. This is what lets the stepper offer Community unconditionally — a user re-running
 * onboarding is not dragged through a second browser round trip, and nothing is overwritten.
 */
export async function performDeviceLogin(
  options: DeviceLoginOptions = {},
  onProgress: (progress: DeviceLoginProgress) => void = () => undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<DeviceLoginOutcome> {
  const existing = readStoredCredentials(env);
  if (existing) {
    return {
      ok: true,
      ...(existing.email ? { email: existing.email } : {}),
      apiUrl: existing.api_url,
      alreadyLoggedIn: true
    };
  }

  const apiUrl = resolveTarget({ flagUrl: options.apiUrl, env }).url;
  const deviceName = options.deviceName ?? hostname();
  const keyPair = generateDeviceKeyPair();

  onProgress({ kind: "starting" });

  let started;
  try {
    started = await startDeviceAuthorization(apiUrl, {
      devicePublicKey: keyPair.publicKey,
      deviceName,
      ...(options.signal ? { signal: options.signal } : {})
    });
  } catch (error) {
    return failureFor(error, apiUrl, "start");
  }

  // Report BEFORE opening the browser: on a headless/SSH shell the open silently no-ops, and the
  // printed URL is then the only way through.
  onProgress({
    kind: "awaiting-browser",
    userCode: started.userCode,
    verificationUri: started.verificationUriComplete
  });
  options.openBrowser?.(started.verificationUriComplete);
  onProgress({ kind: "polling" });

  let token;
  try {
    token = await pollForDeviceToken(apiUrl, started, {
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    });
  } catch (error) {
    // `poll`, not `start`: the same base URL already answered the start request above and returned a
    // user code, so it is not a URL the user needs to change.
    return failureFor(error, apiUrl, "poll");
  }

  const credentials: StoredCredentials = {
    schema_version: 1,
    api_url: apiUrl,
    account_id: token.accountId,
    device_id: token.deviceId,
    device_name: deviceName,
    device_token: token.deviceToken,
    device_private_key_pem: keyPair.privateKeyPem,
    device_public_key: keyPair.publicKey,
    created_at: new Date().toISOString()
  };
  writeStoredCredentials(credentials, env);
  return { ok: true, apiUrl, alreadyLoggedIn: false };
}
