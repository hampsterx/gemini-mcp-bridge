import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Mock spawnGemini before importing the module under test
vi.mock("../../src/utils/spawn.js", () => ({
  spawnGemini: vi.fn(),
}));

import { executeStructured } from "../../src/tools/structured.js";
import { spawnGemini } from "../../src/utils/spawn.js";

const mockSpawn = vi.mocked(spawnGemini);

const SIMPLE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" },
  },
  required: ["name", "age"],
});

function jsonResponse(text: string) {
  return {
    stdout: "",
    stderr: JSON.stringify({ response: text }),
    exitCode: 0,
    timedOut: false,
  };
}

describe("executeStructured", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-structured-test-"));
  });

  it("valid JSON response matching schema returns valid: true", async () => {
    mockSpawn.mockResolvedValue(jsonResponse('{"name": "John", "age": 30}'));

    const result = await executeStructured({
      prompt: "Extract name and age",
      schema: SIMPLE_SCHEMA,
      workingDirectory: tmpDir,
    });

    expect(result.valid).toBe(true);
    expect(JSON.parse(result.response)).toEqual({ name: "John", age: 30 });
    expect(result.timedOut).toBe(false);
  });

  it("JSON wrapped in markdown fences is extracted and validated", async () => {
    mockSpawn.mockResolvedValue(
      jsonResponse('```json\n{"name": "Jane", "age": 25}\n```'),
    );

    const result = await executeStructured({
      prompt: "Extract",
      schema: SIMPLE_SCHEMA,
      workingDirectory: tmpDir,
    });

    expect(result.valid).toBe(true);
    expect(JSON.parse(result.response)).toEqual({ name: "Jane", age: 25 });
  });

  it("JSON with surrounding text is extracted and validated", async () => {
    mockSpawn.mockResolvedValue(
      jsonResponse('Here is the data:\n{"name": "Bob", "age": 40}\nDone.'),
    );

    const result = await executeStructured({
      prompt: "Extract",
      schema: SIMPLE_SCHEMA,
      workingDirectory: tmpDir,
    });

    expect(result.valid).toBe(true);
    expect(JSON.parse(result.response)).toEqual({ name: "Bob", age: 40 });
  });

  it("response not matching schema returns valid: false with errors", async () => {
    // Missing required "age" field
    mockSpawn.mockResolvedValue(jsonResponse('{"name": "John"}'));

    const result = await executeStructured({
      prompt: "Extract",
      schema: SIMPLE_SCHEMA,
      workingDirectory: tmpDir,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("age");
  });

  it("wrong type returns valid: false with errors", async () => {
    // age should be number, not string
    mockSpawn.mockResolvedValue(jsonResponse('{"name": "John", "age": "thirty"}'));

    const result = await executeStructured({
      prompt: "Extract",
      schema: SIMPLE_SCHEMA,
      workingDirectory: tmpDir,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("number");
  });

  it("non-JSON response returns valid: false", async () => {
    mockSpawn.mockResolvedValue(jsonResponse("I cannot extract structured data from this."));

    const result = await executeStructured({
      prompt: "Extract",
      schema: SIMPLE_SCHEMA,
      workingDirectory: tmpDir,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Could not extract JSON");
  });

  it("invalid schema JSON throws error", async () => {
    await expect(
      executeStructured({
        prompt: "test",
        schema: "not json at all",
        workingDirectory: tmpDir,
      }),
    ).rejects.toThrow("Invalid schema: not valid JSON");
  });

  it("valid JSON but invalid JSON Schema throws error", async () => {
    await expect(
      executeStructured({
        prompt: "test",
        schema: JSON.stringify({ type: "not-a-real-type" }),
        workingDirectory: tmpDir,
      }),
    ).rejects.toThrow("Invalid JSON Schema");
  });

  it("image files in files array throws error", async () => {
    await expect(
      executeStructured({
        prompt: "test",
        schema: SIMPLE_SCHEMA,
        files: ["photo.png"],
        workingDirectory: tmpDir,
      }),
    ).rejects.toThrow("does not support image files");
  });

  it("text files are included in prompt", async () => {
    await writeFile(path.join(tmpDir, "data.txt"), "John is 30 years old");
    mockSpawn.mockResolvedValue(jsonResponse('{"name": "John", "age": 30}'));

    const result = await executeStructured({
      prompt: "Extract person info",
      schema: SIMPLE_SCHEMA,
      files: ["data.txt"],
      workingDirectory: tmpDir,
    });

    expect(result.valid).toBe(true);
    expect(result.filesIncluded).toEqual(["data.txt"]);

    const stdin = mockSpawn.mock.calls[0][0].stdin;
    expect(stdin).toContain("John is 30 years old");
    expect(stdin).toContain("JSON Schema");
  });

  it("schema is embedded in prompt", async () => {
    mockSpawn.mockResolvedValue(jsonResponse('{"name": "X", "age": 1}'));

    await executeStructured({
      prompt: "Extract",
      schema: SIMPLE_SCHEMA,
      workingDirectory: tmpDir,
    });

    // Prompt may be in stdin or positional arg depending on length
    const call = mockSpawn.mock.calls[0][0];
    const prompt = call.stdin ?? call.args[call.args.length - 1];
    expect(prompt).toContain('"type": "object"');
    expect(prompt).toContain('"required"');
  });

  it("timeout returns valid: false", async () => {
    mockSpawn.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    });

    const result = await executeStructured({
      prompt: "Extract",
      schema: SIMPLE_SCHEMA,
      workingDirectory: tmpDir,
    });

    expect(result.valid).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("auth error propagates", async () => {
    mockSpawn.mockResolvedValue({
      stdout: "",
      stderr: "Authentication failed: invalid credentials",
      exitCode: 1,
      timedOut: false,
    });

    await expect(
      executeStructured({
        prompt: "Extract",
        schema: SIMPLE_SCHEMA,
        workingDirectory: tmpDir,
      }),
    ).rejects.toThrow("authentication error");
  });

  it("schema exceeding size limit throws error", async () => {
    const hugeSchema = JSON.stringify({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [`field${i}`, { type: "string", description: "x".repeat(20) }]),
      ),
    });

    await expect(
      executeStructured({
        prompt: "test",
        schema: hugeSchema,
        workingDirectory: tmpDir,
      }),
    ).rejects.toThrow("Schema too large");
  });

  it("does not use --yolo (non-agentic)", async () => {
    mockSpawn.mockResolvedValue(jsonResponse('{"name": "X", "age": 1}'));

    await executeStructured({
      prompt: "Extract",
      schema: SIMPLE_SCHEMA,
      workingDirectory: tmpDir,
    });

    const args = mockSpawn.mock.calls[0][0].args;
    expect(args).not.toContain("--yolo");
    expect(args).toContain("--output-format");
  });

  it("passes model flag when specified", async () => {
    mockSpawn.mockResolvedValue(jsonResponse('{"name": "X", "age": 1}'));

    await executeStructured({
      prompt: "Extract",
      schema: SIMPLE_SCHEMA,
      model: "gemini-2.5-pro",
      workingDirectory: tmpDir,
    });

    const args = mockSpawn.mock.calls[0][0].args;
    expect(args).toContain("--model");
    expect(args).toContain("gemini-2.5-pro");
  });

  it("rejects more than 20 files", async () => {
    const files = Array.from({ length: 21 }, (_, i) => `file${i}.txt`);

    await expect(
      executeStructured({
        prompt: "test",
        schema: SIMPLE_SCHEMA,
        files,
        workingDirectory: tmpDir,
      }),
    ).rejects.toThrow("Too many files");
  });
});
