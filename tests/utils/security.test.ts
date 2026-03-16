import { describe, it, expect } from "vitest";
import { resolveAndVerify, verifyDirectory } from "../../src/utils/security.js";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("resolveAndVerify", () => {
  it("allows files within root", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));
    const filePath = path.join(tmpDir, "test.txt");
    await writeFile(filePath, "hello");

    const resolved = await resolveAndVerify("test.txt", tmpDir);
    expect(resolved).toBe(filePath);
  });

  it("blocks path traversal with ..", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));
    await writeFile(path.join(tmpDir, "test.txt"), "hello");

    await expect(
      resolveAndVerify("../../etc/passwd", tmpDir),
    ).rejects.toThrow("Path traversal blocked");
  });

  it("blocks symlinks pointing outside root", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));
    const linkPath = path.join(tmpDir, "sneaky-link");
    await symlink("/etc/hostname", linkPath);

    await expect(
      resolveAndVerify("sneaky-link", tmpDir),
    ).rejects.toThrow("Path traversal blocked");
  });
});

describe("verifyDirectory", () => {
  it("accepts valid directories", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));
    const result = await verifyDirectory(tmpDir);
    expect(result).toBe(tmpDir);
  });

  it("rejects files", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-test-"));
    const filePath = path.join(tmpDir, "file.txt");
    await writeFile(filePath, "hello");

    await expect(verifyDirectory(filePath)).rejects.toThrow("Not a directory");
  });

  it("rejects non-existent paths", async () => {
    await expect(verifyDirectory("/nonexistent/path")).rejects.toThrow();
  });
});
