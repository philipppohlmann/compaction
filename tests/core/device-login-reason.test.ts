import { describe, expect, it } from "vitest";
import { DeviceFlowError } from "../../src/core/auth/device-flow.js";
import { reasonFor } from "../../src/core/auth/device-login.js";

/**
 * The failure-reason mapper. The property under test is a DISTINCTION, not a lookup table: a service
 * that answered and a service that was never reached are different stories with different remedies,
 * and the mapper is the only place that decides which one the user is told (F67 — a `503` from a
 * healthy service was reported as "unreachable", sending the user to debug a working network).
 *
 * Both halves are asserted in every case that matters, because a fix that mapped `http_error`
 * correctly while also collapsing the `default:` arm would pass a one-sided test and lose the
 * distinction it was written to create.
 */
describe("reasonFor: a service that ANSWERED is not a service that was unreachable", () => {
  it("maps an answered-with-an-error response to service_error, carrying nothing but the code", () => {
    expect(reasonFor(new DeviceFlowError("device authorization could not be started", "http_error", 503), "start")).toBe(
      "service_error"
    );
  });

  it("still maps an unclassifiable transport failure to unreachable", () => {
    // No response ever arrived: fetch rejected. This is the case `unreachable` exists for, and it
    // must NOT be swept into service_error along with the answered ones.
    const transport = Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNREFUSED") });
    expect(reasonFor(transport, "start")).toBe("unreachable");
  });

  it("keeps the two apart for the same flow: an answered 503 and a refused connection differ", () => {
    const answered = reasonFor(new DeviceFlowError("device token poll failed", "http_error", 503), "start");
    const neverReached = reasonFor(new TypeError("fetch failed"), "start");
    expect(answered).not.toBe(neverReached);
  });

  it("leaves a DeviceFlowError code with no case of its own on the unreachable default", () => {
    // `invalid_response` has no case; the default arm is deliberately unchanged, so it still lands on
    // the reason whose remedy ("try again later") is harmless when it is the wrong guess.
    expect(reasonFor(new DeviceFlowError("device authorization response was malformed", "invalid_response"), "start")).toBe(
      "unreachable"
    );
  });

  it("preserves the four reasons that already worked", () => {
    expect(reasonFor(new DeviceFlowError("denied", "access_denied"), "start")).toBe("denied");
    expect(reasonFor(new DeviceFlowError("expired", "expired"), "start")).toBe("expired");
    expect(reasonFor(new DeviceFlowError("timed out", "timeout"), "start")).toBe("timeout");
    expect(reasonFor(new DeviceFlowError("cancelled", "cancelled"), "start")).toBe("cancelled");
  });

  it("treats a raw fetch abort as a cancel, not a service failure", () => {
    expect(reasonFor(Object.assign(new Error("aborted"), { name: "AbortError" }), "start")).toBe("cancelled");
  });
});

/**
 * Mapping EVERY answered error to `service_error` was the
 * mirror-image of the original defect: an HTTP response proves a server was reached, not that the
 * reached server is the Compaction API, so a 404 from a mistyped `--api-url` was reported as a
 * service-side problem — and the copy for that reason deliberately withholds the URL remedy, which
 * is the one thing that user could have fixed.
 *
 * All THREE non-user-action states are asserted together, because the property under test is a
 * three-way split: a fix that classified 404 correctly while collapsing either of the other two
 * would pass a test that only looked at 404.
 */
