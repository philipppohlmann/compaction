/**
 * Device-authorization client (PUBLIC client) — the CLI side of the
 * browser device-code flow that activates a Community account.
 *
 * Network calls here go ONLY to the user-chosen Compaction service URL, ONLY when the user runs
 * an explicit account command (`compaction login` / `logout` / `devices`). Nothing on the Open
 * path imports this module (enforced by tests/security/open-basic-engine-free.test.ts's
 * import-graph walk over the Open entry points).
 *
 * The device key pair is generated LOCALLY; only the public key is sent. The private key never
 * leaves the credentials file. The device token is received once from the token poll and is
 * handed straight to the credentials store — never logged or echoed.
 */
import { generateKeyPairSync } from "node:crypto";
import { credentialedFetchInit } from "../net/credentialed-fetch.js";
import { terminalSafeText } from "../terminal-hyperlink.js";

export interface DeviceKeyPair {
  /** Base64url SPKI DER — sent to the service at flow start. */
  publicKey: string;
  /** PKCS8 PEM — stays in the local credentials file. */
  privateKeyPem: string;
}

/** Generate the local Ed25519 device key pair. */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

export interface StartedDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

export class DeviceFlowError extends Error {
  constructor(
    message: string,
    /** Coded reason for tests/callers; never contains a token. */
    readonly code:
      | "http_error"
      | "invalid_response"
      | "access_denied"
      | "expired"
      | "timeout"
      | "cancelled",
    /**
     * The HTTP status the service answered with, when there WAS one. Carried because it is the
     * difference between "we never reached the service" and "the service answered and refused":
     * without it a caller can only guess, and the CLI used to guess wrong and blame the user's
     * network for a service that had replied. A bare integer from the response line — never a
     * body, never a header, never anything the service said about the user.
     */
    readonly status?: number
  ) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

/**
 * POST to the device-authorization endpoints of the user-chosen service URL.
 *
 * Credential-bearing even though it sends no `Authorization` header: the request body carries the
 * short-lived `device_code` and the 200 response carries the ISSUED DEVICE TOKEN. Both belong only
 * to the host the user named, so this uses the same credentialed init (redirects refused) as the
 * Bearer-token calls below.
 */
async function postJson(
  url: string,
  body: unknown,
  signal?: AbortSignal
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    url,
    credentialedFetchInit({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    })
  );
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body (e.g. a proxy error page) — treated as an empty body; status carries the news.
  }
  return { status: res.status, body: parsed };
}

/** Start a device authorization: send the locally-generated public key, get codes + verify URL. */
export async function startDeviceAuthorization(
  apiUrl: string,
  input: { devicePublicKey: string; deviceName?: string; signal?: AbortSignal }
): Promise<StartedDeviceAuthorization> {
  const { status, body } = await postJson(
    `${apiUrl.replace(/\/+$/, "")}/v0/device/code`,
    {
      device_public_key: input.devicePublicKey,
      ...(input.deviceName ? { device_name: input.deviceName } : {})
    },
    input.signal
  );
  if (status !== 200) {
    throw new DeviceFlowError(
      `device authorization could not be started (HTTP ${status})`,
      "http_error",
      status
    );
  }
  const deviceCode = body.device_code;
  const userCode = body.user_code;
  const verificationUri = body.verification_uri;
  const verificationUriComplete = body.verification_uri_complete;
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof verificationUriComplete !== "string"
  ) {
    throw new DeviceFlowError("device authorization response was malformed", "invalid_response");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 600,
    pollIntervalSeconds: typeof body.interval === "number" && body.interval > 0 ? body.interval : 3
  };
}

export interface DeviceTokenResult {
  deviceToken: string;
  deviceId: string;
  accountId: string;
}

