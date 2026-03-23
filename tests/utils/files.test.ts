import { describe, it, expect } from "vitest";
import { readFiles, assemblePrompt, isImageFile, IMAGE_EXTENSIONS } from "../../src/utils/files.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("readFiles", () => {
  it("reads files within root", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));
    await writeFile(path.join(tmpDir, "hello.txt"), "Hello world");

    const results = await readFiles(["hello.txt"], tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Hello world");
    expect(results[0].skipped).toBeUndefined();
  });

  it("skips oversized files", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));
    // Create a 1.1MB file
    const bigContent = "x".repeat(1_100_000);
    await writeFile(path.join(tmpDir, "big.txt"), bigContent);

    const results = await readFiles(["big.txt"], tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("");
    expect(results[0].skipped).toContain("exceeds");
  });

  it("rejects too many files", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));
    const files = Array.from({ length: 21 }, (_, i) => `file${i}.txt`);

    await expect(readFiles(files, tmpDir)).rejects.toThrow("Too many files");
  });
});

describe("assemblePrompt", () => {
  it("returns prompt alone when no files", () => {
    const result = assemblePrompt("My question", []);
    expect(result).toBe("My question");
  });

  it("includes file contents", () => {
    const result = assemblePrompt("Review this:", [
      { path: "main.ts", content: "console.log('hi')" },
    ]);
    expect(result).toContain("Review this:");
    expect(result).toContain("--- main.ts ---");
    expect(result).toContain("console.log('hi')");
  });

  it("marks skipped files", () => {
    const result = assemblePrompt("Review:", [
      { path: "big.bin", content: "", skipped: "2048KB exceeds 1024KB limit" },
    ]);
    expect(result).toContain("[SKIPPED: 2048KB exceeds 1024KB limit]");
  });
});

describe("isImageFile", () => {
  it("recognises all supported image extensions", () => {
    for (const ext of IMAGE_EXTENSIONS) {
      expect(isImageFile(`photo${ext}`)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isImageFile("photo.PNG")).toBe(true);
    expect(isImageFile("photo.JpEg")).toBe(true);
  });

  it("rejects non-image files", () => {
    expect(isImageFile("code.ts")).toBe(false);
    expect(isImageFile("readme.md")).toBe(false);
    expect(isImageFile("data.json")).toBe(false);
    expect(isImageFile("style.css")).toBe(false);
    expect(isImageFile("image.svg")).toBe(false);
  });

  it("rejects files with no extension", () => {
    expect(isImageFile("Makefile")).toBe(false);
    expect(isImageFile(".gitignore")).toBe(false);
  });
});
