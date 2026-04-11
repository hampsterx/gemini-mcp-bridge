import { execFileSync } from "node:child_process";

/**
 * Find the git repository root for a given directory.
 * Throws if not inside a git repo.
 */
export function getGitRoot(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    throw new Error(`Not a git repository: ${cwd}`);
  }
}

/**
 * Get a unified diff of uncommitted changes (staged + unstaged).
 */
export function getUncommittedDiff(cwd: string, contextLines = 5): string {
  try {
    // Staged changes
    const staged = execFileSync(
      "git",
      ["-C", cwd, "diff", "--cached", `-U${contextLines}`],
      { encoding: "utf8", timeout: 30000 },
    ).trim();

    // Unstaged changes
    const unstaged = execFileSync(
      "git",
      ["-C", cwd, "diff", `-U${contextLines}`],
      { encoding: "utf8", timeout: 30000 },
    ).trim();

    const parts = [staged, unstaged].filter(Boolean);
    if (parts.length === 0) {
      throw new Error("No uncommitted changes found");
    }
    return parts.join("\n");
  } catch (e) {
    if (e instanceof Error && e.message === "No uncommitted changes found") {
      throw e;
    }
    throw new Error(`Failed to get git diff: ${e}`);
  }
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export type DiffSpec = { type: "uncommitted" } | { type: "branch"; base: string };

/**
 * Parse `git diff --numstat` output into a DiffStat summary.
 *
 * Binary files (`-\t-\t<path>`) contribute to the file count but not to
 * line counts. Renames (`{old => new}` in the path) count as a single
 * file. Exported for unit testing.
 */
export function parseNumstat(output: string): DiffStat {
  const stat: DiffStat = { files: 0, insertions: 0, deletions: 0 };
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    stat.files += 1;
    const [ins, del] = parts;
    if (ins !== "-") stat.insertions += parseInt(ins, 10) || 0;
    if (del !== "-") stat.deletions += parseInt(del, 10) || 0;
  }
  return stat;
}

/**
 * Get numstat summary for a diff spec. Uses `git diff HEAD` for the
 * uncommitted case so the stat matches what the agentic review prompt
 * actually executes (`git diff HEAD -U5`). This also avoids the double-
 * count you'd get from summing `--cached` and working-tree diffs when a
 * file is both staged and has further unstaged edits.
 */
export function getDiffStat(cwd: string, spec: DiffSpec): DiffStat {
  const run = (refArgs: string[]): string =>
    execFileSync("git", ["-C", cwd, "diff", "--numstat", ...refArgs], {
      encoding: "utf8",
      timeout: 30000,
    });

  try {
    if (spec.type === "branch") {
      if (!/^[\w./-]+$/.test(spec.base)) {
        throw new Error(
          `Invalid base ref: "${spec.base}" — expected a branch name such as 'main' or 'origin/develop' (no revision syntax like HEAD~2 or main^)`,
        );
      }
      return parseNumstat(run([`${spec.base}...HEAD`]));
    }
    return parseNumstat(run(["HEAD"]));
  } catch (e) {
    throw new Error(`Failed to get git diff stat: ${e}`);
  }
}

/**
 * Get a diff between the current branch and a base branch/ref.
 */
export function getBranchDiff(cwd: string, base: string, contextLines = 5): string {
  try {
    const diff = execFileSync(
      "git",
      ["-C", cwd, "diff", `${base}...HEAD`, `-U${contextLines}`],
      { encoding: "utf8", timeout: 30000 },
    ).trim();

    if (!diff) {
      throw new Error(`No diff found between ${base} and HEAD`);
    }
    return diff;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("No diff found")) {
      throw e;
    }
    throw new Error(`Failed to get branch diff against "${base}": ${e}`);
  }
}
