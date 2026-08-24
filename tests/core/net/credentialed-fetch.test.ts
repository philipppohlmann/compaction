import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { credentialedFetchInit } from "../../../src/core/net/credentialed-fetch.js";
import { listAccountDevices, revokeAccountDevice, startDeviceAuthorization } from "../../../src/core/auth/device-flow.js";
import { FetchProviderUsageClient } from "../../../src/core/provider-usage/provider-usage-client.js";
import { apiStatus } from "../../../src/core/api-client/client.js";

/**
 * REDIRECT POLICY on credential-bearing calls, exercised through the REAL modules (no fetch stub):
 * a redirect is refused, and the redirect TARGET receives nothing at all.
 *
 * Honest scope, unchanged from the engine-install redirect tests: this is defence in depth and
 * provenance, not a patched leak. On this Node runtime a CROSS-ORIGIN redirect already drops the
 * `Authorization` header — these tests assert the stronger property that the hop is not made.
 */
interface Recorded {
  url: string;
  authorization: string | undefined;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("credentialedFetchInit", () => {
  it("stamps the refuse-redirects policy and preserves everything else the caller passed", () => {
    const signal = AbortSignal.timeout(1000);
    const init = credentialedFetchInit({
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
      signal
    });
    expect(init.redirect).toBe("error");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: "Bearer t", "content-type": "application/json" });
    expect(init.body).toBe("{}");
    expect(init.signal).toBe(signal);
  });

  it("does not mutate the caller's init object", () => {
    const original = { method: "GET" as const };
    const init = credentialedFetchInit(original);
    expect(init).not.toBe(original);
    expect("redirect" in original).toBe(false);
  });

  it("applies to a bare call with no init at all", () => {
    expect(credentialedFetchInit().redirect).toBe("error");
  });
});

describe("credentialed calls refuse redirects", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
  });

  /** A destination that records every request it receives (it should record none). */
  async function destination(): Promise<{ origin: string; received: Recorded[] }> {
    const received: Recorded[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      received.push({ url: req.url ?? "", authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ devices: [], device_token: "t", device_id: "d", account_id: "a", input_tokens: 1 }));
    });
    servers.push(server);
    return { origin: `http://127.0.0.1:${await listen(server)}`, received };
  }

  /** An origin that answers every request with a 302 to `target`. */
  async function redirector(target: string): Promise<string> {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(302, { location: target });
      res.end();
    });
    servers.push(server);
    return `http://127.0.0.1:${await listen(server)}`;
  }

  it("device list (device token) refuses the redirect and the target sees nothing", async () => {
    const dest = await destination();
    const from = await redirector(`${dest.origin}/v0/devices`);
    await expect(listAccountDevices(from, "device-token-fake")).rejects.toThrow();
    expect(dest.received).toEqual([]);
  });

  it("device revoke (device token) refuses the redirect and the target sees nothing", async () => {
    const dest = await destination();
    const from = await redirector(`${dest.origin}/v0/devices/revoke`);
    await expect(revokeAccountDevice(from, "device-token-fake", "device-1")).rejects.toThrow();
    expect(dest.received).toEqual([]);
  });

  it("device-authorization start (carries the device code, returns the token) refuses the redirect", async () => {
    const dest = await destination();
    const from = await redirector(`${dest.origin}/v0/device/code`);
    await expect(startDeviceAuthorization(from, { devicePublicKey: "pk-fake" })).rejects.toThrow();
    expect(dest.received).toEqual([]);
  });

  it("provider-usage read (the user's PROVIDER key) refuses the redirect and the target sees nothing", async () => {
    const dest = await destination();
    const from = await redirector(`${dest.origin}/usage`);
    await expect(
      new FetchProviderUsageClient().fetchUsage({ endpoint: `${from}/usage`, credential: "provider-key-fake" })
    ).rejects.toThrow();
    expect(dest.received).toEqual([]);
  });

  it("the Compaction API client refuses the redirect (a configured API key rides these calls)", async () => {
    const dest = await destination();
    const from = await redirector(`${dest.origin}/v0/status`);
    await expect(apiStatus({ url: from, apiKey: "compaction-key-fake", timeoutMs: 2000 })).rejects.toThrow();
    expect(dest.received).toEqual([]);
  });

  it("a NON-redirecting credentialed call still works (the policy refuses hops, not requests)", async () => {
    const dest = await destination();
    await expect(listAccountDevices(dest.origin, "device-token-fake")).resolves.toEqual([]);
    expect(dest.received).toHaveLength(1);
    expect(dest.received[0].authorization).toBe("Bearer device-token-fake");
  });
});
