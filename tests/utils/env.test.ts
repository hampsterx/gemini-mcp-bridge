import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSubprocessEnv } from "../../src/utils/env.js";

describe("buildSubprocessEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Start with clean env for predictable tests
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("always includes hardcoded env vars", () => {
    const env = buildSubprocessEnv();
    expect(env.NO_COLOR).toBe("1");
    expect(env.FORCE_COLOR).toBe("0");
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=8192");
  });

  it("passes through allowed keys", () => {
    process.env.HOME = "/home/test";
    process.env.PATH = "/usr/bin";
    process.env.USER = "test";
    const env = buildSubprocessEnv();
    expect(env.HOME).toBe("/home/test");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.USER).toBe("test");
  });

  it("passes through GOOGLE_ prefixed vars", () => {
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    const env = buildSubprocessEnv();
    expect(env.GOOGLE_API_KEY).toBe("test-key");
    expect(env.GOOGLE_CLOUD_PROJECT).toBe("my-project");
  });

  it("passes through GEMINI_ prefixed vars", () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    const env = buildSubprocessEnv();
    expect(env.GEMINI_API_KEY).toBe("gemini-key");
  });

  it("blocks non-allowed vars", () => {
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    process.env.ANTHROPIC_API_KEY = "another-secret";
    process.env.DATABASE_URL = "postgres://localhost";
    process.env.SSH_AUTH_SOCK = "/tmp/ssh";
    const env = buildSubprocessEnv();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it("skips empty values", () => {
    process.env.HOME = "";
    const env = buildSubprocessEnv();
    expect(env.HOME).toBeUndefined();
  });
});
