import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/core/content-hash.js";

describe("contentHash", () => {
  it("produces a 64-character hex SHA-256 digest", () => {
    const hash = contentHash("hello world");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic for the same input", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
  });

  it("differs for different inputs", () => {
    expect(contentHash("abc")).not.toBe(contentHash("ABC"));
    expect(contentHash("abc")).not.toBe(contentHash("abc "));
  });

  it("matches sha-256 of an empty string", () => {
    // SHA-256("") is a known constant
    expect(contentHash("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
