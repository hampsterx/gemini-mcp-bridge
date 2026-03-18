import { spawnGemini } from "../utils/spawn.js";
import { parseGeminiOutput } from "../utils/parse.js";
import { getGitRoot, getUncommittedDiff, getBranchDiff } from "../utils/git.js";
import { verifyDirectory } from "../utils/security.js";

export interface ReviewInput {
  uncommitted?: boolean;
  base?: string;
  focus?: string;
  quick?: boolean;
  workingDirectory?: string;
  timeout?: number;
}

export interface ReviewResult {
  response: string;
  diffSource: "uncommitted" | "branch";
  base?: string;
  mode: "agentic" | "quick";
  timedOut: boolean;
}

/** Default timeout for agentic review (CLI explores the repo with all tools). */
const AGENTIC_TIMEOUT = 300_000;

/** Default timeout for quick review (diff-only, single pass). */
const QUICK_TIMEOUT = 120_000;

/**
 * Agentic review prompt. The CLI has full tool access (shell, file read,
 * grep, etc.) and will run git commands, read files, and explore the repo.
 */
function buildAgenticPrompt(diffSpec: string, focus?: string): string {
  const focusSection = focus
    ? `\n## Focus Area\n\nPay special attention to: ${focus}\n`
    : "";

  return `You are an expert code reviewer. You have access to tools that let you run shell commands, read files, search code, and list directories in this repository.

## Instructions

### Step 1: Gather Context

1. Run \`${diffSpec}\` to see the changes being reviewed.
2. Check the repo root for project instruction files (GEMINI.md, CLAUDE.md, AGENTS.md, COPILOT.md, .cursorrules, or similar). Read any that exist for project conventions and coding standards.
3. Read the FULL contents of each changed file (not just the diff hunks) to understand surrounding context.
4. For new imports, function calls, or type references in the diff, read the referenced files to understand interfaces and contracts.
5. Check if tests exist for the changed code. Read them to assess coverage.
6. Look for related configuration, type definitions, or documentation if relevant.

### Step 2: Review

For each issue found, provide:
- **Severity**: critical / warning / suggestion
- **File**: the file path
- **Line**: approximate line number
- **Issue**: clear description
- **Suggestion**: how to fix it

Focus on:
- Bugs and logic errors
- Security vulnerabilities
- Performance issues
- Missing error handling
- Whether tests adequately cover the changes
- Consistency with patterns in surrounding code and project conventions
${focusSection}
If the code looks good, say so briefly. Don't invent issues.`;
}

/**
 * Quick review prompt. Pre-computed diff, no repo exploration.
 */
function buildQuickPrompt(diff: string, focus?: string): string {
  const focusSection = focus
    ? `\n\nPay special attention to: ${focus}`
    : "";

  return `You are an expert code reviewer. Review the following git diff carefully.

For each issue found, provide:
- **Severity**: critical / warning / suggestion
- **File**: the file path
- **Line**: approximate line number (from the diff)
- **Issue**: clear description
- **Suggestion**: how to fix it

Focus on:
- Bugs and logic errors
- Security vulnerabilities
- Performance issues
- Missing error handling
- Code style issues (only if significant)
${focusSection}
If the code looks good, say so briefly. Don't invent issues.

---

${diff}`;
}

/**
 * Execute a code review.
 *
 * Default (agentic): Spawns Gemini CLI in yolo mode inside the repo. The CLI
 * runs git diff itself, reads full files, follows imports, checks tests, and
 * reads project instruction files (CLAUDE.md, GEMINI.md, etc.). No diff is
 * pre-computed; the CLI does everything.
 *
 * Quick mode: Pre-computes the diff in TypeScript and sends it as text.
 * Faster, single-pass, no repo exploration.
 */
export async function executeReview(input: ReviewInput): Promise<ReviewResult> {
  const { uncommitted = true, base, focus, quick = false } = input;
  const defaultTimeout = quick ? QUICK_TIMEOUT : AGENTIC_TIMEOUT;
  const timeout = input.timeout ?? defaultTimeout;

  // Resolve to git root
  const requestedDir = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();
  const cwd = getGitRoot(requestedDir);

  if (quick) {
    return executeQuickReview({ cwd, uncommitted, base, focus, timeout });
  }

  return executeAgenticReview({ cwd, uncommitted, base, focus, timeout });
}

interface InternalReviewInput {
  cwd: string;
  uncommitted: boolean;
  base?: string;
  focus?: string;
  timeout: number;
}

