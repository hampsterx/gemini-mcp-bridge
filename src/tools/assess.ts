import {
  getGitRoot,
  getDiffStat,
  getDiffFiles,
  type DiffStat,
  type DiffSpec,
} from "../utils/git.js";
import { verifyDirectory } from "../utils/security.js";

export type Complexity = "trivial" | "moderate" | "complex";
export type DiffKind = "empty" | "code" | "mixed" | "non-code" | "generated";

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
  diffKind: DiffKind;
  guidance: string;
  suggestions: AssessSuggestion[];
  resolvedCwd: string;
}

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".tsx",
  ".ts",
  ".vue",
]);

const GENERATED_FILES = new Set([
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

function fileExtension(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx).toLowerCase() : "";
}

function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(fileExtension(path));
}

function isGeneratedFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (GENERATED_FILES.has(basename)) return true;
  if (normalized.endsWith(".min.js")) return true;
  if (normalized.endsWith(".min.css")) return true;
  if (normalized.endsWith(".snap")) return true;
  return false;
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

export function classifyDiffKind(files: string[]): DiffKind {
  if (files.length === 0) return "empty";

  const generatedCount = files.filter(isGeneratedFile).length;
  const codeCount = files.filter(isCodeFile).length;

  if (generatedCount === files.length) return "generated";
  if (codeCount === files.length) return "code";
  if (codeCount === 0) return "non-code";
  return "mixed";
}

export function buildGuidance(diffKind: DiffKind): string {
  switch (diffKind) {
    case "empty":
      return "No diff detected. Re-run after staging or committing the changes you want reviewed.";
    case "generated":
      return "Generated churn detected. Start with scan; only escalate if the generated output looks suspicious or should reflect a deliberate source change.";
    case "non-code":
      return "Non-code changes can still carry correctness risk. Start with scan or focused review rather than assuming they are low value.";
    case "mixed":
      return "Mixed code and non-code changes usually need focused or deep review because documentation or config may explain or constrain the code change.";
    case "code":
      return "Code changes usually deserve focused or deep review, depending on how cross-cutting the diff is.";
    default: {
      const _exhaustive: never = diffKind;
      return _exhaustive;
    }
  }
}

/**
 * Build review depth suggestions with estimated wall-clock durations.
 *
 * Estimates account for CLI cold start (~16s) plus per-file overhead.
 * These are approximate expected times, not timeout budgets.
 */
export function buildSuggestions(stat: DiffStat, diffKind: DiffKind = "code"): AssessSuggestion[] {
  const focusedDescription = diffKind === "generated"
    ? "Reads changed files for context. Useful only when generated churn may hide a real source or config issue."
    : diffKind === "non-code"
      ? "Reads changed files for context. Good fit for docs, config, or workflow changes where wording and correctness matter."
      : "Reads changed files for context. Does not trace imports or check tests.";

  const deepDescription = diffKind === "generated"
    ? "Full repo exploration. Usually unnecessary for generated-only churn unless the output looks inconsistent with the intended source change."
    : diffKind === "mixed"
      ? "Full repo exploration. Best when code changes and supporting docs/config should be validated together."
      : "Full repo exploration: follows imports, checks tests, reads project conventions.";

  return [
    {
      depth: "scan",
      estimatedSeconds: 30,
      description: "Diff-only, no repo exploration. Fast single-pass review.",
    },
    {
      depth: "focused",
      estimatedSeconds: Math.min(30 + 10 * stat.files, 240),
      description: focusedDescription,
    },
    {
      depth: "deep",
      estimatedSeconds: Math.min(60 + 25 * stat.files, 1200),
      description: deepDescription,
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
  const diffKind = classifyDiffKind(changedFiles);
  const guidance = buildGuidance(diffKind);
  const suggestions = buildSuggestions(diffStat, diffKind);

  return {
    diffStat,
    changedFiles,
    complexity,
    diffKind,
    guidance,
    suggestions,
    resolvedCwd: cwd,
  };
}
