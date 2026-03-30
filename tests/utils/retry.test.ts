import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnResult } from "../../src/utils/spawn.js";
import { withModelFallback } from "../../src/utils/retry.js";

function makeResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    ...overrides,
  };
}

function quotaError(): SpawnResult {
  return makeResult({
    exitCode: 1,
    stderr: "RESOURCE_EXHAUSTED: quota exceeded",
  });
}

describe("withModelFallback", () => {
  let savedFallback: string | undefined;

  beforeEach(() => {
    savedFallback = process.env["GEMINI_FALLBACK_MODEL"];
    delete process.env["GEMINI_FALLBACK_MODEL"];
  });

  afterEach(() => {
    if (savedFallback !== undefined) {
      process.env["GEMINI_FALLBACK_MODEL"] = savedFallback;
    } else {
      delete process.env["GEMINI_FALLBACK_MODEL"];
    }
  });

  it("returns original result on success", async () => {
    const ok = makeResult({ stdout: "hello" });
    const spawnFn = vi.fn().mockResolvedValue(ok);

    const { result, fallbackUsed } = await withModelFallback("gemini-2.5-pro", spawnFn, 60_000);

    expect(result).toBe(ok);
    expect(fallbackUsed).toBe(false);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on timeout", async () => {
    const timedOut = makeResult({ timedOut: true });
    const spawnFn = vi.fn().mockResolvedValue(timedOut);

    const { result, fallbackUsed } = await withModelFallback("gemini-2.5-pro", spawnFn, 60_000);

    expect(result.timedOut).toBe(true);
    expect(fallbackUsed).toBe(false);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("retries with fallback on quota error", async () => {
    const fallbackOk = makeResult({ stdout: "fallback response" });
    const spawnFn = vi.fn()
      .mockResolvedValueOnce(quotaError())
      .mockResolvedValueOnce(fallbackOk);

    const { result, fallbackUsed, fallbackModel } =
      await withModelFallback("gemini-2.5-pro", spawnFn, 60_000);

    expect(result).toBe(fallbackOk);
    expect(fallbackUsed).toBe(true);
    expect(fallbackModel).toBe("gemini-2.5-flash");
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn.mock.calls[1][0]).toBe("gemini-2.5-flash");
  });

  it("uses custom GEMINI_FALLBACK_MODEL", async () => {
    process.env["GEMINI_FALLBACK_MODEL"] = "gemini-2.0-flash";
    const spawnFn = vi.fn()
      .mockResolvedValueOnce(quotaError())
      .mockResolvedValueOnce(makeResult());

    const { fallbackModel } = await withModelFallback("gemini-2.5-pro", spawnFn, 60_000);

    expect(fallbackModel).toBe("gemini-2.0-flash");
    expect(spawnFn.mock.calls[1][0]).toBe("gemini-2.0-flash");
  });

  it("does not retry when GEMINI_FALLBACK_MODEL=none", async () => {
    process.env["GEMINI_FALLBACK_MODEL"] = "none";
    const spawnFn = vi.fn().mockResolvedValue(quotaError());

    const { fallbackUsed } = await withModelFallback("gemini-2.5-pro", spawnFn, 60_000);

    expect(fallbackUsed).toBe(false);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry when model equals fallback", async () => {
    const spawnFn = vi.fn().mockResolvedValue(quotaError());

    const { fallbackUsed } = await withModelFallback("gemini-2.5-flash", spawnFn, 60_000);

    expect(fallbackUsed).toBe(false);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on non-retryable errors", async () => {
    const authError = makeResult({ exitCode: 1, stderr: "Authentication failed" });
    const spawnFn = vi.fn().mockResolvedValue(authError);

    const { fallbackUsed } = await withModelFallback("gemini-2.5-pro", spawnFn, 60_000);

    expect(fallbackUsed).toBe(false);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("passes reduced timeout to retry", async () => {
    const spawnFn = vi.fn()
      .mockResolvedValueOnce(quotaError())
      .mockResolvedValueOnce(makeResult());

    await withModelFallback("gemini-2.5-pro", spawnFn, 60_000);

    // First call gets the full timeout
    expect(spawnFn.mock.calls[0][1]).toBe(60_000);
    // Second call gets remaining time (less than original, but > 10s min)
    const retryTimeout = spawnFn.mock.calls[1][1] as number;
    expect(retryTimeout).toBeLessThanOrEqual(60_000);
    expect(retryTimeout).toBeGreaterThan(0);
  });

  it("skips retry when remaining time is below 10s floor", async () => {
    // Stub Date.now to simulate the first call consuming almost all the budget
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)      // deadline calculation
      .mockReturnValueOnce(45);    // remaining time check: 50 - 45 = 5ms < 10s floor
    const spawnFn = vi.fn().mockResolvedValue(quotaError());

    try {
      const { fallbackUsed } = await withModelFallback("gemini-2.5-pro", spawnFn, 50);

      expect(fallbackUsed).toBe(false);
      expect(spawnFn).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it("works with undefined model (CLI default)", async () => {
    const spawnFn = vi.fn()
      .mockResolvedValueOnce(quotaError())
      .mockResolvedValueOnce(makeResult({ stdout: "ok" }));

    const { fallbackUsed } = await withModelFallback(undefined, spawnFn, 60_000);

    expect(fallbackUsed).toBe(true);
    expect(spawnFn.mock.calls[0][0]).toBeUndefined();
    expect(spawnFn.mock.calls[1][0]).toBe("gemini-2.5-flash");
  });
});
