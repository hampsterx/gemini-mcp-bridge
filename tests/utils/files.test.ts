import { describe, it, expect } from "vitest";
import { isImageFile, IMAGE_EXTENSIONS, verifyFilePaths, buildFileHints } from "../../src/utils/files.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("verifyFilePaths", () => {
  it("verifies files within root", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));
    await writeFile(path.join(tmpDir, "hello.txt"), "Hello world");

    const result = await verifyFilePaths(["hello.txt"], tmpDir);
    expect(result.verified).toEqual(["hello.txt"]);
    expect(result.skipped).toEqual([]);
  });

  it("skips missing files", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));

    const result = await verifyFilePaths(["missing.txt"], tmpDir);
    expect(result.verified).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("missing.txt");
  });

  it("skips files outside root directory", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));

    const result = await verifyFilePaths(["../etc/passwd"], tmpDir);
    expect(result.verified).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it("handles mix of valid and invalid files", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));
    await writeFile(path.join(tmpDir, "good.txt"), "ok");

    const result = await verifyFilePaths(["good.txt", "bad.txt"], tmpDir);
    expect(result.verified).toContain("good.txt");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("bad.txt");
  });
});

describe("buildFileHints", () => {
  it("returns empty string for no files", () => {
    expect(buildFileHints([])).toBe("");
  });

  it("builds @{path} references for single file", () => {
    const result = buildFileHints(["main.ts"]);
    expect(result).toContain("@{main.ts}");
    expect(result).toContain("Referenced files:");
  });

  it("builds @{path} references for multiple files", () => {
    const result = buildFileHints(["main.ts", "utils.ts", "test.ts"]);
    expect(result).toContain("@{main.ts}");
    expect(result).toContain("@{utils.ts}");
    expect(result).toContain("@{test.ts}");
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
