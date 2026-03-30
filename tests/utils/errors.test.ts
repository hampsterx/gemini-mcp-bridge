import { describe, it, expect } from "vitest";
import { isRetryableError } from "../../src/utils/errors.js";

describe("isRetryableError", () => {
  it("returns false for exit code 0", () => {
    expect(isRetryableError(0, "resource_exhausted")).toBe(false);
  });

  it("returns false for empty stderr", () => {
    expect(isRetryableError(1, "")).toBe(false);
  });

  it("detects 'rate limit' in free text", () => {
    expect(isRetryableError(1, "Error: rate limit exceeded")).toBe(true);
  });

  it("detects 'too many requests' in free text", () => {
    expect(isRetryableError(1, "Too Many Requests")).toBe(true);
  });

  it("detects '429' in free text", () => {
    expect(isRetryableError(1, "HTTP 429: slow down")).toBe(true);
  });

  it("detects 'quota' in free text", () => {
    expect(isRetryableError(1, "Quota exceeded for project")).toBe(true);
  });

  it("detects 'resource_exhausted' in free text", () => {
    expect(isRetryableError(1, "RESOURCE_EXHAUSTED: out of quota")).toBe(true);
  });

  it("is case-insensitive for free text", () => {
    expect(isRetryableError(1, "RATE LIMIT hit")).toBe(true);
    expect(isRetryableError(1, "Resource_Exhausted")).toBe(true);
  });

  it("detects RESOURCE_EXHAUSTED in structured JSON error.code", () => {
    const stderr = JSON.stringify({ error: { code: "RESOURCE_EXHAUSTED", message: "quota" } });
    expect(isRetryableError(1, stderr)).toBe(true);
  });

  it("detects QUOTA_EXCEEDED in structured JSON error.status", () => {
    const stderr = JSON.stringify({ error: { status: "QUOTA_EXCEEDED" } });
    expect(isRetryableError(1, stderr)).toBe(true);
  });

  it("detects 429 as numeric code in structured JSON", () => {
    const stderr = JSON.stringify({ error: { code: 429 } });
    expect(isRetryableError(1, stderr)).toBe(true);
  });

  it("detects top-level code field (no error wrapper)", () => {
    const stderr = JSON.stringify({ code: "RESOURCE_EXHAUSTED" });
    expect(isRetryableError(1, stderr)).toBe(true);
  });

  it("returns false for auth errors", () => {
    expect(isRetryableError(1, "Authentication failed: invalid credentials")).toBe(false);
  });

  it("returns false for generic errors", () => {
    expect(isRetryableError(1, "Something went wrong")).toBe(false);
  });

  it("returns false for structured JSON with non-retryable code", () => {
    const stderr = JSON.stringify({ error: { code: "INVALID_ARGUMENT" } });
    expect(isRetryableError(1, stderr)).toBe(false);
  });
});
