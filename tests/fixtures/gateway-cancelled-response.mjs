/** Standalone real-socket regression: an uncaught server error must terminate this subprocess. */
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [modulePath, scenario] = process.argv.slice(2);
const support = scenario.startsWith("support-");
const lateError = scenario.endsWith("error");
const { startGatewayServer } = await import(pathToFileURL(modulePath).href);
const capability = "synthetic-local-capability".padEnd(43, "x");
const endpoint = support ? `/__compaction/claude/${capability}/v1/messages/count_tokens` : "/v1/responses";
const requestBytes = Buffer.from('{"messages":[]}');
const responseBytes = Buffer.from([0, 255, 128, 1, 10, 13, 65, 66, 67]);
const auth = "Bearer synthetic-local-fixture";
let respondToCancelled;
let sawUpstream;
const received = new Promise((resolve) => { sawUpstream = resolve; });
let upstreamCalls = 0;
let upstreamSocketClosed;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    assert.deepEqual(Buffer.concat(chunks), requestBytes);
    assert.equal(req.headers.authorization, auth);
    assert.equal(req.url, support ? "/v1/messages/count_tokens" : endpoint);
    upstreamCalls += 1;
    if (upstreamCalls === 1) {
      upstreamSocketClosed = once(req.socket, "close");
      respondToCancelled = () => lateError ? req.socket.destroy() : res.end(responseBytes);
      sawUpstream();
      return;
    }
    res.writeHead(207, { "content-type": "application/octet-stream" });
    res.write(responseBytes.subarray(0, 3));
    setImmediate(() => res.end(responseBytes.subarray(3)));
  });
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;
const originalHttpsRequest = https.request;
if (support) {
  // Only replace the transport destination; the real support route must still select its pinned origin.
  https.request = (options, callback) => {
    assert.equal(options.hostname, "api.anthropic.com");
    return http.request({ ...options, protocol: "http:", hostname: "127.0.0.1", port: upstreamPort }, callback);
  };
}
const gateway = await startGatewayServer({
  provider: support ? "anthropic" : "openai", mode: "record", host: "127.0.0.1", port: 0,
  upstream: `http://127.0.0.1:${upstreamPort}`, cwd: process.cwd(),
  entitlementEnv: { COMPACTION_CONFIG_DIR: process.env.COMPACTION_CONFIG_DIR },
  ...(support ? { workflow: "claude-code", claudeSubscription: { capability } } : {})
});
let lateWrites = 0;
let downstreamClosed;
gateway.server.once("request", (_req, res) => {
  downstreamClosed = once(res, "close");
  // Observe real ServerResponse methods without substituting streams or swallowing exceptions.
  for (const method of ["writeHead", "write", "end"]) {
    const original = res[method];
    res[method] = function (...args) {
      if (this.destroyed || this.writableEnded) lateWrites += 1;
      return original.apply(this, args);
    };
  }
});
const clientOptions = { hostname: "127.0.0.1", port: gateway.address.port, path: endpoint,
  method: "POST", agent: false, headers: { authorization: auth, "content-type": "application/json" } };
const client = http.request(clientOptions);
client.on("error", () => {});
client.end(requestBytes);
await received;
client.destroy();
await downstreamClosed;
respondToCancelled();
await upstreamSocketClosed;

const next = await new Promise((resolve, reject) => {
  const request = http.request(clientOptions, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on("error", reject);
  });
  request.on("error", reject);
  request.end(requestBytes);
});
assert.equal(next.status, 207);
assert.equal(next.headers["content-type"], "application/octet-stream");
assert.deepEqual(next.body, responseBytes);
await gateway.close();
await new Promise((resolve) => upstream.close(resolve));
https.request = originalHttpsRequest;
assert.equal(lateWrites, 0);
assert.equal(upstreamCalls, 2);
const receiptsPath = path.join(process.cwd(), ".compaction/gateway/receipts.jsonl");
const receipts = existsSync(receiptsPath) ? readFileSync(receiptsPath, "utf8").trim().split("\n").filter(Boolean) : [];
assert.equal(receipts.length, support ? 0 : 1);
console.log(JSON.stringify({ scenario, lateWrites, upstreamCalls, receiptCount: receipts.length,
  nextResponseBytes: next.body.length, nextResponseStatus: next.status, closed: !gateway.server.listening && !upstream.listening }));