describe("reasonFor: a server that is not the endpoint is neither unreachable nor a failing service", () => {
  it("maps 404 on the device-code endpoint to endpoint_not_found", () => {
    expect(reasonFor(new DeviceFlowError("device authorization could not be started", "http_error", 404), "start")).toBe(
      "endpoint_not_found"
    );
  });

  it("maps 405 the same way — a path that refuses the POST is not the device-auth endpoint either", () => {
    expect(reasonFor(new DeviceFlowError("device authorization could not be started", "http_error", 405), "start")).toBe(
      "endpoint_not_found"
    );
  });

  it("leaves a 503 on service_error — the endpoint was there, the service could not serve it", () => {
    expect(reasonFor(new DeviceFlowError("device authorization could not be started", "http_error", 503), "start")).toBe(
      "service_error"
    );
  });

  it("leaves a failure with no response at all on unreachable", () => {
    expect(reasonFor(new TypeError("fetch failed"), "start")).toBe("unreachable");
  });

  it("keeps all three apart at once, so no two can collapse into one message", () => {
    const endpointMiss = reasonFor(new DeviceFlowError("start failed", "http_error", 404), "start");
    const answeredAndFailed = reasonFor(new DeviceFlowError("start failed", "http_error", 503), "start");
    const neverReached = reasonFor(new TypeError("fetch failed"), "start");
    expect(new Set([endpointMiss, answeredAndFailed, neverReached]).size).toBe(3);
  });

  it("does not read 401/403 as an endpoint miss: this route is unauthenticated, so they stay service_error", () => {
    // Deliberate non-goal. `POST /v0/device/code` carries no credentials by design, so an auth
    // challenge on it is not something the user holds a credential to satisfy — and inventing a
    // third remedy for it would be interpreting a status this module does not interpret.
    expect(reasonFor(new DeviceFlowError("start failed", "http_error", 401), "start")).toBe("service_error");
    expect(reasonFor(new DeviceFlowError("start failed", "http_error", 403), "start")).toBe("service_error");
  });

  it("reads an http_error with no status as service_error, not as an endpoint miss", () => {
    // `status` is optional on DeviceFlowError. Absent means "we did not record which" — never
    // grounds for telling the user their URL is the problem.
    expect(reasonFor(new DeviceFlowError("device list failed", "http_error"), "start")).toBe("service_error");
  });
});

/**
 * The endpoint-miss reading (`device-login.ts:138`) was
 * applied to BOTH of the flow's requests, but they do not carry the same evidence about the URL.
 * By the time the flow is polling, that same base URL has already answered `POST /v0/device/code`
 * and returned a user code — so a 404 on the poll (a partial rollout, a proxy routing the two paths
 * differently) is not a URL the user mistyped, and `endpoint_not_found`'s copy sends them to change
 * a URL that demonstrably worked.
 *
 * The property is a CONTRAST, so both phases are asserted for the same status in the same
 * assertions: a fix that silenced the poll case by dropping the endpoint reading altogether would
 * pass a poll-only test while destroying the remedy F67's second reconcile exists to give.
 */
describe("reasonFor: which request failed decides whether the URL is still in question", () => {
  it("keeps the URL remedy on a start-phase 404/405 and withholds it on the same status while polling", () => {
    for (const status of [404, 405]) {
      const onStart = reasonFor(new DeviceFlowError("start failed", "http_error", status), "start");
      const onPoll = reasonFor(new DeviceFlowError("poll failed", "http_error", status), "poll");
      expect(onStart).toBe("endpoint_not_found");
      expect(onPoll).toBe("service_error");
    }
  });

  it("never reports endpoint_not_found for any poll failure, whatever the status", () => {
    // The whole phase, not just the two statuses that used to reach it: once the URL has answered,
    // nothing the poll comes back with makes the URL the thing to change.
    for (const status of [400, 401, 403, 404, 405, 500, 502, 503]) {
      expect(reasonFor(new DeviceFlowError("poll failed", "http_error", status), "poll")).not.toBe(
        "endpoint_not_found"
      );
    }
  });

  it("leaves the phase out of every non-http_error reason, including the unreachable default", () => {
    // Phase splits the ANSWERED case only. A transport failure and a user action mean the same
    // thing whenever they happen, and the `default:` arm (F67) must not acquire a phase dependency.
    for (const phase of ["start", "poll"] as const) {
      expect(reasonFor(new TypeError("fetch failed"), phase)).toBe("unreachable");
      expect(reasonFor(new DeviceFlowError("malformed", "invalid_response"), phase)).toBe("unreachable");
      expect(reasonFor(new DeviceFlowError("denied", "access_denied"), phase)).toBe("denied");
      expect(reasonFor(new DeviceFlowError("expired", "expired"), phase)).toBe("expired");
      expect(reasonFor(new DeviceFlowError("timed out", "timeout"), phase)).toBe("timeout");
      expect(reasonFor(new DeviceFlowError("cancelled", "cancelled"), phase)).toBe("cancelled");
    }
  });
});
