/**
 * `acquireLease` — how a lease request ENDS, in the caller's vocabulary.
 *
 * The coded reason is not decoration: onboarding renders "Esc / Ctrl-C to stop and continue on
 * Open" during this exact wait, and `ensureCommunityRuntime` passes whatever code comes back
 * straight into the outcome a surface prints. So a user's decision must never come back wearing the
 * service's failure — the difference between "you stopped" and "we could not reach the service" is
 * the difference between an accurate screen and an accusation.
 *
 * HERMETIC: a throwaway loopback server, a fake token, no real service anywhere.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLease, LeaseClientError } from "../../src/core/auth/lease-client.js";

// The FAKE MARKER HAS TO BE IN THE FIRST SEGMENT. The repo-wide secret scan captures a
// secret-named assignment with a character class that excludes ".", so it only ever sees the
// text before the dot — a marker parked after it is invisible and the line reads as a real
// credential. Sibling fixtures escape by naming the field `device_token` (no word boundary
// before "token"); this one is a bare constant, so the value itself has to say what it is.
const TOKEN = "cmpd_test_fake0000-e89b-42d3-a456-426614174000.fakefakefakefakefakefakefakefake";

let server: http.Server | undefined;
afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

async function start(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "no-error";
  } catch (error) {
    expect(error).toBeInstanceOf(LeaseClientError);
    return (error as LeaseClientError).code;
  }
}

describe("acquireLease cancellation", () => {
  it("reports an abort during the BODY as cancelled, not as a malformed response", async () => {
    // THE WINDOW THIS COVERS. `fetch` resolves as soon as the HEADERS arrive, so an Esc pressed while
    // the JSON is still streaming does not reject the fetch — it rejects the body read. That
    // rejection used to be swallowed as "non-JSON body", leaving an empty object that failed to parse
    // as a lease, so a 200 the user themselves interrupted was reported as `invalid_response`: the
    // service blamed for a message it was still in the middle of sending.
    const controller = new AbortController();
    const url = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"lease":'); // headers sent, body deliberately incomplete
      setTimeout(() => controller.abort(), 20);
    });

    expect(await codeOf(acquireLease(url, TOKEN, { signal: controller.signal }))).toBe("cancelled");
  });

  it("still reports a genuinely malformed 200 as invalid_response when nobody cancelled", async () => {
    // The guard above must not swallow real defects: with no abort, an unparseable success is still
    // the service's problem and still says so.
    const url = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json at all");
    });

    expect(await codeOf(acquireLease(url, TOKEN))).toBe("invalid_response");
  });

  it("reports an abort before the headers as cancelled too — the same decision, an earlier moment", async () => {
    const controller = new AbortController();
    const url = await start(() => {
      // Accepted and never answered: the abort has to be what ends this.
      setTimeout(() => controller.abort(), 20);
    });

    expect(await codeOf(acquireLease(url, TOKEN, { signal: controller.signal }))).toBe("cancelled");
  });
});
