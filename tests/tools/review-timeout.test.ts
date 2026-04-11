import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

// Mock spawnGemini before importing the module under test
vi.mock("../../src/utils/spawn.js", () => ({
  spawnGemini: vi.fn(),
}));

import { executeReview, AGENTIC_TIMEOUT, QUICK_TIMEOUT } from "../../src/tools/review.js";
import { spawnGemini } from "../../src/utils/spawn.js";
import { HARD_TIMEOUT_CAP } from "../../src/utils/retry.js";

const mockSpawn = vi.mocked(spawnGemini);

/**
 * Build a real stream-json stdout payload matching what the Gemini CLI
 * emits: NDJSON with `message` lines for assistant chunks and an optional
 * `result` line at the end with the assembled response.
 */
function jsonResponse(text: string) {
  const lines = [
    JSON.stringify({ type: "init" }),
    JSON.stringify({ type: "message", role: "assistant", content: text }),
    JSON.stringify({ type: "result", response: text, stats: {} }),
  ];
  return {
    stdout: lines.join("\n") + "\n",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
}

/**
 * Simulate a timeout mid-stream: init + partial assistant message, no
 * result line. tryParsePartial() should assemble the partial chunk(s).
 */
function timedOutResponse(partialText: string) {
  const lines = [
    JSON.stringify({ type: "init" }),
    JSON.stringify({ type: "message", role: "assistant", content: partialText }),
  ];
  return {
    stdout: lines.join("\n") + "\n",
    stderr: "",
    exitCode: null,
    timedOut: true,
  };
}

/** Initialise a throwaway git repo with one committed file. */
async function initRepo(tmpDir: string): Promise<void> {
  const git = (...args: string[]) => execFileSync("git", ["-C", tmpDir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  await writeFile(path.join(tmpDir, "README.md"), "initial\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
}

/** Stage N uncommitted file changes in the repo. */
async function stageFiles(tmpDir: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await writeFile(path.join(tmpDir, `file${i}.txt`), `content ${i}\n`);
  }
  execFileSync("git", ["-C", tmpDir, "add", "-A"], { stdio: "pipe" });
}

describe("executeReview timeout wiring", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSpawn.mockResolvedValue(jsonResponse("looks good"));
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-review-test-"));
    await initRepo(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("scales agentic timeout from diff size (3 files → 270s)", async () => {
    await stageFiles(tmpDir, 3);

    const result = await executeReview({ workingDirectory: tmpDir });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const call = mockSpawn.mock.calls[0][0];
    // 180_000 + 30_000 * 3 = 270_000
    expect(call.timeout).toBe(270_000);
    expect(result.timeoutScaled).toBe(true);
    expect(result.appliedTimeout).toBe(270_000);
    expect(result.diffStat?.files).toBe(3);
  });

  it("scales agentic timeout from diff size (12 files → 540s)", async () => {
    await stageFiles(tmpDir, 12);

    const result = await executeReview({ workingDirectory: tmpDir });

    // 180_000 + 30_000 * 12 = 540_000
    expect(mockSpawn.mock.calls[0][0].timeout).toBe(540_000);
    expect(result.appliedTimeout).toBe(540_000);
    expect(result.diffStat?.files).toBe(12);
  });

  it("caller-supplied timeout wins over auto-scaling", async () => {
    // 40 files → 180_000 + 30_000 * 40 = 1_380_000 (auto-scaled)
    await stageFiles(tmpDir, 40);

    const result = await executeReview({
      workingDirectory: tmpDir,
      timeout: 60_000,
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(60_000);
    expect(result.timeoutScaled).toBe(false);
    expect(result.appliedTimeout).toBe(60_000);
  });

  it("caller-supplied timeout is capped at HARD_TIMEOUT_CAP", async () => {
    await stageFiles(tmpDir, 1);

    const result = await executeReview({
      workingDirectory: tmpDir,
      timeout: HARD_TIMEOUT_CAP * 10,
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(HARD_TIMEOUT_CAP);
    expect(result.appliedTimeout).toBe(HARD_TIMEOUT_CAP);
  });

  it("quick mode ignores auto-scaling and uses QUICK_TIMEOUT", async () => {
    await stageFiles(tmpDir, 40);

    const result = await executeReview({
      workingDirectory: tmpDir,
      quick: true,
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(QUICK_TIMEOUT);
    expect(result.timeoutScaled).toBe(false);
    expect(result.mode).toBe("quick");
    expect(result.appliedTimeout).toBe(QUICK_TIMEOUT);
  });

  it("quick mode honours caller-supplied timeout", async () => {
    await stageFiles(tmpDir, 2);

    await executeReview({
      workingDirectory: tmpDir,
      quick: true,
      timeout: 45_000,
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(45_000);
  });

  it("returns diff stats in the result for the caller to inspect", async () => {
    await stageFiles(tmpDir, 7);

    const result = await executeReview({ workingDirectory: tmpDir });

    expect(result.diffStat).toBeDefined();
    expect(result.diffStat?.files).toBe(7);
    expect(result.diffStat?.insertions).toBeGreaterThan(0);
  });

  // Sanity check that the raised default is what we expect (guards against
  // future regressions of #2).
  it("AGENTIC_TIMEOUT fallback is 600s (10 min)", () => {
    expect(AGENTIC_TIMEOUT).toBe(600_000);
  });

  it("QUICK_TIMEOUT is 180s (3 min)", () => {
    expect(QUICK_TIMEOUT).toBe(180_000);
  });

  it("HARD_TIMEOUT_CAP is 1800s (30 min)", () => {
    expect(HARD_TIMEOUT_CAP).toBe(1_800_000);
  });

  it("annotates partial response with diff size on timeout", async () => {
    await stageFiles(tmpDir, 7);
    mockSpawn.mockResolvedValue(timedOutResponse("Reviewed 4 of 7 files before running out of time."));

    const result = await executeReview({ workingDirectory: tmpDir });

    expect(result.timedOut).toBe(true);
    // Standard prefix replaced with the fatter, stat-aware version
    expect(result.response).not.toMatch(/^\[Partial response, timed out after \d+s\]/);
    expect(result.response).toContain("7-file diff");
    expect(result.response).toContain("consider quick: true or narrow the base");
    // Original partial content still present
    expect(result.response).toContain("Reviewed 4 of 7 files");
  });
});
