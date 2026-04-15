import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

// Mock spawnGemini before importing the module under test
vi.mock("../../src/utils/spawn.js", () => ({
  spawnGemini: vi.fn(),
}));

// Mock getDiffStat so we can test the stat-unavailable fallback path without
// needing a non-git workdir. The rest of git.ts stays real.
vi.mock("../../src/utils/git.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/git.js")>(
    "../../src/utils/git.js",
  );
  return {
    ...actual,
    getDiffStat: vi.fn(actual.getDiffStat),
  };
});

import {
  executeReview,
  AGENTIC_TIMEOUT,
  SCAN_TIMEOUT,
  QUICK_TIMEOUT,
  FOCUSED_FALLBACK_TIMEOUT,
} from "../../src/tools/review.js";
import { spawnGemini } from "../../src/utils/spawn.js";
import { getDiffStat } from "../../src/utils/git.js";
import { HARD_TIMEOUT_CAP } from "../../src/utils/retry.js";

const mockSpawn = vi.mocked(spawnGemini);
const mockDiffStat = vi.mocked(getDiffStat);

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
    // Default getDiffStat to the real implementation. Tests that need failure
    // override via mockDiffStat.mockImplementationOnce.
    mockDiffStat.mockImplementation(
      (await vi.importActual<typeof import("../../src/utils/git.js")>(
        "../../src/utils/git.js",
      )).getDiffStat,
    );
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-review-test-"));
    await initRepo(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- default (deep) timeout scaling ---

  it("scales deep timeout from diff size (3 files → 375s)", async () => {
    await stageFiles(tmpDir, 3);

    const result = await executeReview({ workingDirectory: tmpDir });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const call = mockSpawn.mock.calls[0][0];
    // 240_000 + 45_000 * 3 = 375_000
    expect(call.timeout).toBe(375_000);
    expect(result.timeoutScaled).toBe(true);
    expect(result.appliedTimeout).toBe(375_000);
    expect(result.diffStat?.files).toBe(3);
    expect(result.mode).toBe("deep");
  });

  it("scales deep timeout from diff size (12 files → 780s)", async () => {
    await stageFiles(tmpDir, 12);

    const result = await executeReview({ workingDirectory: tmpDir });

    // 240_000 + 45_000 * 12 = 780_000
    expect(mockSpawn.mock.calls[0][0].timeout).toBe(780_000);
    expect(result.appliedTimeout).toBe(780_000);
    expect(result.diffStat?.files).toBe(12);
  });

  it("caller-supplied timeout wins over auto-scaling", async () => {
    // 40 files on deep → 240_000 + 45_000 * 40 would cap
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

  // --- scan depth ---

  it("depth: scan uses SCAN_TIMEOUT regardless of diff size", async () => {
    await stageFiles(tmpDir, 40);

    const result = await executeReview({
      workingDirectory: tmpDir,
      depth: "scan",
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(SCAN_TIMEOUT);
    expect(result.timeoutScaled).toBe(false);
    expect(result.mode).toBe("scan");
    expect(result.appliedTimeout).toBe(SCAN_TIMEOUT);
  });

  it("depth: scan spawns without --yolo", async () => {
    await stageFiles(tmpDir, 2);

    await executeReview({ workingDirectory: tmpDir, depth: "scan" });

    const args = mockSpawn.mock.calls[0][0].args;
    expect(args).not.toContain("--yolo");
  });

  // --- focused depth ---

  it("depth: focused scales from diff size (5 files → 195s)", async () => {
    await stageFiles(tmpDir, 5);

    const result = await executeReview({
      workingDirectory: tmpDir,
      depth: "focused",
    });

    // 120_000 + 15_000 * 5 = 195_000
    expect(mockSpawn.mock.calls[0][0].timeout).toBe(195_000);
    expect(result.timeoutScaled).toBe(true);
    expect(result.mode).toBe("focused");
    expect(result.appliedTimeout).toBe(195_000);
  });

  it("depth: focused caps at 300s (20 files)", async () => {
    await stageFiles(tmpDir, 20);

    const result = await executeReview({
      workingDirectory: tmpDir,
      depth: "focused",
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(300_000);
    expect(result.appliedTimeout).toBe(300_000);
  });

  it("depth: focused spawns without --yolo (plan mode)", async () => {
    await stageFiles(tmpDir, 2);

    await executeReview({ workingDirectory: tmpDir, depth: "focused" });

    const args = mockSpawn.mock.calls[0][0].args;
    expect(args).not.toContain("--yolo");
  });

  it("depth: focused inlines the diff in the prompt", async () => {
    await writeFile(path.join(tmpDir, "focus-me.ts"), "export const X = 1;\n");
    execFileSync("git", ["-C", tmpDir, "add", "-A"], { stdio: "pipe" });

    await executeReview({ workingDirectory: tmpDir, depth: "focused" });

    const stdin = mockSpawn.mock.calls[0][0].stdin;
    expect(stdin).toContain("focus-me.ts");
    expect(stdin).toContain("Do NOT explore beyond the changed files");
  });

  it("depth: focused propagates focus and maxResponseLength", async () => {
    await stageFiles(tmpDir, 1);

    await executeReview({
      workingDirectory: tmpDir,
      depth: "focused",
      focus: "security",
      maxResponseLength: 400,
    });

    const stdin = mockSpawn.mock.calls[0][0].stdin;
    expect(stdin).toContain("Pay special attention to: security");
    expect(stdin).toContain("Keep your response under 400 words");
  });

  it("depth: focused returns empty-diff message without spawning on no changes", async () => {
    // No files staged
    const result = await executeReview({
      workingDirectory: tmpDir,
      depth: "focused",
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(result.response).toContain("No uncommitted changes");
    expect(result.mode).toBe("focused");
    expect(result.timedOut).toBe(false);
  });

  // --- deep depth ---

  it("depth: deep spawns with --yolo", async () => {
    await stageFiles(tmpDir, 2);

    await executeReview({ workingDirectory: tmpDir, depth: "deep" });

    const args = mockSpawn.mock.calls[0][0].args;
    expect(args).toContain("--yolo");
  });

  // --- stat-unavailable fallback ---

  it("depth: focused falls back to 240s when diff stat is unavailable", async () => {
    await stageFiles(tmpDir, 3);
    mockDiffStat.mockImplementationOnce(() => {
      throw new Error("stat unavailable");
    });

    const result = await executeReview({
      workingDirectory: tmpDir,
      depth: "focused",
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(FOCUSED_FALLBACK_TIMEOUT);
    expect(result.appliedTimeout).toBe(FOCUSED_FALLBACK_TIMEOUT);
    expect(result.timeoutScaled).toBe(false);
    expect(result.diffStat).toBeUndefined();
  });

  it("depth: deep falls back to AGENTIC_TIMEOUT (600s) when stat is unavailable", async () => {
    await stageFiles(tmpDir, 3);
    mockDiffStat.mockImplementationOnce(() => {
      throw new Error("stat unavailable");
    });

    const result = await executeReview({
      workingDirectory: tmpDir,
      depth: "deep",
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(AGENTIC_TIMEOUT);
    expect(result.appliedTimeout).toBe(AGENTIC_TIMEOUT);
  });

  // --- legacy quick parameter (back-compat) ---

  it("quick: true maps to depth: scan (back-compat)", async () => {
    await stageFiles(tmpDir, 40);

    const result = await executeReview({
      workingDirectory: tmpDir,
      quick: true,
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(SCAN_TIMEOUT);
    expect(result.mode).toBe("scan");
  });

  it("quick: false maps to depth: deep (preserves current default)", async () => {
    await stageFiles(tmpDir, 3);

    const result = await executeReview({
      workingDirectory: tmpDir,
      quick: false,
    });

    // 240_000 + 45_000 * 3 = 375_000 (deep formula)
    expect(mockSpawn.mock.calls[0][0].timeout).toBe(375_000);
    expect(result.mode).toBe("deep");
  });

  it("depth wins when both depth and quick are set", async () => {
    await stageFiles(tmpDir, 3);

    const result = await executeReview({
      workingDirectory: tmpDir,
      depth: "focused",
      quick: true,
    });

    expect(result.mode).toBe("focused");
    // focused formula, not scan
    expect(result.appliedTimeout).toBe(120_000 + 15_000 * 3);
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

  it("QUICK_TIMEOUT is exported for back-compat and equals SCAN_TIMEOUT", () => {
    expect(QUICK_TIMEOUT).toBe(SCAN_TIMEOUT);
    expect(QUICK_TIMEOUT).toBe(180_000);
  });

  // --- result shape ---

  it("returns diff stats in the result for the caller to inspect", async () => {
    await stageFiles(tmpDir, 7);

    const result = await executeReview({ workingDirectory: tmpDir });

    expect(result.diffStat).toBeDefined();
    expect(result.diffStat?.files).toBe(7);
    expect(result.diffStat?.insertions).toBeGreaterThan(0);
  });

  it("AGENTIC_TIMEOUT fallback is 600s (10 min)", () => {
    expect(AGENTIC_TIMEOUT).toBe(600_000);
  });

  it("SCAN_TIMEOUT is 180s (3 min)", () => {
    expect(SCAN_TIMEOUT).toBe(180_000);
  });

  it("HARD_TIMEOUT_CAP is 1800s (30 min)", () => {
    expect(HARD_TIMEOUT_CAP).toBe(1_800_000);
  });

  // --- partial response annotation ---

  it("annotates partial deep response with diff size + new depth hint on timeout", async () => {
    await stageFiles(tmpDir, 7);
    mockSpawn.mockResolvedValue(timedOutResponse("Reviewed 4 of 7 files before running out of time."));

    const result = await executeReview({ workingDirectory: tmpDir });

    expect(result.timedOut).toBe(true);
    expect(result.response).not.toMatch(/^\[Partial response, timed out after \d+s\]/);
    expect(result.response).toContain("7-file diff");
    expect(result.response).toContain('consider depth: "scan" or narrow the base');
    // Original partial content still present
    expect(result.response).toContain("Reviewed 4 of 7 files");
  });

  it("annotates partial focused response on timeout (shallower alternative exists)", async () => {
    await stageFiles(tmpDir, 5);
    mockSpawn.mockResolvedValue(timedOutResponse("Partial focused review."));

    const result = await executeReview({
      workingDirectory: tmpDir,
      depth: "focused",
    });

    expect(result.timedOut).toBe(true);
    expect(result.response).toContain("5-file diff");
    expect(result.response).toContain('consider depth: "scan"');
  });

  it("does NOT annotate partial scan response (no shallower alternative)", async () => {
    await stageFiles(tmpDir, 5);
    mockSpawn.mockResolvedValue(timedOutResponse("Partial scan review."));

    const result = await executeReview({
      workingDirectory: tmpDir,
      depth: "scan",
    });

    expect(result.timedOut).toBe(true);
    expect(result.response).not.toContain('consider depth: "scan"');
    expect(result.response).toContain("Partial scan review.");
  });

  // --- parity: quick: true vs depth: "scan" ---

  it("quick: true and depth: scan produce identical spawn args and prompt for the same diff", async () => {
    await stageFiles(tmpDir, 2);

    await executeReview({ workingDirectory: tmpDir, quick: true });
    const quickCall = mockSpawn.mock.calls[0][0];

    mockSpawn.mockClear();
    await executeReview({ workingDirectory: tmpDir, depth: "scan" });
    const scanCall = mockSpawn.mock.calls[0][0];

    expect(scanCall.args).toEqual(quickCall.args);
    expect(scanCall.stdin).toBe(quickCall.stdin);
    expect(scanCall.timeout).toBe(quickCall.timeout);
  });

  // --- unreadable files in diff (deleted / binary-marker) ---

  it("depth: focused handles a diff containing a deleted file without crashing", async () => {
    // Commit a file, then delete it — the diff will contain a "deleted file mode" header
    await writeFile(path.join(tmpDir, "to-delete.txt"), "will be deleted\n");
    execFileSync("git", ["-C", tmpDir, "add", "-A"], { stdio: "pipe" });
    execFileSync("git", ["-C", tmpDir, "commit", "-q", "-m", "add file"], { stdio: "pipe" });
    execFileSync("git", ["-C", tmpDir, "rm", "-q", "to-delete.txt"], { stdio: "pipe" });

    const result = await executeReview({
      workingDirectory: tmpDir,
      depth: "focused",
    });

    expect(result.timedOut).toBe(false);
    expect(result.mode).toBe("focused");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // Diff text should mention the deleted file so the prompt carries the signal
    expect(mockSpawn.mock.calls[0][0].stdin).toContain("to-delete.txt");
  });

  // --- model fallback on focused path ---

  it("depth: focused retries with fallback model on quota exhaustion", async () => {
    await stageFiles(tmpDir, 2);
    const savedFallback = process.env["GEMINI_FALLBACK_MODEL"];
    process.env["GEMINI_FALLBACK_MODEL"] = "gemini-2.5-flash";

    try {
      mockSpawn.mockReset();
      mockSpawn
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "RESOURCE_EXHAUSTED: quota exceeded",
          exitCode: 1,
          timedOut: false,
        })
        .mockResolvedValueOnce(jsonResponse("fallback review"));

      const result = await executeReview({
        workingDirectory: tmpDir,
        depth: "focused",
        model: "gemini-2.5-pro",
      });

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(result.fallbackUsed).toBe(true);
      expect(result.model).toBe("gemini-2.5-flash");
      expect(result.response).toContain("fallback review");
      expect(result.mode).toBe("focused");
    } finally {
      if (savedFallback !== undefined) {
        process.env["GEMINI_FALLBACK_MODEL"] = savedFallback;
      } else {
        delete process.env["GEMINI_FALLBACK_MODEL"];
      }
    }
  });

  it("depth: deep returns structured capacity metadata without fallback retry", async () => {
    await stageFiles(tmpDir, 2);
    const savedFallback = process.env["GEMINI_FALLBACK_MODEL"];
    process.env["GEMINI_FALLBACK_MODEL"] = "gemini-2.5-flash";

    try {
      mockSpawn.mockReset();
      mockSpawn.mockResolvedValue({
        stdout: "",
        stderr: "503 Service Unavailable",
        exitCode: 1,
        timedOut: false,
      });

      const result = await executeReview({
        workingDirectory: tmpDir,
        depth: "deep",
        model: "gemini-2.5-pro",
      });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(result.fallbackUsed).toBeUndefined();
      expect(result.capacityFailure).toEqual({
        kind: "service_unavailable",
        statusCode: 503,
        message: "503 Service Unavailable",
      });
      expect(result.response).toContain("could not be completed");
      expect(result.response).toContain("No internal retry or fallback was attempted");
      expect(result.mode).toBe("deep");
    } finally {
      if (savedFallback !== undefined) {
        process.env["GEMINI_FALLBACK_MODEL"] = savedFallback;
      } else {
        delete process.env["GEMINI_FALLBACK_MODEL"];
      }
    }
  });
});
