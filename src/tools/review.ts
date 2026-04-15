import { spawnGemini } from "../utils/spawn.js";
import {
  parseStreamJson,
  tryParsePartial,
  extractCapacityFailure,
  type CapacityFailure,
  OUTPUT_FORMAT,
} from "../utils/parse.js";
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

/** Review depth tier. Callers pick based on diff size + how much context they want. */
export type ReviewDepth = "scan" | "focused" | "deep";

export interface ReviewInput {
  uncommitted?: boolean;
  base?: string;
  focus?: string;
  /** Review depth. Takes precedence over `quick` when both are set. Default: "deep". */
  depth?: ReviewDepth;
  /** @deprecated Use `depth` instead. `quick: true` maps to `depth: "scan"`; `quick: false` maps to `depth: "deep"`. */
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
  /**
   * Actual depth the review ran at. Breaking change from v0.3.0, which used
   * `"agentic" | "quick"`.
   */
  mode: ReviewDepth;
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
  /** True when appliedTimeout came from diff-size auto-scaling (focused/deep only, no caller override). */
  timeoutScaled: boolean;
  /** Present when the requested review could not complete because Gemini returned a capacity-related failure. */
  capacityFailure?: CapacityFailure;
}

// --- Timeout constants ---

/** Scan (shallow diff-only review) uses a constant timeout. */
export const SCAN_TIMEOUT = 180_000;

/** Back-compat alias — exported under the old name so existing callers keep working. */
export const QUICK_TIMEOUT = SCAN_TIMEOUT;

/** Fallback timeout for focused review when the diff stat is unavailable. */
export const FOCUSED_FALLBACK_TIMEOUT = 240_000;

/** Fallback default timeout for deep review when the diff stat can't be computed. */
export const AGENTIC_TIMEOUT = 600_000;

// Focused scaling: base + per-file, capped.
const FOCUSED_BASE_MS = 120_000;
const FOCUSED_PER_FILE_MS = 15_000;
const FOCUSED_CAP_MS = 300_000;

// Deep scaling: more generous than focused because the CLI explores the whole repo.
const DEEP_BASE_MS = 240_000;
const DEEP_PER_FILE_MS = 45_000;

/**
 * Compute the timeout budget for a given depth from the diff stat.
 *
 * - `scan`: constant `SCAN_TIMEOUT`, independent of diff size.
 * - `focused`: `120s + 15s * files`, capped at 300s. Reading changed files is
 *   cheaper than full agentic exploration, but larger diffs still need more room.
 * - `deep`: `240s + 45s * files`, capped at `HARD_TIMEOUT_CAP`. Covers the CLI
 *   cold start plus generous per-file budget for the exploration the agent
 *   does (reads, greps, follows imports, checks tests).
 *
 * The caller explicitly picked their depth, so scaling matches that choice.
 */
export function scaleTimeoutForDepth(depth: ReviewDepth, stat: DiffStat): number {
  switch (depth) {
    case "scan":
      return SCAN_TIMEOUT;
    case "focused":
      return Math.min(FOCUSED_BASE_MS + FOCUSED_PER_FILE_MS * stat.files, FOCUSED_CAP_MS);
    case "deep":
      return Math.min(DEEP_BASE_MS + DEEP_PER_FILE_MS * stat.files, HARD_TIMEOUT_CAP);
    default: {
      const _exhaustive: never = depth;
      throw new Error(`Unknown review depth: ${_exhaustive as string}`);
    }
  }
}

/** Fallback timeout when the diff stat is unavailable. */
export function defaultTimeoutForDepth(depth: ReviewDepth): number {
  switch (depth) {
    case "scan":
      return SCAN_TIMEOUT;
    case "focused":
      return FOCUSED_FALLBACK_TIMEOUT;
    case "deep":
      return AGENTIC_TIMEOUT;
    default: {
      const _exhaustive: never = depth;
      throw new Error(`Unknown review depth: ${_exhaustive as string}`);
    }
  }
}

// --- Prompt builders ---

/**
 * Deep (agentic) review prompt. The CLI has full tool access (shell, file read,
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
 * Scan review prompt. Pre-computed diff, no repo exploration.
 */
export function buildQuickPrompt(diff: string, focus?: string, maxResponseLength?: number): string {
  return loadPrompt("review-quick.md", {
    DIFF: diff,
    FOCUS_SECTION: focus ? `Pay special attention to: ${focus}` : "",
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength),
  });
}

