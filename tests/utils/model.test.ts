import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveModel, getDefaultModel } from "../../src/utils/model.js";

describe("resolveModel", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["GEMINI_DEFAULT_MODEL"];
    delete process.env["GEMINI_DEFAULT_MODEL"];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["GEMINI_DEFAULT_MODEL"] = originalEnv;
    } else {
      delete process.env["GEMINI_DEFAULT_MODEL"];
    }
  });

  it("returns explicit model when provided", () => {
    process.env["GEMINI_DEFAULT_MODEL"] = "gemini-2.5-flash";
    expect(resolveModel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  it("trims explicit model value", () => {
    process.env["GEMINI_DEFAULT_MODEL"] = "gemini-2.5-flash";
    expect(resolveModel("  gemini-2.5-pro  ")).toBe("gemini-2.5-pro");
  });

  it("treats whitespace-only explicit model as unset and falls back to env", () => {
    process.env["GEMINI_DEFAULT_MODEL"] = "gemini-2.5-flash";
    expect(resolveModel("   ")).toBe("gemini-2.5-flash");
  });

  it("falls back to env var when no explicit model", () => {
    process.env["GEMINI_DEFAULT_MODEL"] = "gemini-2.5-flash";
    expect(resolveModel()).toBe("gemini-2.5-flash");
    expect(resolveModel(undefined)).toBe("gemini-2.5-flash");
  });

  it("returns undefined when neither explicit nor env var set", () => {
    expect(resolveModel()).toBeUndefined();
  });

  it("treats empty string env var as unset", () => {
    process.env["GEMINI_DEFAULT_MODEL"] = "";
    expect(resolveModel()).toBeUndefined();
  });

  it("treats whitespace-only env var as unset", () => {
    process.env["GEMINI_DEFAULT_MODEL"] = "   ";
    expect(resolveModel()).toBeUndefined();
  });

  it("trims whitespace from env var value", () => {
    process.env["GEMINI_DEFAULT_MODEL"] = "  gemini-2.5-flash  ";
    expect(resolveModel()).toBe("gemini-2.5-flash");
  });
});

describe("getDefaultModel", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["GEMINI_DEFAULT_MODEL"];
    delete process.env["GEMINI_DEFAULT_MODEL"];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["GEMINI_DEFAULT_MODEL"] = originalEnv;
    } else {
      delete process.env["GEMINI_DEFAULT_MODEL"];
    }
  });

  it("returns configured model", () => {
    process.env["GEMINI_DEFAULT_MODEL"] = "gemini-2.5-pro";
    expect(getDefaultModel()).toBe("gemini-2.5-pro");
  });

  it("returns undefined when not set", () => {
    expect(getDefaultModel()).toBeUndefined();
  });

  it("returns undefined for empty/whitespace", () => {
    process.env["GEMINI_DEFAULT_MODEL"] = "  ";
    expect(getDefaultModel()).toBeUndefined();
  });
});
