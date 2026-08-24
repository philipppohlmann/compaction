/**
 * The website origin the CLI hands the user's browser to.
 *
 * The defect this guards: `compaction upgrade` shipped a hardcoded `https://compaction.dev/pricing`
 * while that host had no DNS record, so the one conversion surface opened a browser error. These
 * tests pin that the origin is resolved (not hardcoded per-surface), that it is overridable, and
 * that the normalization is forgiving enough that a stray trailing slash or an exported-but-empty
 * shell variable cannot produce a broken URL.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_ORIGIN, WEB_ORIGIN_ENV, webOrigin, webUrl } from "../../src/core/web-origin.js";

describe("webOrigin", () => {
  it("defaults to an origin with no trailing slash and a real scheme", () => {
    expect(webOrigin({})).toBe(DEFAULT_WEB_ORIGIN);
    expect(DEFAULT_WEB_ORIGIN).toMatch(/^https:\/\/[^/]+$/);
  });

  it("lets the env override win", () => {
    expect(webOrigin({ [WEB_ORIGIN_ENV]: "https://staging.example" })).toBe("https://staging.example");
  });

  it("strips a trailing slash so callers can always join a leading-slash path", () => {
    expect(webOrigin({ [WEB_ORIGIN_ENV]: "https://staging.example/" })).toBe("https://staging.example");
  });

  it("treats blank and whitespace-only as UNSET rather than as an empty origin", () => {
    expect(webOrigin({ [WEB_ORIGIN_ENV]: "" })).toBe(DEFAULT_WEB_ORIGIN);
    expect(webOrigin({ [WEB_ORIGIN_ENV]: "   " })).toBe(DEFAULT_WEB_ORIGIN);
    expect(webOrigin({ [WEB_ORIGIN_ENV]: undefined })).toBe(DEFAULT_WEB_ORIGIN);
  });

  it("is pure — the same env yields the same origin and the env is not mutated", () => {
    const env = { [WEB_ORIGIN_ENV]: "https://staging.example" };
    expect(webOrigin(env)).toBe(webOrigin(env));
    expect(env).toEqual({ [WEB_ORIGIN_ENV]: "https://staging.example" });
  });
});

describe("webUrl", () => {
  it("joins the resolved origin with a site-relative route", () => {
    expect(webUrl("/pricing", {})).toBe(`${DEFAULT_WEB_ORIGIN}/pricing`);
    expect(webUrl("/pricing", { [WEB_ORIGIN_ENV]: "https://staging.example/" })).toBe(
      "https://staging.example/pricing"
    );
  });

  it("never produces a doubled or missing slash, whatever the caller passes", () => {
    expect(webUrl("pricing", {})).toBe(`${DEFAULT_WEB_ORIGIN}/pricing`);
    expect(webUrl("  /pricing  ", {})).toBe(`${DEFAULT_WEB_ORIGIN}/pricing`);
    expect(webUrl("/", {})).toBe(DEFAULT_WEB_ORIGIN);
    expect(webUrl("", {})).toBe(DEFAULT_WEB_ORIGIN);
  });
});
