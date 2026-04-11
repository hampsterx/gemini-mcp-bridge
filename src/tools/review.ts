import { spawnGemini } from "../utils/spawn.js";
import { parseStreamJson, tryParsePartial, OUTPUT_FORMAT } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import { loadPrompt, buildLengthLimit } from "../utils/prompts.js";
import {
  getGitRoot,
  getUncommittedDiff,
  getBranchDiff,
  getDiffStat,
  type DiffStat,
  type DiffSpec,
} from "../utils/git.js";
import { verifyDirectory } from "../utils/security.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";

export interface ReviewInput {
  uncommitted?: boolean;
  base?: string;
  focus?: string;
  quick?: boolean;
  model?: string;
  workingDirectory?: string;
  timeout?: number;
  maxResponseLength?: number;
}

export interface ReviewResult {
  response: string;
  diffSource: "uncommitted" | "branch";
  base?: string;
  mode: "agentic" | "quick";
  /** Actual model used (reflects fallback if quota exhausted). */
  model?: string;
  fallbackUsed?: boolean;
  timedOut: boolean;
  /** The directory the CLI actually ran in (after git root resolution). */
  resolvedCwd: string;
  /** Diff size stats (files/insertions/deletions) when available. */
  diffStat?: DiffStat;
  /** Timeout actually applied to the spawn (ms), including any dynamic scaling. */
  appliedTimeout: number;
  /** True when appliedTimeout came from diff-size auto-scaling (agentic only, no caller override). */
  timeoutScaled: boolean;
}

/**
 * Fallback default timeout for agentic review when the diff stat can't be
 * computed. Normal path auto-scales via scaleAgenticTimeout().
 */
export const AGENTIC_TIMEOUT = 600_000;

/** Default timeout for quick review (diff-only, single pass). */
export const QUICK_TIMEOUT = 180_000;

/** Baseline budget covering CLI cold start + one small-diff review. */
const AGENTIC_BASE_MS = 180_000;

/** Per-file increment covering extra read/grep tool calls as the diff grows. */
const AGENTIC_PER_FILE_MS = 30_000;

/**
 * Map diff size (file count) to an agentic-review timeout budget.
 *
 * Linear scaling: `base + per_file * files`, capped at HARD_TIMEOUT_CAP.
 * The baseline covers the CLI cold start (~16s) plus one small-diff
 * review; each additional file adds budget for the extra tool calls the
 * agent makes exploring context. Caller-supplied timeout still wins.
 *
 * File count isn't a perfect signal (30 YAML lines ≠ 30 TypeScript files
 * with deep imports), so this is deliberately generous. The caller can
 * always pass an explicit `timeout` to override.
 */
export function scaleAgenticTimeout(stat: DiffStat): number {
  return Math.min(AGENTIC_BASE_MS + AGENTIC_PER_FILE_MS * stat.files, HARD_TIMEOUT_CAP);
}

/**
 * Agentic review prompt. The CLI has full tool access (shell, file read,
 * grep, etc.) and will run git commands, read files, and explore the repo.
 */
export function buildAgenticPrompt(diffSpec: string, focus?: string, maxResponseLength?: number): string {
  return loadPrompt("review-agentic.md", {
    DIFF_SPEC: diffSpec,
    FOCUS_SECTION: focus ? `## Focus Area\n\nPay special attention to: ${focus}` : "",
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength),
  });
}

/**
 * Quick review prompt. Pre-computed diff, no repo exploration.
 */
export function buildQuickPrompt(diff: string, focus?: string, maxResponseLength?: number): string {
  return loadPrompt("review-quick.md", {
    DIFF: diff,
    FOCUS_SECTION: focus ? `Pay special attention to: ${focus}` : "",
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength),
  });
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
  const { uncommitted = true, base, focus, quick = false, maxResponseLength } = input;
  const model = resolveModel(input.model);

  // Resolve to git root
  const requestedDir = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();
  const cwd = getGitRoot(requestedDir);

  // Compute the diff stat up-front so both modes can report it and agentic
  // mode can scale its timeout. Failures are non-fatal — we fall back to the
  // static default.
  const diffSpec: DiffSpec = base ? { type: "branch", base } : { type: "uncommitted" };
  let diffStat: DiffStat | undefined;
  try {
    diffStat = getDiffStat(cwd, diffSpec);
  } catch {
    diffStat = undefined;
  }

  // Timeout selection:
  //   - caller-supplied timeout always wins (capped at HARD_TIMEOUT_CAP)
  //   - quick mode uses the static QUICK_TIMEOUT
  //   - agentic mode scales from diff stat, or falls back to AGENTIC_TIMEOUT
  let appliedTimeout: number;
  let timeoutScaled = false;
  if (input.timeout !== undefined) {
    appliedTimeout = Math.min(input.timeout, HARD_TIMEOUT_CAP);
  } else if (quick) {
    appliedTimeout = QUICK_TIMEOUT;
  } else if (diffStat) {
    appliedTimeout = scaleAgenticTimeout(diffStat);
    timeoutScaled = true;
  } else {
    appliedTimeout = AGENTIC_TIMEOUT;
  }

  const shared = {
    cwd,
    uncommitted,
    base,
    focus,
    model,
    timeout: appliedTimeout,
    maxResponseLength,
    diffStat,
    timeoutScaled,
  };

  if (quick) {
    return executeQuickReview(shared);
  }

  return executeAgenticReview(shared);
}

