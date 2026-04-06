import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Mock spawnGemini before importing modules
vi.mock("../../src/utils/spawn.js", () => ({
  spawnGemini: vi.fn(),
  findGeminiBinary: vi.fn().mockReturnValue("/usr/bin/gemini"),
}));

import { executeQuery } from "../../src/tools/query.js";
import { executeSearch } from "../../src/tools/search.js";
import { spawnGemini } from "../../src/utils/spawn.js";

const mockSpawn = vi.mocked(spawnGemini);

function streamJsonResponse(text: string) {
  const stdout = [
    '{"type":"init","session_id":"test"}',
    `{"type":"message","role":"assistant","content":${JSON.stringify(text)}}`,
    `{"type":"result","response":${JSON.stringify(text)},"stats":{}}`,
  ].join("\n");
  return { stdout, stderr: "", exitCode: 0, timedOut: false };
}

describe("tool execution metadata", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-meta-test-"));
  });

  it("query result includes model and timedOut fields for _meta", async () => {
    mockSpawn.mockResolvedValue(streamJsonResponse("Hello!"));

    const result = await executeQuery({
      prompt: "Say hello",
      model: "gemini-2.5-flash",
      workingDirectory: tmpDir,
    });

    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.timedOut).toBe(false);
    expect(result.resolvedCwd).toBe(tmpDir);
  });

  it("search result includes model on success", async () => {
    mockSpawn.mockResolvedValue(streamJsonResponse("Search results"));

    const result = await executeSearch({
      query: "test query",
      model: "gemini-2.5-flash",
      workingDirectory: tmpDir,
    });

    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.timedOut).toBe(false);
  });

  it("query timeout result has timedOut true", async () => {
    mockSpawn.mockResolvedValue({
      stdout: '{"type":"init","session_id":"test"}\n{"type":"message","role":"assistant","content":"partial"}',
      stderr: "",
      exitCode: null,
      timedOut: true,
    });

    const result = await executeQuery({
      prompt: "long task",
      workingDirectory: tmpDir,
    });

    expect(result.timedOut).toBe(true);
    expect(result.response).toContain("[Partial response");
    expect(result.response).toContain("partial");
  });
});
