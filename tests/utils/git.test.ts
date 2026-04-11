import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { parseNumstat, getDiffStat } from "../../src/utils/git.js";

describe("parseNumstat", () => {
  it("returns zeros for empty output", () => {
    expect(parseNumstat("")).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(parseNumstat("\n\n")).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it("sums a single-file change", () => {
    expect(parseNumstat("10\t3\tsrc/foo.ts\n")).toEqual({
      files: 1,
      insertions: 10,
      deletions: 3,
    });
  });

  it("sums multiple files", () => {
    const output = [
      "10\t3\tsrc/a.ts",
      "5\t0\tsrc/b.ts",
      "0\t8\tsrc/c.ts",
    ].join("\n");
    expect(parseNumstat(output)).toEqual({
      files: 3,
      insertions: 15,
      deletions: 11,
    });
  });

  it("counts binary files as one file with zero line deltas", () => {
    // `git diff --numstat` reports binary files as `-\t-\t<path>`
    const output = [
      "10\t3\tsrc/text.ts",
      "-\t-\tassets/logo.png",
    ].join("\n");
    expect(parseNumstat(output)).toEqual({
      files: 2,
      insertions: 10,
      deletions: 3,
    });
  });

  it("counts a rename as a single file", () => {
    // `git diff --numstat` reports renames as `{ins}\t{del}\t{old => new}`
    const output = "4\t2\tsrc/{old.ts => new.ts}\n";
    expect(parseNumstat(output)).toEqual({
      files: 1,
      insertions: 4,
      deletions: 2,
    });
  });

  it("ignores malformed lines", () => {
    const output = [
      "10\t3\tsrc/a.ts",
      "garbage line with no tabs",
      "only\ttwo",
      "5\t2\tsrc/b.ts",
    ].join("\n");
    expect(parseNumstat(output)).toEqual({
      files: 2,
      insertions: 15,
      deletions: 5,
    });
  });

  it("tolerates non-numeric deltas by treating them as zero", () => {
    // Defensive: parseInt on "-" returns NaN, which we coerce to 0. But any
    // other garbage should also not throw.
    const output = "foo\tbar\tsrc/weird.ts\n";
    expect(parseNumstat(output)).toEqual({
      files: 1,
      insertions: 0,
      deletions: 0,
    });
  });
});

/**
 * End-to-end tests for getDiffStat running against real temp git repos.
 * These guard the claim that the uncommitted stat uses `git diff HEAD
 * --numstat` (matching the agentic prompt) and does not double-count files
 * that are both staged and have further unstaged edits.
 */
describe("getDiffStat (integration)", () => {
  let tmpDir: string;

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", tmpDir, ...args], { stdio: "pipe" });

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "gmb-getdiffstat-test-"));
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    await writeFile(path.join(tmpDir, "a.txt"), "one\ntwo\nthree\n");
    await writeFile(path.join(tmpDir, "b.txt"), "alpha\nbeta\n");
    git("add", "a.txt", "b.txt");
    git("commit", "-q", "-m", "init");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("counts a single staged-only modification as 1 file", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "one\ntwo\nthree\nfour\n");
    git("add", "a.txt");

    const stat = getDiffStat(tmpDir, { type: "uncommitted" });

    expect(stat.files).toBe(1);
    expect(stat.insertions).toBe(1);
    expect(stat.deletions).toBe(0);
  });

  it("counts a single unstaged-only modification as 1 file", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "one\ntwo\nthree\nfour\n");

    const stat = getDiffStat(tmpDir, { type: "uncommitted" });

    expect(stat.files).toBe(1);
    expect(stat.insertions).toBe(1);
  });

  it("does not double-count a file that is both staged AND has further unstaged edits", async () => {
    // Stage one edit
    await writeFile(path.join(tmpDir, "a.txt"), "one\ntwo\nthree\nstaged\n");
    git("add", "a.txt");
    // Add further unstaged edits to the same file
    await writeFile(path.join(tmpDir, "a.txt"), "one\ntwo\nthree\nstaged\nunstaged\n");

    const stat = getDiffStat(tmpDir, { type: "uncommitted" });

    // The buggy implementation (summing --cached + unstaged separately)
    // would report files: 2. `git diff HEAD --numstat` returns 1.
    expect(stat.files).toBe(1);
  });

  it("returns zero stat on a clean repo", () => {
    const stat = getDiffStat(tmpDir, { type: "uncommitted" });

    expect(stat).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it("counts a branch diff against a base ref", async () => {
    git("checkout", "-q", "-b", "feature");
    await writeFile(path.join(tmpDir, "c.txt"), "new file\n");
    git("add", "c.txt");
    git("commit", "-q", "-m", "add c");

    const stat = getDiffStat(tmpDir, { type: "branch", base: "master" });

    expect(stat.files).toBe(1);
    expect(stat.insertions).toBe(1);
  });

  it("rejects invalid base refs without touching git", () => {
    expect(() =>
      getDiffStat(tmpDir, { type: "branch", base: "evil;rm -rf /" }),
    ).toThrow(/Invalid base ref|Failed to get git diff stat/);
  });
});
