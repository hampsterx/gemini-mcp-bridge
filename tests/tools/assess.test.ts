import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { DiffStat } from "../../src/utils/git.js";
import {
  classifyComplexity,
  classifyDiffKind,
  buildGuidance,
  buildSuggestions,
  executeAssess,
} from "../../src/tools/assess.js";

// ---------------------------------------------------------------------------
// classifyComplexity
// ---------------------------------------------------------------------------

describe("classifyComplexity", () => {
  const stat = (files: number, ins = 10, del = 5): DiffStat => ({
    files,
    insertions: ins,
    deletions: del,
  });

  it("returns trivial for 1-2 files under 100 lines", () => {
    expect(classifyComplexity(stat(1, 30, 20), ["src/foo.ts"])).toBe("trivial");
    expect(classifyComplexity(stat(2, 40, 30), ["src/foo.ts", "src/bar.ts"])).toBe("trivial");
  });

  it("returns trivial for 0 files", () => {
    expect(classifyComplexity(stat(0, 0, 0), [])).toBe("trivial");
  });

  it("boundary: exactly 100 total lines with 2 files is trivial", () => {
    expect(classifyComplexity(stat(2, 50, 50), ["src/a.ts", "src/b.ts"])).toBe("trivial");
  });

  it("returns moderate for >100 lines even with 1-2 files", () => {
    expect(classifyComplexity(stat(1, 80, 30), ["src/foo.ts"])).toBe("moderate");
    expect(classifyComplexity(stat(2, 51, 50), ["src/a.ts", "src/b.ts"])).toBe("moderate");
  });

  it("returns moderate for 3-8 files", () => {
    expect(classifyComplexity(stat(3, 10, 5), ["src/a.ts", "src/b.ts", "src/c.ts"])).toBe("moderate");
    expect(classifyComplexity(stat(8, 10, 5), Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`))).toBe("moderate");
  });

  it("returns complex for 9+ files", () => {
    expect(classifyComplexity(stat(9, 10, 5), Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`))).toBe("complex");
    expect(classifyComplexity(stat(20, 10, 5), Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`))).toBe("complex");
  });

  it("returns complex for cross-cutting changes (3+ top-level dirs)", () => {
    // src/app.ts -> "src", tests/app.test.ts -> "tests", config.json -> "."
    const files = ["src/app.ts", "tests/app.test.ts", "config.json"];
    expect(classifyComplexity(stat(3, 10, 5), files)).toBe("complex");
  });

  it("does not treat 2 top-level dirs as cross-cutting", () => {
    const files = ["src/a.ts", "src/b.ts", "tests/a.test.ts"];
    // 2 dirs (src, tests) + 3 files -> moderate (not complex)
    expect(classifyComplexity(stat(3, 10, 5), files)).toBe("moderate");
  });

  it("root-level files map to '.' as their top-level dir", () => {
    // All root-level: package.json, README.md, tsconfig.json -> all "."
    const files = ["package.json", "README.md", "tsconfig.json"];
    // 1 top-level dir -> not cross-cutting, 3 files -> moderate
    expect(classifyComplexity(stat(3, 10, 5), files)).toBe("moderate");
  });
});

describe("classifyDiffKind", () => {
  it("returns empty for no files", () => {
    expect(classifyDiffKind([])).toBe("empty");
  });

  it("returns generated for lockfile-only churn", () => {
    expect(classifyDiffKind(["package-lock.json", "pnpm-lock.yaml"])).toBe("generated");
  });

  it("returns code for code-only changes", () => {
    expect(classifyDiffKind(["src/app.ts", "tests/app.test.ts"])).toBe("code");
  });

  it("returns non-code for docs and config only", () => {
    expect(classifyDiffKind(["README.md", ".github/workflows/ci.yml"])).toBe("non-code");
  });

  it("returns mixed when code and docs/config are both present", () => {
    expect(classifyDiffKind(["src/app.ts", "README.md"])).toBe("mixed");
  });
});

describe("buildGuidance", () => {
  it("does not recommend skipping review for non-code changes", () => {
    expect(buildGuidance("non-code")).toContain("can still carry correctness risk");
  });

  it("reserves low-signal guidance for generated churn", () => {
    expect(buildGuidance("generated")).toContain("Generated churn detected");
  });
});

// ---------------------------------------------------------------------------
// buildSuggestions
// ---------------------------------------------------------------------------

describe("buildSuggestions", () => {
  it("returns three suggestions: scan, focused, deep", () => {
    const suggestions = buildSuggestions({ files: 5, insertions: 100, deletions: 50 }, "code");
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0].depth).toBe("scan");
    expect(suggestions[1].depth).toBe("focused");
    expect(suggestions[2].depth).toBe("deep");
  });

  it("scan estimate is fixed at 30s regardless of diff size", () => {
    expect(buildSuggestions({ files: 0, insertions: 0, deletions: 0 }, "empty")[0].estimatedSeconds).toBe(30);
    expect(buildSuggestions({ files: 50, insertions: 1000, deletions: 500 }, "code")[0].estimatedSeconds).toBe(30);
  });

  it("focused estimate scales with file count", () => {
    expect(buildSuggestions({ files: 1, insertions: 0, deletions: 0 }, "code")[1].estimatedSeconds).toBe(40);
    expect(buildSuggestions({ files: 5, insertions: 0, deletions: 0 }, "code")[1].estimatedSeconds).toBe(80);
  });

  it("focused estimate caps at 240s", () => {
    expect(buildSuggestions({ files: 100, insertions: 0, deletions: 0 }, "code")[1].estimatedSeconds).toBe(240);
  });

  it("deep estimate scales with file count", () => {
    expect(buildSuggestions({ files: 1, insertions: 0, deletions: 0 }, "code")[2].estimatedSeconds).toBe(85);
    expect(buildSuggestions({ files: 5, insertions: 0, deletions: 0 }, "code")[2].estimatedSeconds).toBe(185);
  });

  it("deep estimate caps at 1200s", () => {
    expect(buildSuggestions({ files: 100, insertions: 0, deletions: 0 }, "code")[2].estimatedSeconds).toBe(1200);
  });

  it("all suggestions have non-empty descriptions", () => {
    for (const s of buildSuggestions({ files: 3, insertions: 50, deletions: 10 }, "mixed")) {
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it("generated diffs do not say review is unnecessary", () => {
    const suggestions = buildSuggestions({ files: 2, insertions: 10, deletions: 5 }, "generated");
    expect(suggestions[2].description).toContain("Usually unnecessary");
    expect(suggestions[1].description).not.toContain("No review recommended");
  });
});

// ---------------------------------------------------------------------------
// executeAssess (integration, real temp git repos)
// ---------------------------------------------------------------------------

/** Initialise a throwaway git repo with one committed file. */
async function initRepo(dir: string): Promise<void> {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, "README.md"), "initial\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
}

describe("executeAssess", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-assess-test-"));
    await initRepo(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns trivial for a small uncommitted change", async () => {
    await writeFile(path.join(tmpDir, "file.txt"), "hello\n");
    execFileSync("git", ["-C", tmpDir, "add", "file.txt"], { stdio: "pipe" });

    const result = await executeAssess({ workingDirectory: tmpDir });

    expect(result.complexity).toBe("trivial");
    expect(result.diffKind).toBe("non-code");
    expect(result.diffStat.files).toBe(1);
    expect(result.changedFiles).toContain("file.txt");
    expect(result.suggestions).toHaveLength(3);
    expect(result.guidance).toContain("Non-code changes");
    expect(result.resolvedCwd).toBeTruthy();
  });

  it("returns moderate for 4 files", async () => {
    for (let i = 0; i < 4; i++) {
      await writeFile(path.join(tmpDir, `file${i}.txt`), `content ${i}\n`);
    }
    execFileSync("git", ["-C", tmpDir, "add", "-A"], { stdio: "pipe" });

    const result = await executeAssess({ workingDirectory: tmpDir });

    expect(result.complexity).toBe("moderate");
    expect(result.diffKind).toBe("non-code");
    expect(result.diffStat.files).toBe(4);
    expect(result.changedFiles).toHaveLength(4);
  });

  it("returns complex for cross-cutting changes", async () => {
    await mkdir(path.join(tmpDir, "src"), { recursive: true });
    await mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await writeFile(path.join(tmpDir, "src", "app.ts"), "export {};\n");
    await writeFile(path.join(tmpDir, "tests", "app.test.ts"), "test();\n");
    await writeFile(path.join(tmpDir, "config.json"), "{}");
    execFileSync("git", ["-C", tmpDir, "add", "-A"], { stdio: "pipe" });

    const result = await executeAssess({ workingDirectory: tmpDir });

    expect(result.complexity).toBe("complex");
    expect(result.diffKind).toBe("mixed");
    expect(result.changedFiles).toHaveLength(3);
  });

  it("works with base branch diff", async () => {
    execFileSync("git", ["-C", tmpDir, "branch", "base-ref"], { stdio: "pipe" });
    execFileSync("git", ["-C", tmpDir, "checkout", "-b", "feature"], { stdio: "pipe" });
    await writeFile(path.join(tmpDir, "new.txt"), "new file\n");
    execFileSync("git", ["-C", tmpDir, "add", "new.txt"], { stdio: "pipe" });
    execFileSync("git", ["-C", tmpDir, "commit", "-q", "-m", "add new"], { stdio: "pipe" });

    const result = await executeAssess({
      workingDirectory: tmpDir,
      base: "base-ref",
    });

    expect(result.diffStat.files).toBe(1);
    expect(result.changedFiles).toContain("new.txt");
    expect(result.diffKind).toBe("non-code");
  });

  it("returns trivial with empty stats when no changes", async () => {
    // No uncommitted changes: getDiffStat returns { files: 0, ... }
    const result = await executeAssess({ workingDirectory: tmpDir });

    expect(result.complexity).toBe("trivial");
    expect(result.diffKind).toBe("empty");
    expect(result.diffStat.files).toBe(0);
    expect(result.changedFiles).toHaveLength(0);
  });

  it("throws when uncommitted is false and no base is set", async () => {
    await expect(
      executeAssess({ workingDirectory: tmpDir, uncommitted: false }),
    ).rejects.toThrow("Either 'uncommitted' must be true or 'base' must be specified");
  });

  it("resolvedCwd points to git root", async () => {
    await mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await writeFile(path.join(tmpDir, "sub", "file.txt"), "content\n");
    execFileSync("git", ["-C", tmpDir, "add", "-A"], { stdio: "pipe" });

    const result = await executeAssess({
      workingDirectory: path.join(tmpDir, "sub"),
    });

    // Should resolve to git root, not the subdirectory
    expect(result.resolvedCwd).not.toContain("sub");
    expect(result.changedFiles).toContain("sub/file.txt");
  });

  it("classifies lockfile-only churn as generated", async () => {
    await writeFile(path.join(tmpDir, "package-lock.json"), "{\n  \"lockfileVersion\": 3\n}\n");
    execFileSync("git", ["-C", tmpDir, "add", "package-lock.json"], { stdio: "pipe" });

    const result = await executeAssess({ workingDirectory: tmpDir });

    expect(result.diffKind).toBe("generated");
    expect(result.guidance).toContain("Generated churn detected");
  });
});