/**
 * Agentic review: CLI runs with full tool access inside the repo.
 *
 * Uses --yolo for shell access. We ship a policy TOML (policies/review.toml)
 * that restricts shell to read-only git commands, but Gemini CLI has a bug
 * where headless mode strips run_shell_command before the policy engine
 * evaluates (google-gemini/gemini-cli#20469, fix PR #20639 merged but not
 * yet released as of v0.33.2). Once that fix ships, we'll switch from
 * --yolo to --policy + --approval-mode auto_edit for tighter control.
 */
async function executeAgenticReview(input: InternalReviewInput): Promise<ReviewResult> {
  const { cwd, uncommitted, base, focus, timeout } = input;

  // Build the git diff command for the prompt (CLI will run it)
  let diffSpec: string;
  let diffSource: ReviewResult["diffSource"];

  if (base) {
    if (!/^[\w./-]+$/.test(base)) {
      throw new Error(`Invalid base ref: "${base}" — must be a valid git ref (alphanumeric, -, _, /, .)`);
    }
    diffSpec = `git diff ${base}...HEAD -U5`;
    diffSource = "branch";
  } else if (uncommitted) {
    diffSpec = "git diff HEAD -U5";
    diffSource = "uncommitted";
  } else {
    throw new Error("Either 'uncommitted' must be true or 'base' must be specified");
  }

  // Early exit if there's nothing to review (avoids spawning a model session)
  try {
    const diff = base ? getBranchDiff(cwd, base) : getUncommittedDiff(cwd);
    if (!diff.trim()) {
      return {
        response: base
          ? `No diff found between ${base} and HEAD.`
          : "No uncommitted changes found.",
        diffSource,
        base,
        mode: "agentic",
        timedOut: false,
      };
    }
  } catch (e) {
    if (e instanceof Error && (e.message.includes("No uncommitted changes") || e.message.includes("No diff found"))) {
      return {
        response: e.message,
        diffSource,
        base,
        mode: "agentic",
        timedOut: false,
      };
    }
    throw e;
  }

  const prompt = buildAgenticPrompt(diffSpec, focus);

  const result = await spawnGemini({
    args: [
      "--yolo",
      "--output-format", "json",
    ],
    cwd,
    stdin: prompt,
    timeout,
  });

  if (result.timedOut) {
    return {
      response: `Review timed out after ${timeout / 1000}s. Try with quick: true for a faster, diff-only review.`,
      diffSource,
      base,
      mode: "agentic",
      timedOut: true,
    };
  }

  if (result.exitCode !== 0 && result.stderr) {
    const stderr = result.stderr.toLowerCase();
    if (stderr.includes("auth") || stderr.includes("credential")) {
      throw new Error(
        `Gemini CLI authentication error. Run: gemini auth login\n\nDetails: ${result.stderr.trim()}`,
      );
    }
  }

  const parsed = parseGeminiOutput(result.stdout, result.stderr);

  return {
    response: parsed.response,
    diffSource,
    base,
    mode: "agentic",
    timedOut: false,
  };
}

/**
 * Quick review: pre-computed diff, single-pass, no repo exploration.
 */
async function executeQuickReview(input: InternalReviewInput): Promise<ReviewResult> {
  const { cwd, uncommitted, base, focus, timeout } = input;

  let diff: string;
  let diffSource: ReviewResult["diffSource"];

  try {
    if (base) {
      diff = getBranchDiff(cwd, base);
      diffSource = "branch";
    } else if (uncommitted) {
      diff = getUncommittedDiff(cwd);
      diffSource = "uncommitted";
    } else {
      throw new Error("Either 'uncommitted' must be true or 'base' must be specified");
    }
  } catch (e) {
    if (e instanceof Error && (e.message.includes("No uncommitted changes") || e.message.includes("No diff found"))) {
      return {
        response: e.message,
        diffSource: base ? "branch" : "uncommitted",
        base,
        mode: "quick",
        timedOut: false,
      };
    }
    throw e;
  }

  const fullPrompt = buildQuickPrompt(diff, focus);

  const result = await spawnGemini({
    args: ["--output-format", "json"],
    cwd,
    stdin: fullPrompt,
    timeout,
  });

  if (result.timedOut) {
    return {
      response: `Review timed out after ${timeout / 1000}s. The diff may be too large. Try reviewing a smaller scope.`,
      diffSource,
      base,
      mode: "quick",
      timedOut: true,
    };
  }

  if (result.exitCode !== 0 && result.stderr) {
    const stderr = result.stderr.toLowerCase();
    if (stderr.includes("auth") || stderr.includes("credential")) {
      throw new Error(
        `Gemini CLI authentication error. Run: gemini auth login\n\nDetails: ${result.stderr.trim()}`,
      );
    }
  }

  const parsed = parseGeminiOutput(result.stdout, result.stderr);

  return {
    response: parsed.response,
    diffSource,
    base,
    mode: "quick",
    timedOut: false,
  };
}
