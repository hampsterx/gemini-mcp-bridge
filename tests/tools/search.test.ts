import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/utils/spawn.js", () => ({
  spawnGemini: vi.fn(),
}));

import { executeSearch } from "../../src/tools/search.js";
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

describe("executeSearch", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-search-test-"));
  });

  it("spawns CLI with --yolo for google_web_search access", async () => {
    mockSpawn.mockResolvedValue(jsonResponse("Node.js 22 is the current LTS."));

    const result = await executeSearch({
      query: "latest Node.js LTS version",
      workingDirectory: tmpDir,
    });

    expect(result.response).toBe("Node.js 22 is the current LTS.");
    expect(result.timedOut).toBe(false);

    const call = mockSpawn.mock.calls[0][0];
    expect(call.args).toContain("--yolo");
    expect(call.args).toContain("--output-format");
    expect(call.args).toContain("json");
  });

  it("passes query via search prompt template in stdin", async () => {
    mockSpawn.mockResolvedValue(jsonResponse("answer"));

    await executeSearch({
      query: "what is the capital of France",
      workingDirectory: tmpDir,
    });

    const stdin = mockSpawn.mock.calls[0][0].stdin!;
    expect(stdin).toContain("what is the capital of France");
    expect(stdin).toContain("google_web_search");
  });

  it("uses 120s default timeout", async () => {
    mockSpawn.mockResolvedValue(jsonResponse("ok"));

    await executeSearch({
      query: "test",
      workingDirectory: tmpDir,
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(120_000);
  });

  it("respects custom timeout", async () => {
    mockSpawn.mockResolvedValue(jsonResponse("ok"));

    await executeSearch({
      query: "test",
      timeout: 30_000,
      workingDirectory: tmpDir,
    });

    expect(mockSpawn.mock.calls[0][0].timeout).toBe(30_000);
  });

  it("passes model when specified", async () => {
    mockSpawn.mockResolvedValue(jsonResponse("ok"));

    await executeSearch({
      query: "test",
      model: "gemini-2.5-flash",
      workingDirectory: tmpDir,
    });

    const args = mockSpawn.mock.calls[0][0].args;
    expect(args).toContain("--model");
    expect(args).toContain("gemini-2.5-flash");
  });

  it("handles timeout gracefully", async () => {
    mockSpawn.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    });

    const result = await executeSearch({
      query: "test",
      workingDirectory: tmpDir,
    });

    expect(result.timedOut).toBe(true);
    expect(result.response).toContain("timed out");
  });

  it("throws on auth error", async () => {
    mockSpawn.mockResolvedValue({
      stdout: "",
      stderr: "Authentication failed: invalid credentials",
      exitCode: 1,
      timedOut: false,
    });

    await expect(
      executeSearch({ query: "test", workingDirectory: tmpDir }),
    ).rejects.toThrow("authentication error");
  });

  it("throws on rate limit", async () => {
    mockSpawn.mockResolvedValue({
      stdout: "",
      stderr: "429 Too Many Requests: rate limit exceeded",
      exitCode: 1,
      timedOut: false,
    });

    await expect(
      executeSearch({ query: "test", workingDirectory: tmpDir }),
    ).rejects.toThrow("rate limit");
  });
});
