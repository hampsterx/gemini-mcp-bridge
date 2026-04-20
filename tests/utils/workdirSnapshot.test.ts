import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { snapshotWorkdir, diffSnapshots } from "../../src/utils/workdirSnapshot.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function initRepo(): Promise<string> {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), "gmb-ws-test-")));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

describe("snapshotWorkdir + diffSnapshots", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await initRepo();
    await writeFile(path.join(repo, "a.txt"), "alpha\n");
    await writeFile(path.join(repo, "b.txt"), "bravo\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("detects no change when nothing happens", async () => {
    const before = await snapshotWorkdir(repo);
    const after = await snapshotWorkdir(repo);
    const diff = diffSnapshots(before, after);
    expect(diff.changed).toBe(false);
    expect(diff.modified).toHaveLength(0);
    expect(diff.appeared).toHaveLength(0);
  });

  it("detects a modified tracked file", async () => {
    const before = await snapshotWorkdir(repo);

    // Wait 10ms so mtime can differ. On some filesystems with 1s mtime
    // resolution we rely on size change instead.
    await new Promise((r) => setTimeout(r, 10));
    await appendFile(path.join(repo, "a.txt"), "more\n");

    const after = await snapshotWorkdir(repo);
    const diff = diffSnapshots(before, after);

    expect(diff.changed).toBe(true);
    expect(diff.modified).toContain("a.txt");
  });

  it("detects a newly created untracked file via statusChanged", async () => {
    const before = await snapshotWorkdir(repo);
    await writeFile(path.join(repo, "new.txt"), "brand new\n");
    const after = await snapshotWorkdir(repo);
    const diff = diffSnapshots(before, after);

    expect(diff.changed).toBe(true);
    expect(diff.statusChanged).toBe(true);
  });

  it("detects a tracked file that became modified vs one that was already dirty", async () => {
    // Dirty file BEFORE the snapshot: should appear in `before.status`,
    // still appear in `after.status` → status might not change, but content
    // change should still be caught via mtime+size.
    await appendFile(path.join(repo, "b.txt"), "dirty\n");

    const before = await snapshotWorkdir(repo);
    await new Promise((r) => setTimeout(r, 10));
    await appendFile(path.join(repo, "b.txt"), "more-dirty\n");
    const after = await snapshotWorkdir(repo);

    const diff = diffSnapshots(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.modified).toContain("b.txt");
  });

  it("detects modification to a pre-existing untracked file", async () => {
    // Untracked but not gitignored: shows up in `git ls-files --others
    // --exclude-standard`. A pre-snapshot edit to an already-untracked file
    // should still be caught — this was the CodeRabbit-raised gap.
    await writeFile(path.join(repo, "notes.tmp"), "initial\n");
    // notes.tmp is untracked (not added to git) but not gitignored.

    const before = await snapshotWorkdir(repo);
    await new Promise((r) => setTimeout(r, 10));
    await appendFile(path.join(repo, "notes.tmp"), "appended\n");
    const after = await snapshotWorkdir(repo);

    const diff = diffSnapshots(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.modified).toContain("notes.tmp");
  });

  it("throws when not inside a git repo", async () => {
    const nonRepo = realpathSync(await mkdtemp(path.join(os.tmpdir(), "gmb-non-repo-")));
    try {
      await expect(snapshotWorkdir(nonRepo)).rejects.toThrow();
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });
});
