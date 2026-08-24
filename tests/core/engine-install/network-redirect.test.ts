/**
 * Engine-install NETWORK ops: redirect handling on credentialed vs un-credentialed calls.
 *
 * These exercise the REAL `createEngineInstallOps()` (the one place in engine-install that touches
 * the network) against two local origins — every other installer test injects fake ops, so nothing
 * else covers the actual `fetch` options.
 *
 * The rule under test:
 *  - a request that CARRIES the device token (release listing; same-origin artifact download)
 *    REFUSES redirects — the credential reaches the host the user named and no other, and the
 *    redirect target receives NOTHING;
 *  - an UN-CREDENTIALED artifact download (CDN-hosted release) still FOLLOWS redirects, because
 *    that is how a CDN serves a file and there is no credential in the request to carry anywhere.
 *
 * Scope note: this is defence in depth, not a patched leak. On the tested Node runtime a
 * cross-origin redirect already drops the `Authorization` header; a SAME-origin hop keeps it. This
 * removes the redirect hop entirely on credentialed calls rather than relying on that behaviour.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngineInstallOps, EngineInstallError } from "../../../src/core/engine-install/installer.js";

const ARTIFACT_BYTES = "#!/usr/bin/env node\nconsole.log('engine');\n";

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

describe("engine-install network ops: redirects on credentialed calls", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  /** A destination origin that records every request it receives and serves the artifact bytes. */
  async function destination(): Promise<{ origin: string; received: Recorded[] }> {
    const received: Recorded[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      received.push({ url: req.url ?? "", authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(ARTIFACT_BYTES);
    });
    servers.push(server);
    const port = await listen(server);
    return { origin: `http://127.0.0.1:${port}`, received };
  }

  /** An origin that 302-redirects everything to `target`. */
  async function redirector(target: string): Promise<string> {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(302, { location: `${target}/redirected` });
      res.end();
    });
    servers.push(server);
    const port = await listen(server);
    return `http://127.0.0.1:${port}`;
  }

  function tempFile(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-redirect-"));
    dirs.push(dir);
    return path.join(dir, "artifact");
  }

  it("fetchLatestRelease REFUSES a redirect and the redirect target receives nothing", async () => {
    const dest = await destination();
    const apiOrigin = await redirector(dest.origin);

    await expect(createEngineInstallOps().fetchLatestRelease(apiOrigin, "cmpd_secret_token", "stable")).rejects.toThrow(
      EngineInstallError
    );
    // The device token never left for the redirect target — it never received a request at all.
    expect(dest.received).toEqual([]);
  });

  it("a CREDENTIALED artifact download REFUSES a redirect and the redirect target receives nothing", async () => {
    const dest = await destination();
    const artifactOrigin = await redirector(dest.origin);
    const destPath = tempFile();

    await expect(
      createEngineInstallOps().download(`${artifactOrigin}/engine.tar.gz`, destPath, {
        authorization: "Bearer cmpd_secret_token"
      })
    ).rejects.toThrow();
    expect(dest.received).toEqual([]);
  });

  it("an UN-CREDENTIALED CDN artifact download still FOLLOWS redirects", async () => {
    const dest = await destination();
    const cdnOrigin = await redirector(dest.origin);
    const destPath = tempFile();

    await createEngineInstallOps().download(`${cdnOrigin}/engine.tar.gz`, destPath, {});

    expect(readFileSync(destPath, "utf8")).toBe(ARTIFACT_BYTES);
    expect(dest.received).toHaveLength(1);
    // …and there was no credential to carry in the first place.
    expect(dest.received[0].authorization).toBeUndefined();
  });
});