/**
 * Focused review prompt. Pre-computed diff + instructions to read changed files
 * only. The CLI spawns in plan mode (no `--yolo`), so Gemini has read_file /
 * grep_search / list_directory but no shell. Containment to changed files is
 * prompt-driven, not CLI-enforced.
 */
export function buildFocusedPrompt(diff: string, focus?: string, maxResponseLength?: number): string {
  return loadPrompt("review-focused.md", {
    DIFF: diff,
    FOCUS_SECTION: focus ? `Pay special attention to: ${focus}` : "",
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength),
  });
}

// --- Depth resolution ---

/**
 * Resolve the requested depth from input. `depth` wins over `quick` when both
 * are set. Legacy mapping: `quick: true` -> `"scan"`, `quick: false` or unset
 * -> `"deep"`.
 */
export function resolveDepth(input: { depth?: ReviewDepth; quick?: boolean }): ReviewDepth {
  if (input.depth) return input.depth;
  if (input.quick === true) return "scan";
  return "deep";
}

// --- Public entry ---

/**
 * Execute a code review at the requested depth.
 *
 * Depths:
 * - `scan`: diff-only, single-pass, no repo exploration. Fastest, shallowest.
 * - `focused`: diff + CLI reads changed files (plan mode, no shell). Medium.
 * - `deep` (default): full agentic exploration with `--yolo`. CLI runs git
 *   itself, follows imports, checks tests, reads project instruction files.
 */
export async function executeReview(input: ReviewInput): Promise<ReviewResult> {
  const { uncommitted = true, base, focus, maxResponseLength } = input;
  const model = resolveModel(input.model);
  const depth = resolveDepth(input);

  // Resolve to git root
  const requestedDir = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();
  const cwd = getGitRoot(requestedDir);

  // Compute the diff stat up-front so the result can report it and the depth
  // can scale its timeout. Failures are non-fatal — we fall back to the
  // per-depth static default.
  const diffSpec: DiffSpec = base ? { type: "branch", base } : { type: "uncommitted" };
  let diffStat: DiffStat | undefined;
  try {
    diffStat = getDiffStat(cwd, diffSpec);
  } catch {
    diffStat = undefined;
  }

  // Timeout selection:
  //   - caller-supplied timeout always wins (capped at HARD_TIMEOUT_CAP)
  //   - else scale from diff stat when available
  //   - else fall back to the per-depth default
  // `timeoutScaled` tracks whether the value came from size-based scaling;
  // scan is a constant regardless of diff size, so it never counts as "scaled".
  let appliedTimeout: number;
  let timeoutScaled = false;
  if (input.timeout !== undefined) {
    appliedTimeout = Math.min(input.timeout, HARD_TIMEOUT_CAP);
  } else if (diffStat) {
    appliedTimeout = scaleTimeoutForDepth(depth, diffStat);
    timeoutScaled = depth !== "scan";
  } else {
    appliedTimeout = defaultTimeoutForDepth(depth);
  }

  return runReview(depth, {
    cwd,
    uncommitted,
    base,
    focus,
    model,
    timeout: appliedTimeout,
    maxResponseLength,
    diffStat,
    timeoutScaled,
  });
}

// --- Shared execution path ---

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

interface ReviewMeta {
  appliedTimeout: number;
  timeoutScaled: boolean;
  diffStat?: DiffStat;
}

/**
 * Unified review runner. Per-depth config selects the prompt template and
 * whether to spawn in yolo (full tool access, deep only) or plan mode (scan,
 * focused). The diff is always pre-computed in TypeScript: scan/focused
 * inline it in the prompt, deep mode inlines only the diff-spec command and
 * the CLI runs git itself.
 */
