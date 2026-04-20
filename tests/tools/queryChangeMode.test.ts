import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/utils/spawn.js", () => ({
  spawnGemini: vi.fn(),
}));

import { executeQuery } from "../../src/tools/query.js";
import { spawnGemini } from "../../src/utils/spawn.js";

const mockSpawn = vi.mocked(spawnGemini);

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function initRepo(): Promise<string> {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), "gmb-cm-query-test-")));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function nostream(response: string) {
  return {
    stdout: JSON.stringify({ type: "result", response }),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
}

describe("executeQuery with changeMode", () => {
  let repo: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    repo = await initRepo();
    await writeFile(path.join(repo, "sample.ts"), "alpha\nbravo\ncharlie\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("spawns without --approval-mode plan and without --yolo", async () => {
    const geminiOutput = [
      `**FILE: ${path.join(repo, "sample.ts")}:2-2**`,
      "OLD:",
      "bravo",
      "NEW:",
      "BRAVO",
    ].join("\n");

    mockSpawn.mockResolvedValue(nostream(geminiOutput));

    const result = await executeQuery({
      prompt: "Uppercase bravo",
      changeMode: true,
      workingDirectory: repo,
    });

    const call = mockSpawn.mock.calls[0][0];
    expect(call.args).not.toContain("--approval-mode");
    expect(call.args).not.toContain("plan");
    expect(call.args).not.toContain("--yolo");

    expect(result.edits).toBeDefined();
    expect(result.edits).toHaveLength(1);
    expect(result.edits![0]).toMatchObject({
      filename: "sample.ts",
      startLine: 2,
      endLine: 2,
      oldCode: "bravo",
      newCode: "BRAVO",
    });
    expect(result.appliedWrites).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  it("emits the change-mode prompt template to stdin", async () => {
    mockSpawn.mockResolvedValue(nostream("no edits here"));

    await executeQuery({
      prompt: "Do the thing",
      changeMode: true,
      workingDirectory: repo,
    });

    const stdin = mockSpawn.mock.calls[0][0].stdin ?? "";
    expect(stdin).toContain("# Task");
    expect(stdin).toContain("Do the thing");
    expect(stdin).toContain("# Output Contract");
    expect(stdin).toContain("**FILE:");
  });

  it("returns appliedWrites=true and omits edits when files changed during spawn", async () => {
    const filePath = path.join(repo, "sample.ts");
    const geminiOutput = [
      `**FILE: ${filePath}:1-1**`,
      "OLD:",
      "alpha",
      "NEW:",
      "ALPHA",
    ].join("\n");

    // Simulate Gemini mutating the file during the spawn: the mock modifies
    // sample.ts as a side effect before resolving, so the post-snapshot
    // differs from the pre-snapshot.
    mockSpawn.mockImplementation(async () => {
      await appendFile(filePath, "surprise mutation\n");
      return nostream(geminiOutput);
    });

    const result = await executeQuery({
      prompt: "Edit something",
      changeMode: true,
      workingDirectory: repo,
    });

    expect(result.appliedWrites).toBe(true);
    expect(result.edits).toBeUndefined();
    expect(result.warning).toMatch(/Gemini wrote files/);
  });

  it("returns a warning when the response cannot be parsed as edits", async () => {
    mockSpawn.mockResolvedValue(
      nostream("I thought about it but did not produce any edit blocks."),
    );

    const result = await executeQuery({
      prompt: "Think about it",
      changeMode: true,
      workingDirectory: repo,
    });

    expect(result.edits).toBeUndefined();
    expect(result.appliedWrites).toBeUndefined();
    expect(result.warning).toMatch(/Could not parse edits/);
    expect(result.response).toMatch(/edit blocks/);
  });

  it("returns a timeout warning when the spawn times out", async () => {
    mockSpawn.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    });

    const result = await executeQuery({
      prompt: "slow",
      changeMode: true,
      workingDirectory: repo,
    });

    expect(result.timedOut).toBe(true);
    expect(result.edits).toBeUndefined();
    expect(result.warning).toBe("Timeout before complete output");
  });

  it("rejects image files with changeMode=true", async () => {
    await writeFile(path.join(repo, "photo.png"), "fake png");

    await expect(
      executeQuery({
        prompt: "look",
        files: ["photo.png"],
        changeMode: true,
        workingDirectory: repo,
      }),
    ).rejects.toThrow(/does not support image files/);
  });

  it("sets appliedWrites=true even when the spawn times out AND files were mutated", async () => {
    const filePath = path.join(repo, "sample.ts");
    mockSpawn.mockImplementation(async () => {
      // Gemini both times out AND mutates a file during the spawn.
      await appendFile(filePath, "mutation under timeout\n");
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: true,
      };
    });

    const result = await executeQuery({
      prompt: "slow and writey",
      changeMode: true,
      workingDirectory: repo,
    });

    // Both signals should fire: caller must know writes happened so they
    // don't treat the workspace as untouched just because the spawn timed out.
    expect(result.timedOut).toBe(true);
    expect(result.appliedWrites).toBe(true);
    expect(result.edits).toBeUndefined();
    expect(result.warning).toMatch(/Gemini wrote files/);
  });

  it("rejects a non-git working directory", async () => {
    const nonRepo = realpathSync(await mkdtemp(path.join(os.tmpdir(), "gmb-cm-nogit-")));
    try {
      await expect(
        executeQuery({
          prompt: "edit",
          changeMode: true,
          workingDirectory: nonRepo,
        }),
      ).rejects.toThrow(/git working directory/);
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });

  it("surfaces text file hints via @{path} in the change-mode prompt", async () => {
    await writeFile(path.join(repo, "notes.txt"), "context notes");
    git(repo, ["add", "notes.txt"]);
    git(repo, ["commit", "-q", "-m", "add notes"]);

    mockSpawn.mockResolvedValue(nostream("no edits"));

    await executeQuery({
      prompt: "summarise",
      files: ["notes.txt"],
      changeMode: true,
      workingDirectory: repo,
    });

    const stdin = mockSpawn.mock.calls[0][0].stdin ?? "";
    expect(stdin).toContain("@{notes.txt}");
    // File content NOT inlined
    expect(stdin).not.toContain("context notes");
  });
});
