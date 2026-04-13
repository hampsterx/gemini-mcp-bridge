import {
  getGitRoot,
  getDiffStat,
  getDiffFiles,
  type DiffStat,
  type DiffSpec,
} from "../utils/git.js";
import { verifyDirectory } from "../utils/security.js";

export type Complexity = "trivial" | "moderate" | "complex";

export interface AssessSuggestion {
  depth: "scan" | "focused" | "deep";
  estimatedSeconds: number;
  description: string;
}

export interface AssessInput {
  uncommitted?: boolean;
  base?: string;
  workingDirectory?: string;
}

export interface AssessResult {
  diffStat: DiffStat;
  changedFiles: string[];
  complexity: Complexity;
  suggestions: AssessSuggestion[];
  resolvedCwd: string;
}

/**
 * Classify diff complexity from stat and file paths.
 *
 * - trivial: 1-2 files and <100 total lines changed
 * - moderate: 3-8 files, or >100 lines in 1-2 files
 * - complex: 9+ files, or cross-cutting (paths span 3+ top-level directories)
 */
export function classifyComplexity(stat: DiffStat, files: string[]): Complexity {
  const totalLines = stat.insertions + stat.deletions;

  const topLevelDirs = new Set(
    files.map((f) => {
      const sep = f.indexOf("/");
      return sep > 0 ? f.slice(0, sep) : ".";
    }),
  );
  const crossCutting = topLevelDirs.size >= 3;

  if (stat.files >= 9 || crossCutting) return "complex";
  if (stat.files >= 3 || totalLines > 100) return "moderate";
  return "trivial";
}

/**
 * Build review depth suggestions with estimated wall-clock durations.
 *
 * Estimates account for CLI cold start (~16s) plus per-file overhead.
 * These are approximate expected times, not timeout budgets.
 */
export function buildSuggestions(stat: DiffStat): AssessSuggestion[] {
  return [
    {
      depth: "scan",
      estimatedSeconds: 30,
      description: "Diff-only, no repo exploration. Fast single-pass review.",
    },
    {
      depth: "focused",
      estimatedSeconds: Math.min(30 + 10 * stat.files, 240),
      description: "Reads changed files for context. Does not trace imports or check tests.",
    },
    {
      depth: "deep",
      estimatedSeconds: Math.min(60 + 25 * stat.files, 1200),
      description: "Full repo exploration: follows imports, checks tests, reads project conventions.",
    },
  ];
}

/**
 * Assess a diff and return structured analysis with review depth suggestions.
 *
 * Pure Node operation, no CLI spawn, no model call. Runs git locally to
 * classify the diff and suggest appropriate review depth levels.
 */
export async function executeAssess(input: AssessInput): Promise<AssessResult> {
  const { uncommitted = true, base } = input;

  if (!base && !uncommitted) {
    throw new Error("Either 'uncommitted' must be true or 'base' must be specified");
  }

  const requestedDir = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();
  const cwd = getGitRoot(requestedDir);

  const diffSpec: DiffSpec = base ? { type: "branch", base } : { type: "uncommitted" };

  const diffStat = getDiffStat(cwd, diffSpec);
  const changedFiles = getDiffFiles(cwd, diffSpec);
  const complexity = classifyComplexity(diffStat, changedFiles);
  const suggestions = buildSuggestions(diffStat);

  return {
    diffStat,
    changedFiles,
    complexity,
    suggestions,
    resolvedCwd: cwd,
  };
}