interface InternalReviewInput {
  cwd: string;
  uncommitted: boolean;
  base?: string;
  focus?: string;
  model?: string;
  timeout: number;
  maxResponseLength?: number;
  diffStat?: DiffStat;
  timeoutScaled: boolean;
}

/**
 * Agentic review: CLI runs with full tool access inside the repo.
 *
 * Uses --yolo for shell access. We ship a policy TOML (policies/review.toml)
 * that restricts shell to read-only git commands. The CLI bug that prevented
 * policy enforcement in headless mode (#20469) is fixed in v0.35.3.
 * TODO: Switch from --yolo to --yolo --policy for constrained shell access.
 */
async function executeAgenticReview(input: InternalReviewInput): Promise<ReviewResult> {
  const { cwd, uncommitted, base, focus, model, timeout, maxResponseLength, diffStat, timeoutScaled } = input;
  const meta = { appliedTimeout: timeout, timeoutScaled, diffStat };

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
        resolvedCwd: cwd,
        ...meta,
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
        resolvedCwd: cwd,
        ...meta,
      };
    }
    throw e;
  }

  const prompt = buildAgenticPrompt(diffSpec, focus, maxResponseLength);

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      const args: string[] = ["--yolo"];
      if (m) args.push("--model", m);
      args.push("--output-format", OUTPUT_FORMAT);
      return spawnGemini({ args, cwd, stdin: prompt, timeout: t });
    },
    timeout,
  );

  const actualModel = fallbackUsed ? fallbackModel : model;

  if (result.timedOut) {
    const partial = tryParsePartial(result.stdout, result.stderr, timeout);
    return {
      response: annotatePartialWithStat(partial.text, diffStat),
      diffSource,
      base,
      mode: "agentic",
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      timedOut: true,
      resolvedCwd: cwd,
      ...meta,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseStreamJson(result.stdout, result.stderr);

  return {
    response: parsed.response,
    diffSource,
    base,
    mode: "agentic",
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    timedOut: false,
    resolvedCwd: cwd,
    ...meta,
  };
}

/**
 * Replace the standard `[Partial response, timed out after Xs]` prefix with a
 * fatter version that includes the diff size and an actionable hint. We post-
 * process here rather than threading stat into parse.ts so parse.ts stays
 * ignorant of review-specific context.
 */
function annotatePartialWithStat(partialText: string, diffStat?: DiffStat): string {
  if (!diffStat) return partialText;
  const match = partialText.match(/^\[Partial response, timed out after (\d+)s\]/);
  if (!match) return partialText;
  const seconds = match[1];
  const replacement = `[Partial response, timed out after ${seconds}s on ${diffStat.files}-file diff (+${diffStat.insertions} / -${diffStat.deletions}); consider quick: true or narrow the base]`;
  return partialText.replace(match[0], replacement);
}

/**
 * Quick review: pre-computed diff, single-pass, no repo exploration.
 */
async function executeQuickReview(input: InternalReviewInput): Promise<ReviewResult> {
  const { cwd, uncommitted, base, focus, model, timeout, maxResponseLength, diffStat, timeoutScaled } = input;
  const meta = { appliedTimeout: timeout, timeoutScaled, diffStat };

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
        resolvedCwd: cwd,
        ...meta,
      };
    }
    throw e;
  }

  const fullPrompt = buildQuickPrompt(diff, focus, maxResponseLength);

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      const args: string[] = [];
      if (m) args.push("--model", m);
      args.push("--output-format", OUTPUT_FORMAT);
      return spawnGemini({ args, cwd, stdin: fullPrompt, timeout: t });
    },
    timeout,
  );

  const actualModel = fallbackUsed ? fallbackModel : model;

  if (result.timedOut) {
    const partial = tryParsePartial(result.stdout, result.stderr, timeout);
    return {
      response: partial.text,
      diffSource,
      base,
      mode: "quick",
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      timedOut: true,
      resolvedCwd: cwd,
      ...meta,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseStreamJson(result.stdout, result.stderr);

  return {
    response: parsed.response,
    diffSource,
    base,
    mode: "quick",
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    timedOut: false,
    resolvedCwd: cwd,
    ...meta,
  };
}
