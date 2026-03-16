import { spawnGemini } from "../utils/spawn.js";
import { parseGeminiOutput } from "../utils/parse.js";
import { getGitRoot, getUncommittedDiff, getBranchDiff } from "../utils/git.js";
import { verifyDirectory } from "../utils/security.js";

export interface ReviewInput {
  uncommitted?: boolean;
  base?: string;
  workingDirectory?: string;
  timeout?: number;
}

export interface ReviewResult {
  response: string;
  diffSource: "uncommitted" | "branch";
  base?: string;
  timedOut: boolean;
}

const REVIEW_PROMPT = `You are an expert code reviewer. Review the following git diff carefully.

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

If the code looks good, say so briefly. Don't invent issues.

---

`;

/**
 * Execute a code review by computing a git diff and sending it to Gemini.
 * Native mode only (no extension dependency).
 */
export async function executeReview(input: ReviewInput): Promise<ReviewResult> {
  const { uncommitted = true, base, timeout = 120_000 } = input;

  // Resolve to git root
  const requestedDir = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();
  const cwd = getGitRoot(requestedDir);

  // Get the diff
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
        timedOut: false,
      };
    }
    throw e;
  }

  const fullPrompt = REVIEW_PROMPT + diff;

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
    timedOut: false,
  };
}
