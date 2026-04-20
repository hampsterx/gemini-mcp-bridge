import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Snapshot of a working directory's on-disk state, captured cheaply enough
 * to run before and after a Gemini CLI spawn.
 *
 * Shape:
 *   - `tracked`: `git ls-files` (tracked) + `git ls-files --others --exclude-standard`
 *     (untracked-and-not-gitignored) output mapped to `{ sizeBytes, mtimeMs }`.
 *     Untracked coverage catches modifications to pre-existing untracked
 *     files like `.env.local` that are in the work tree but not staged.
 *     Gitignored files (e.g. `node_modules/`) are intentionally excluded.
 *     Files missing at snapshot time (race with untracked file creation) are
 *     represented as `null`.
 *   - `status`: verbatim `git status --porcelain` output at snapshot time.
 *
 * We rely on mtime + size to detect content mutation because a subprocess
 * write almost always bumps mtime, and comparing `git status` alone misses
 * the case where a file is already dirty before the spawn and gets further
 * modified (status line stays `M`, content differs).
 */
export interface WorkdirSnapshot {
  tracked: Map<string, FileStat | null>;
  status: string;
}

interface FileStat {
  sizeBytes: number;
  mtimeMs: number;
}

export interface WorkdirDiff {
  changed: boolean;
  modified: string[];
  appeared: string[];
  disappeared: string[];
  statusChanged: boolean;
}

/**
 * Snapshot tracked-file stats and `git status --porcelain` for a directory.
 *
 * Requires the directory to be inside a git repository. Throws if git is
 * unavailable or the directory isn't tracked. Untracked file creation is
 * caught via `statusChanged`, not via `tracked`.
 */
export async function snapshotWorkdir(cwd: string): Promise<WorkdirSnapshot> {
  const tracked = new Map<string, FileStat | null>();

  // Tracked files AND existing untracked-and-not-gitignored files. Covers
  // three mutation classes: tracked-file edits, pre-existing untracked-file
  // edits (e.g. `.env.local`), and gitignored-file edits are intentionally
  // NOT watched here — those are usually build output / caches Gemini is
  // allowed to touch.
  const trackedOut = runGit(cwd, ["ls-files", "-z"]);
  const untrackedOut = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const files = [
    ...trackedOut.split("\0"),
    ...untrackedOut.split("\0"),
  ].filter(Boolean);

  // fs.stat in parallel; the OS cache keeps this fast even for thousands of
  // files, and the promise overhead is small compared to the Gemini spawn.
  await Promise.all(
    files.map(async (rel) => {
      try {
        const abs = path.resolve(cwd, rel);
        const s = await stat(abs);
        tracked.set(rel, { sizeBytes: s.size, mtimeMs: s.mtimeMs });
      } catch {
        // File disappeared between ls-files and stat; record as missing so
        // reappearance or real deletion both show up in the diff.
        tracked.set(rel, null);
      }
    }),
  );

  const status = runGit(cwd, ["status", "--porcelain"]);
  return { tracked, status };
}

/**
 * Compare two snapshots and return which tracked files changed plus whether
 * `git status` differs. `changed` is true when any tracked file's size or
 * mtime moved, any file appeared or disappeared, or the status output moved
 * (which catches new untracked files).
 */
export function diffSnapshots(
  before: WorkdirSnapshot,
  after: WorkdirSnapshot,
): WorkdirDiff {
  const modified: string[] = [];
  const disappeared: string[] = [];
  const appeared: string[] = [];

  for (const [file, prev] of before.tracked) {
    const next = after.tracked.get(file);
    if (next === undefined) {
      // Was tracked, no longer listed by git ls-files — treat as disappeared.
      disappeared.push(file);
      continue;
    }
    if (prev === null && next === null) continue;
    if (prev === null || next === null) {
      modified.push(file);
      continue;
    }
    if (prev.sizeBytes !== next.sizeBytes || prev.mtimeMs !== next.mtimeMs) {
      modified.push(file);
    }
  }

  for (const file of after.tracked.keys()) {
    if (!before.tracked.has(file)) {
      appeared.push(file);
    }
  }

  const statusChanged = before.status !== after.status;
  const changed = modified.length > 0
    || appeared.length > 0
    || disappeared.length > 0
    || statusChanged;

  return { changed, modified, appeared, disappeared, statusChanged };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}
