/**
 * Entitlement-lease client (PUBLIC client) — the CLI network side of lease acquisition.
 *
 * Network I/O happens ONLY here, only inside the explicit `compaction lease` command, only to the
 * user-chosen Compaction service URL, authenticated by the DEVICE token. This module lives under
 * `src/core/auth/` (a forbidden substring on the Open basic import graph) BY DESIGN — the pure
 * lease READER/VERIFIER (`../entitlement/lease-store.ts`) is a separate module that imports nothing
 * from here, so the Open path never gains a network/auth edge. Lease acquisition is never
 * import-time and never a per-turn implicit fetch.
 *
 * The signed lease is verified by the store on read; this client only fetches and persists it. The
 * device token is used as a Bearer credential and never logged.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { credentialedFetchInit, describeCredentialedFetchFailure } from "../net/credentialed-fetch.js";
import { parseSignedLease, type SignedLease } from "../entitlement/lease.js";
import { leasePath } from "../entitlement/lease-store.js";
import type { ConfigDirEnv } from "../config-dir.js";
import { terminalSafeText } from "../terminal-hyperlink.js";

export class LeaseClientError extends Error {
  constructor(
    message: string,
    /** Coded reason for callers/tests; never contains a token. */
    readonly code:
      | "http_error"
      | "not_entitled"
      | "signing_unavailable"
      | "device_inactive"
      | "unauthorized"
      | "invalid_response"
      | "network"
      /** The caller aborted the attempt (user pressed Esc / Ctrl-C). NOT a service failure. */
      | "cancelled"
  ) {
    super(message);
    this.name = "LeaseClientError";
  }
}

/**
 * Acquire (issue/renew) a signed lease from the service using the device token.
 *
 * `signal` CANCELS THE REQUEST IN FLIGHT rather than merely being ignored. Onboarding tells the user
 * "Esc / Ctrl-C to stop and continue on Open"; without a signal reaching this fetch that promise was
 * only a UI state change, and the socket stayed open until the service answered. An abort surfaces
 * as the `cancelled` code so a caller can tell a user's decision apart from an unreachable service.
 */
export async function acquireLease(
  apiUrl: string,
  deviceToken: string,
  opts: { signal?: AbortSignal } = {}
): Promise<SignedLease> {
  // The device token is a credential: it goes to the host the user named and NOWHERE else. The
  // shared credentialed init refuses redirects, so no response can move the token to another host.
  let res: Response;
  try {
    res = await fetch(
      `${apiUrl.replace(/\/+$/, "")}/v0/lease`,
      credentialedFetchInit({
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
        body: "{}",
        ...(opts.signal === undefined ? {} : { signal: opts.signal })
      })
    );
  } catch (error) {
    // An ABORT also lands here, and it is not a network fault: reporting a user's Esc as "the
    // entitlement service could not be reached" would blame the service for the user's decision.
    if (opts.signal?.aborted === true) throw new LeaseClientError("lease acquisition was cancelled", "cancelled");
    // A refused redirect THROWS — before the `HTTP ${status}` branch below can run — so an operator
    // with a typo'd URL used to see only the runtime's opaque `fetch failed`. Decode it here.
    throw new LeaseClientError(describeCredentialedFetchFailure(error), "network");
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // AN ABORT LANDS HERE TOO, and it is still not a malformed response. Once the service has sent
    // its headers the `fetch` above has already resolved, so a later Esc rejects the BODY read
    // instead: swallowing that left `body` empty, and a 200 whose body never arrived was then
    // reported as `invalid_response` — the service blamed for a message it was still sending.
    if (opts.signal?.aborted === true) throw new LeaseClientError("lease acquisition was cancelled", "cancelled");
    // Non-JSON body — the status carries the news.
  }
  if (res.status === 200) {
    const lease = parseSignedLease(body);
    if (!lease) throw new LeaseClientError("lease response was malformed", "invalid_response");
    return lease;
  }
  const error = typeof body.error === "string" ? body.error : "";
  if (res.status === 401) throw new LeaseClientError("device token was not accepted", "unauthorized");
  if (error === "not_entitled") {
    throw new LeaseClientError("this account is not entitled to Community full apply", "not_entitled");
  }
  if (error === "lease_signing_unavailable") {
    throw new LeaseClientError("the service is not configured to issue leases yet", "signing_unavailable");
  }
  if (error === "device_inactive") throw new LeaseClientError("this device is no longer active", "device_inactive");
  const detail = terminalSafeText(error);
  throw new LeaseClientError(`lease request failed (HTTP ${res.status}${detail ? `, ${detail}` : ""})`, "http_error");
}

/** Persist a signed lease at `<configDir>/lease.json` (mode 0600, dir 0700). Returns the path. */
export function writeStoredLease(lease: SignedLease, env: ConfigDirEnv = process.env): string {
  const path = leasePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Delete the stored lease (best-effort). Missing file is fine. */
export function deleteStoredLease(env: ConfigDirEnv = process.env): void {
  rmSync(leasePath(env), { force: true });
}