async function runReview(
  depth: ReviewDepth,
  input: InternalReviewInput,
): Promise<ReviewResult> {
  const { cwd, uncommitted, base, focus, model, timeout, maxResponseLength, diffStat, timeoutScaled } = input;
  const meta: ReviewMeta = { appliedTimeout: timeout, timeoutScaled, diffStat };

  // Validate / resolve diff source
  let diffSource: ReviewResult["diffSource"];
  if (base) {
    if (!/^[\w./-]+$/.test(base)) {
      throw new Error(`Invalid base ref: "${base}" — must be a valid git ref (alphanumeric, -, _, /, .)`);
    }
    diffSource = "branch";
  } else if (uncommitted) {
    diffSource = "uncommitted";
  } else {
    throw new Error("Either 'uncommitted' must be true or 'base' must be specified");
  }

  // Compute the diff once. Used for early-exit detection across all depths,
  // and inlined into the prompt for scan / focused.
  let diff: string;
  try {
    diff = base ? getBranchDiff(cwd, base) : getUncommittedDiff(cwd);
  } catch (e) {
    if (isNoChangesError(e)) {
      return emptyResult(depth, diffSource, base, cwd, meta, (e as Error).message);
    }
    throw e;
  }
  if (!diff.trim()) {
    const msg = base
      ? `No diff found between ${base} and HEAD.`
      : "No uncommitted changes found.";
    return emptyResult(depth, diffSource, base, cwd, meta, msg);
  }

  // Build per-depth prompt + yolo flag.
  let prompt: string;
  let useYolo: boolean;
  if (depth === "deep") {
    const diffSpec = base ? `git diff ${base}...HEAD -U5` : "git diff HEAD -U5";
    prompt = buildAgenticPrompt(diffSpec, focus, maxResponseLength);
    useYolo = true;
  } else if (depth === "focused") {
    prompt = buildFocusedPrompt(diff, focus, maxResponseLength);
    useYolo = false;
  } else {
    prompt = buildQuickPrompt(diff, focus, maxResponseLength);
    useYolo = false;
  }

  const spawnOnce = (m: string | undefined, t: number) => {
    const args: string[] = [];
    if (useYolo) args.push("--yolo");
    if (m) args.push("--model", m);
    args.push("--output-format", OUTPUT_FORMAT);
    return spawnGemini({ args, cwd, stdin: prompt, timeout: t });
  };

  const fallbackResult = depth === "deep"
    ? {
        result: await spawnOnce(model, timeout),
        fallbackUsed: false,
        fallbackModel: undefined,
      }
    : await withModelFallback(model, spawnOnce, timeout);

  const { result, fallbackUsed, fallbackModel } = fallbackResult;
  const actualModel = fallbackUsed ? fallbackModel : model;

  if (result.timedOut) {
    const partial = tryParsePartial(result.stdout, result.stderr, timeout);
    // Annotate only for depths that have a shallower alternative. Scan has no
    // shallower option so the "consider depth: scan" hint would be nonsense.
    const response = depth === "scan"
      ? partial.text
      : annotatePartialWithStat(partial.text, diffStat);
    return {
      response,
      diffSource,
      base,
      mode: depth,
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      timedOut: true,
      resolvedCwd: cwd,
      ...meta,
    };
  }

  const capacityFailure = result.exitCode !== 0
    ? extractCapacityFailure(result.stderr)
    : null;
  if (depth === "deep" && capacityFailure && result.exitCode !== 0) {
    return {
      response: buildCapacityFailureMessage(depth, capacityFailure),
      diffSource,
      base,
      mode: depth,
      model: actualModel,
      fallbackUsed: undefined,
      timedOut: false,
      resolvedCwd: cwd,
      capacityFailure,
      ...meta,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseStreamJson(result.stdout, result.stderr);

  return {
    response: parsed.response,
    diffSource,
    base,
    mode: depth,
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    timedOut: false,
    resolvedCwd: cwd,
    ...meta,
  };
}

function isNoChangesError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.message.includes("No uncommitted changes") || e.message.includes("No diff found");
}

function emptyResult(
  depth: ReviewDepth,
  diffSource: ReviewResult["diffSource"],
  base: string | undefined,
  cwd: string,
  meta: ReviewMeta,
  message: string,
): ReviewResult {
  return {
    response: message,
    diffSource,
    base,
    mode: depth,
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
  const replacement = `[Partial response, timed out after ${seconds}s on ${diffStat.files}-file diff (+${diffStat.insertions} / -${diffStat.deletions}); consider depth: "scan" or narrow the base]`;
  return partialText.replace(match[0], replacement);
}

function buildCapacityFailureMessage(depth: ReviewDepth, failure: CapacityFailure): string {
  const code = failure.statusCode ? ` (${failure.statusCode})` : "";
  return [
    `The requested ${depth} review could not be completed because Gemini returned a capacity-related failure: ${failure.kind}${code}.`,
    "No internal retry or fallback was attempted so the caller can decide whether to retry later or downgrade the review depth.",
    `Details: ${failure.message}`,
  ].join("\n\n");
}
