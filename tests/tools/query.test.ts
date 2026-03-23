import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Mock spawnGemini before importing the module under test
vi.mock("../../src/utils/spawn.js", () => ({
  spawnGemini: vi.fn(),
}));

import { executeQuery } from "../../src/tools/query.js";
import { spawnGemini } from "../../src/utils/spawn.js";

const mockSpawn = vi.mocked(spawnGemini);

function jsonResponse(text: string) {
  return {
    stdout: "",
    stderr: JSON.stringify({ response: text }),
    exitCode: 0,
    timedOut: false,
  };
}

describe("executeQuery", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-query-test-"));
  });

  it("text-only query: non-agentic, no --yolo", async () => {
    mockSpawn.mockResolvedValue(jsonResponse("Hello!"));

    const result = await executeQuery({
      prompt: "Say hello",
      workingDirectory: tmpDir,
    });

    expect(result.response).toBe("Hello!");
    expect(result.imagesIncluded).toEqual([]);
    expect(result.timedOut).toBe(false);

    // Should NOT have --yolo
    const args = mockSpawn.mock.calls[0][0].args;
    expect(args).not.toContain("--yolo");
  });

  it("text files: inlined in prompt, non-agentic", async () => {
    await writeFile(path.join(tmpDir, "notes.txt"), "some notes");
    mockSpawn.mockResolvedValue(jsonResponse("Got it"));

    const result = await executeQuery({
      prompt: "Read this",
      files: ["notes.txt"],
      workingDirectory: tmpDir,
    });

    expect(result.filesIncluded).toEqual(["notes.txt"]);
    expect(result.imagesIncluded).toEqual([]);

    const args = mockSpawn.mock.calls[0][0].args;
    expect(args).not.toContain("--yolo");

    // Text content should be in stdin
    const stdin = mockSpawn.mock.calls[0][0].stdin;
    expect(stdin).toContain("some notes");
  });

  it("image files: switches to agentic mode with --yolo", async () => {
    await writeFile(path.join(tmpDir, "photo.png"), "fake png data");
    mockSpawn.mockResolvedValue(jsonResponse("I see a photo"));

    const result = await executeQuery({
      prompt: "Describe this",
      files: ["photo.png"],
      workingDirectory: tmpDir,
    });

    expect(result.imagesIncluded).toHaveLength(1);
    expect(result.imagesIncluded[0]).toContain("photo.png");
    expect(result.filesIncluded).toEqual([]);

    const call = mockSpawn.mock.calls[0][0];
    expect(call.args).toContain("--yolo");
    expect(call.stdin).toContain("Read and analyze the image at:");
  });

  it("mixed files: text inlined, images referenced by path", async () => {
    await writeFile(path.join(tmpDir, "notes.txt"), "context notes");
    await writeFile(path.join(tmpDir, "diagram.jpg"), "fake jpg");
    mockSpawn.mockResolvedValue(jsonResponse("Analyzed both"));

    const result = await executeQuery({
      prompt: "Compare",
      files: ["notes.txt", "diagram.jpg"],
      workingDirectory: tmpDir,
    });

    expect(result.filesIncluded).toEqual(["notes.txt"]);
    expect(result.imagesIncluded).toHaveLength(1);
    expect(result.imagesIncluded[0]).toContain("diagram.jpg");

    const call = mockSpawn.mock.calls[0][0];
    expect(call.args).toContain("--yolo");
    expect(call.stdin).toContain("context notes");
    expect(call.stdin).toContain("Read and analyze the image at:");
  });

  it("image query uses 120s default timeout", async () => {
    await writeFile(path.join(tmpDir, "img.png"), "data");
    mockSpawn.mockResolvedValue(jsonResponse("ok"));

    await executeQuery({
      prompt: "Analyze",
      files: ["img.png"],
      workingDirectory: tmpDir,
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(120_000);
  });

  it("skips oversized image files (>5MB)", async () => {
    const bigImage = Buffer.alloc(5_100_000, 0);
    await writeFile(path.join(tmpDir, "huge.png"), bigImage);
    mockSpawn.mockResolvedValue(jsonResponse("no images to read"));

    const result = await executeQuery({
      prompt: "Analyze",
      files: ["huge.png"],
      workingDirectory: tmpDir,
    });

    expect(result.imagesIncluded).toEqual([]);
    expect(result.filesSkipped).toHaveLength(1);
    expect(result.filesSkipped[0]).toContain("exceeds");
  });

  it("timeout result includes imagesIncluded", async () => {
    await writeFile(path.join(tmpDir, "photo.png"), "data");
    mockSpawn.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    });

    const result = await executeQuery({
      prompt: "Describe",
      files: ["photo.png"],
      workingDirectory: tmpDir,
    });

    expect(result.timedOut).toBe(true);
    expect(result.imagesIncluded).toHaveLength(1);
  });

  it("skips --yolo when all images are oversized", async () => {
    const bigImage = Buffer.alloc(5_100_000, 0);
    await writeFile(path.join(tmpDir, "huge.png"), bigImage);
    mockSpawn.mockResolvedValue(jsonResponse("text only"));

    await executeQuery({
      prompt: "Analyze",
      files: ["huge.png"],
      workingDirectory: tmpDir,
    });

    const args = mockSpawn.mock.calls[0][0].args;
    expect(args).not.toContain("--yolo");
  });

  it("imagesIncluded returns relative paths, not absolute", async () => {
    await writeFile(path.join(tmpDir, "photo.png"), "data");
    mockSpawn.mockResolvedValue(jsonResponse("ok"));

    const result = await executeQuery({
      prompt: "Describe",
      files: ["photo.png"],
      workingDirectory: tmpDir,
    });

    expect(result.imagesIncluded).toEqual(["photo.png"]);
    expect(result.imagesIncluded[0]).not.toContain("/");
  });

  it("rejects more than 20 total files", async () => {
    const files = Array.from({ length: 21 }, (_, i) => `file${i}.txt`);

    await expect(
      executeQuery({ prompt: "test", files, workingDirectory: tmpDir }),
    ).rejects.toThrow("Too many files");
  });

  it("auth error propagates from image query", async () => {
    await writeFile(path.join(tmpDir, "photo.png"), "data");
    mockSpawn.mockResolvedValue({
      stdout: "",
      stderr: "Authentication failed: invalid credentials",
      exitCode: 1,
      timedOut: false,
    });

    await expect(
      executeQuery({
        prompt: "Describe",
        files: ["photo.png"],
        workingDirectory: tmpDir,
      }),
    ).rejects.toThrow("authentication error");
  });
});
