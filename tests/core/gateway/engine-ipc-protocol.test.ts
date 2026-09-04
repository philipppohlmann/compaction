/**
 * Native-engine IPC protocol codec tests.
 *
 * Proven here (pure/unit level; the end-to-end spawn round-trip is in
 * tests/core/engine-supervisor.test.ts):
 * - a request/response round-trips through encode → FrameDecoder → decode byte-identically;
 * - the length prefix is a 4-byte big-endian frame body length;
 * - frames split arbitrarily across chunks reassemble; multiple frames in one chunk all surface;
 * - encoding a body over the max frame size is refused (EngineIpcFrameError), never written;
 * - a declared length over the max is a fatal decode error (bounded — no unbounded allocation);
 * - a body that is not valid JSON is a fatal decode error;
 * - the shape guards accept well-formed frames and reject malformed ones;
 * - the protocol types carry NO credential/network field (structural assertion on a built request).
 */
import { describe, expect, it } from "vitest";
import {
  ENGINE_IPC_PROTOCOL_VERSION,
  EngineIpcFrameError,
  FrameDecoder,
  MAX_ENGINE_IPC_FRAME_BYTES,
  encodeFrame,
  isEngineIpcRequest,
  isEngineIpcResponse,
  type EngineIpcRequest,
  type EngineIpcResponse
} from "../../../src/core/gateway/engine-ipc/protocol.js";

function sampleRequest(overrides: Partial<EngineIpcRequest> = {}): EngineIpcRequest {
  return {
    protocol_version: ENGINE_IPC_PROTOCOL_VERSION,
    request_id: "req-1",
    operation: "plan_and_apply",
    workflow: "claude-code",
    provider: "anthropic",
    route_type: "api-key",
    request_body: '{"messages":[{"role":"user","content":"hi"}]}',
    authorization: { policy_id: "pol-1", scope_hash: "abc123" },
    entitlement: { token: "opaque-placeholder" },
    quota: { period_id: "2026-07", locally_allocated_tokens_remaining: 2_000_000 },
    ...overrides
  };
}

function sampleResponse(overrides: Partial<EngineIpcResponse> = {}): EngineIpcResponse {
  return {
    protocol_version: ENGINE_IPC_PROTOCOL_VERSION,
    request_id: "req-1",
    result: "noop",
    applied_components: [],
    recovery_required: false,
    ...overrides
  };
}

describe("engine IPC protocol codec", () => {
  it("round-trips a request byte-identically through encode → decode", () => {
    const req = sampleRequest();
    const frame = encodeFrame(req);
    const decoder = new FrameDecoder();
    const [decoded] = decoder.push(frame);
    expect(decoded).toEqual(req);
  });

  it("uses a 4-byte big-endian length prefix equal to the JSON body length", () => {
    const req = sampleRequest();
    const frame = encodeFrame(req);
    const declared = frame.readUInt32BE(0);
    expect(declared).toBe(frame.length - 4);
    expect(Buffer.from(frame.subarray(4)).toString("utf8")).toBe(JSON.stringify(req));
  });

  it("reassembles a frame split arbitrarily across chunks", () => {
    const frame = encodeFrame(sampleResponse());
    const decoder = new FrameDecoder();
    // Feed one byte at a time: nothing surfaces until the last byte.
    let out: unknown[] = [];
    for (let i = 0; i < frame.length; i++) {
      out = out.concat(decoder.push(frame.subarray(i, i + 1)));
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(sampleResponse());
  });

  it("surfaces multiple frames delivered in one chunk, in order", () => {
    const a = encodeFrame(sampleResponse({ request_id: "a" }));
    const b = encodeFrame(sampleResponse({ request_id: "b" }));
    const decoder = new FrameDecoder();
    const out = decoder.push(Buffer.concat([a, b]));
    expect(out.map((m) => (m as EngineIpcResponse).request_id)).toEqual(["a", "b"]);
  });

  it("refuses to encode a body over the max frame size", () => {
    const huge = "x".repeat(MAX_ENGINE_IPC_FRAME_BYTES + 1);
    expect(() => encodeFrame(sampleRequest({ request_body: huge }))).toThrow(EngineIpcFrameError);
  });

  it("treats a declared length over the max as a fatal, bounded decode error", () => {
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(MAX_ENGINE_IPC_FRAME_BYTES + 1, 0);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(prefix)).toThrow(EngineIpcFrameError);
  });

  it("treats a non-JSON frame body as a fatal decode error", () => {
    const body = Buffer.from("not-json{", "utf8");
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(body.length, 0);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.concat([prefix, body]))).toThrow(EngineIpcFrameError);
  });

  it("shape guards accept well-formed and reject malformed frames", () => {
    expect(isEngineIpcRequest(sampleRequest())).toBe(true);
    expect(isEngineIpcResponse(sampleResponse())).toBe(true);
    expect(isEngineIpcRequest(sampleResponse())).toBe(false);
    expect(isEngineIpcResponse(sampleRequest())).toBe(false);
    expect(isEngineIpcRequest({ protocol_version: 2, request_id: "x", operation: "ping", request_body: "", authorization: {} })).toBe(false);
    expect(isEngineIpcRequest(null)).toBe(false);
    expect(isEngineIpcResponse({})).toBe(false);
    expect(isEngineIpcResponse(sampleResponse({ output_shaping_state: "already-active" }))).toBe(true);
    expect(isEngineIpcResponse({ ...sampleResponse(), output_shaping_state: "invented" })).toBe(false);
    expect(isEngineIpcResponse({ ...sampleResponse({ result: "refused" }), output_shaping_state: "absent" })).toBe(false);
  });

  it("carries no credential or network field in the request type", () => {
    // Structural guard: the serialized request has exactly the protocol fields — none is a credential,
    // Authorization header, or URL. If a future edit adds one, this test names it.
    const keys = Object.keys(sampleRequest()).sort();
    expect(keys).toEqual(
      [
        "authorization",
        "entitlement",
        "operation",
        "protocol_version",
        "provider",
        "quota",
        "request_body",
        "request_id",
        "route_type",
        "workflow"
      ].sort()
    );
    const forbidden = ["api_key", "apiKey", "authorization_header", "authorizationHeader", "provider_url", "providerUrl", "url", "headers", "key", "secret", "token_secret"];
    const json = JSON.stringify(sampleRequest());
    for (const f of forbidden) {
      expect(json.includes(`"${f}"`)).toBe(false);
    }
  });
});
