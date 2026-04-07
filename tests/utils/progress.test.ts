import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startProgressHeartbeat, maybeStartHeartbeat } from "../../src/utils/progress.js";

describe("startProgressHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits progress notification after interval", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    startProgressHeartbeat("token-1", sendNotification, 15_000);

    // No notification yet
    expect(sendNotification).not.toHaveBeenCalled();

    // Advance to first tick
    vi.advanceTimersByTime(15_000);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: {
        progressToken: "token-1",
        progress: 1,
        message: "Processing... (15s elapsed)",
      },
    });
  });

  it("increments progress on each tick", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    startProgressHeartbeat("t", sendNotification, 10_000);

    vi.advanceTimersByTime(30_000);

    expect(sendNotification).toHaveBeenCalledTimes(3);
    expect(sendNotification.mock.calls[0][0].params.progress).toBe(1);
    expect(sendNotification.mock.calls[1][0].params.progress).toBe(2);
    expect(sendNotification.mock.calls[2][0].params.progress).toBe(3);
  });

  it("stops emitting after stop() is called", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    const heartbeat = startProgressHeartbeat("t", sendNotification, 10_000);

    vi.advanceTimersByTime(10_000);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    heartbeat.stop();

    vi.advanceTimersByTime(30_000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("works with numeric progress tokens", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    startProgressHeartbeat(42, sendNotification, 5_000);

    vi.advanceTimersByTime(5_000);

    expect(sendNotification.mock.calls[0][0].params.progressToken).toBe(42);
  });

  it("silently ignores notification send failures", async () => {
    const sendNotification = vi.fn().mockRejectedValue(new Error("transport closed"));

    const heartbeat = startProgressHeartbeat("t", sendNotification, 5_000);

    // Should not throw
    vi.advanceTimersByTime(5_000);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    // Should continue emitting despite errors
    vi.advanceTimersByTime(5_000);
    expect(sendNotification).toHaveBeenCalledTimes(2);

    heartbeat.stop();
  });

  it("reports elapsed time in message", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    startProgressHeartbeat("t", sendNotification, 15_000);

    vi.advanceTimersByTime(15_000);
    expect(sendNotification.mock.calls[0][0].params.message).toBe("Processing... (15s elapsed)");

    vi.advanceTimersByTime(15_000);
    expect(sendNotification.mock.calls[1][0].params.message).toBe("Processing... (30s elapsed)");
  });
});

describe("maybeStartHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts heartbeat when progressToken is present", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    const heartbeat = maybeStartHeartbeat(
      { progressToken: "abc" },
      sendNotification,
      10_000,
    );

    vi.advanceTimersByTime(10_000);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    heartbeat.stop();
  });

  it("returns no-op when progressToken is undefined", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    const heartbeat = maybeStartHeartbeat(undefined, sendNotification, 10_000);

    vi.advanceTimersByTime(30_000);
    expect(sendNotification).not.toHaveBeenCalled();

    // stop() should not throw
    heartbeat.stop();
  });

  it("returns no-op when meta has no progressToken", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    const heartbeat = maybeStartHeartbeat({}, sendNotification, 10_000);

    vi.advanceTimersByTime(30_000);
    expect(sendNotification).not.toHaveBeenCalled();

    heartbeat.stop();
  });
});