/**
 * Wait `ms`, or reject as soon as `signal` aborts. The abort path matters more than the wait: the
 * poll spends nearly all of its life sleeping between attempts, so a sleep that ignored the signal
 * would hold a cancel hostage for up to a full poll interval. The timer is always cleared so an
 * aborted wait leaves nothing pending on the event loop.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeviceFlowError("cancelled", "cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DeviceFlowError("cancelled", "cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll the token endpoint until the browser approval lands. Resolves with the issued token; throws a
 * coded DeviceFlowError on deny/expiry/timeout/cancel. `pollIntervalMs` is overridable so tests do not
 * wait wall-clock seconds.
 *
 * `signal` is LOAD-BEARING for any caller that is not a bare terminal command. This loop runs for up to
 * `expires_in` (600s by default) and spends nearly all of it sleeping. Without a signal the only way to
 * stop it is to kill the process — which is fine for `compaction login`, but not for the onboarding
 * stepper, where the user must be able to press Esc and get on with a working Open install. The signal
 * is honored at three points (before each attempt, by the in-flight fetch, and during the sleep) so a
 * cancel is observed within milliseconds rather than at the next interval boundary, and it surfaces as
 * the coded `cancelled` reason — never as a generic failure that would read like the service broke.
 */
export async function pollForDeviceToken(
  apiUrl: string,
  started: StartedDeviceAuthorization,
  options: { pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<DeviceTokenResult> {
  const intervalMs = options.pollIntervalMs ?? started.pollIntervalSeconds * 1000;
  const deadline = Date.now() + (options.timeoutMs ?? started.expiresInSeconds * 1000);
  const url = `${apiUrl.replace(/\/+$/, "")}/v0/device/token`;
  const signal = options.signal;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DeviceFlowError("cancelled", "cancelled");
    const { status, body } = await postJson(url, { device_code: started.deviceCode }, signal);
    if (status === 200) {
      const deviceToken = body.device_token;
      const deviceId = body.device_id;
      const accountId = body.account_id;
      if (typeof deviceToken !== "string" || typeof deviceId !== "string" || typeof accountId !== "string") {
        throw new DeviceFlowError("device token response was malformed", "invalid_response");
      }
      return { deviceToken, deviceId, accountId };
    }
    const error = typeof body.error === "string" ? body.error : "";
    if (error === "authorization_pending" || error === "slow_down") {
      await sleep(error === "slow_down" ? intervalMs * 2 : intervalMs, signal);
      continue;
    }
    if (error === "access_denied") throw new DeviceFlowError("the request was denied in the browser", "access_denied");
    if (error === "expired_token") throw new DeviceFlowError("the device code expired before approval", "expired");
    const detail = terminalSafeText(error);
    throw new DeviceFlowError(
      `device token poll failed (HTTP ${status}${detail ? `, ${detail}` : ""})`,
      "http_error",
      status
    );
  }
  throw new DeviceFlowError("timed out waiting for browser approval", "timeout");
}

export interface DeviceListEntry {
  id: string;
  name: string | null;
  status: string;
  createdAt: string;
  lastSeenAt: string | null;
}

/** List the account's devices using the device token. */
export async function listAccountDevices(apiUrl: string, deviceToken: string): Promise<DeviceListEntry[]> {
  const res = await fetch(
    `${apiUrl.replace(/\/+$/, "")}/v0/devices`,
    credentialedFetchInit({ headers: { authorization: `Bearer ${deviceToken}` } })
  );
  if (res.status !== 200) throw new DeviceFlowError(`device list failed (HTTP ${res.status})`, "http_error");
  const body = (await res.json()) as { devices?: unknown };
  if (!Array.isArray(body.devices)) throw new DeviceFlowError("device list response was malformed", "invalid_response");
  return body.devices.map((d) => {
    const row = d as Record<string, unknown>;
    return {
      id: String(row.id ?? ""),
      name: typeof row.name === "string" ? row.name : null,
      status: String(row.status ?? "unknown"),
      createdAt: String(row.created_at ?? ""),
      lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null
    };
  });
}

/**
 * Revoke a device (device-token auth). Returns false when the service says it wasn't there. Bounded by
 * a short abort timeout so a service that accepts the connection but never responds cannot hang the
 * caller indefinitely — `logout` treats this as best-effort and has already removed local credentials.
 */
export async function revokeAccountDevice(
  apiUrl: string,
  deviceToken: string,
  deviceId: string,
  timeoutMs = 10_000
): Promise<boolean> {
  const res = await fetch(
    `${apiUrl.replace(/\/+$/, "")}/v0/devices/revoke`,
    credentialedFetchInit({
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ device_id: deviceId }),
      signal: AbortSignal.timeout(timeoutMs)
    })
  );
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new DeviceFlowError(`device revoke failed (HTTP ${res.status})`, "http_error");
}
