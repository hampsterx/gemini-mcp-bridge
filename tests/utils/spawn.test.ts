import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.pid = 12345;
  child.kill = vi.fn();
  return child;
}

async function loadSpawnModule() {
  vi.resetModules();
  return import("../../src/utils/spawn.js");
}

describe("spawnGemini pacing", () => {
  let savedMinGap: string | undefined;
  let savedJitter: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    savedMinGap = process.env["GEMINI_MIN_INVOCATION_GAP_MS"];
    savedJitter = process.env["GEMINI_SPAWN_JITTER_MAX_MS"];

    mockSpawn.mockImplementation(() => {
      const child = makeChild();
      setTimeout(() => child.emit("close", 0), 0);
      return child;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (savedMinGap !== undefined) {
      process.env["GEMINI_MIN_INVOCATION_GAP_MS"] = savedMinGap;
    } else {
      delete process.env["GEMINI_MIN_INVOCATION_GAP_MS"];
    }
    if (savedJitter !== undefined) {
      process.env["GEMINI_SPAWN_JITTER_MAX_MS"] = savedJitter;
    } else {
      delete process.env["GEMINI_SPAWN_JITTER_MAX_MS"];
    }
  });

  it("waits for the minimum gap after a completed invocation", async () => {
    process.env["GEMINI_MIN_INVOCATION_GAP_MS"] = "20";
    process.env["GEMINI_SPAWN_JITTER_MAX_MS"] = "0";
    const { spawnGemini, resetConcurrency } = await loadSpawnModule();
    resetConcurrency();

    const first = spawnGemini({ args: ["--version"], cwd: "/tmp" });
    await vi.runAllTimersAsync();
    await first;
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const second = spawnGemini({ args: ["--version"], cwd: "/tmp" });
    await vi.advanceTimersByTimeAsync(5);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    await second;
  });

  it("adds deterministic jitter before spawning", async () => {
    process.env["GEMINI_MIN_INVOCATION_GAP_MS"] = "0";
    process.env["GEMINI_SPAWN_JITTER_MAX_MS"] = "20";
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const { spawnGemini, resetConcurrency } = await loadSpawnModule();
    resetConcurrency();

    const run = spawnGemini({ args: ["--version"], cwd: "/tmp" });
    await vi.advanceTimersByTimeAsync(5);
    expect(mockSpawn).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(10);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    await run;
  });
});
