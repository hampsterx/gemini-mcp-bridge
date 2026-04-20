import { spawnGemini } from "../utils/spawn.js";
import { parseStreamJson, tryParsePartial, OUTPUT_FORMAT } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import {
  isImageFile,
  MAX_IMAGE_FILE_SIZE,
  verifyFilePaths,
  buildFileHints,
} from "../utils/files.js";
import { appendLengthLimit, buildLengthLimit, loadPrompt } from "../utils/prompts.js";
import { resolveAndVerify, checkFileSize, verifyDirectory, MAX_FILES } from "../utils/security.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";
import {
  parseChangeModeOutput,
  ChangeModeParseError,
  type ChangeModeEdit,
} from "../utils/changeMode.js";
import { snapshotWorkdir, diffSnapshots } from "../utils/workdirSnapshot.js";

export interface QueryInput {
  prompt: string;
  files?: string[];
  model?: string;
  workingDirectory?: string;
  timeout?: number;
  maxResponseLength?: number;
  /**
   * When true, the query runs in change mode: Gemini is instructed to emit
   * structured `**FILE:` edit blocks instead of prose. The response is parsed
   * into `edits` on success, and a pre/post-spawn guardrail detects any file
   * writes the model might attempt. Text-only for v1 (image files rejected).
   */
  changeMode?: boolean;
}

export interface QueryResult {
  response: string;
  model?: string;
  fallbackUsed?: boolean;
  /** File paths passed as @{path} hints (Gemini may or may not have read them). */
  filesIncluded: string[];
  filesSkipped: string[];
  imagesIncluded: string[];
  timedOut: boolean;
  /** The directory the CLI actually ran in. */
  resolvedCwd: string;
  /** Structured edits, populated only when `changeMode` is on AND parse + guardrail succeed. */
  edits?: ChangeModeEdit[];
  /**
   * True when the change-mode guardrail detected that Gemini mutated files
   * during the spawn. When true, `edits` is intentionally omitted so the
   * caller can't re-apply half-applied state.
   */
  appliedWrites?: boolean;
  /** Present when change mode did not produce structured edits (timeout, parse failure, or writes detected). */
  warning?: string;
}

/**
 * Default timeout for agentic queries. Plan mode boots the tool system
 * (~16s cold start), so 120s is the minimum useful default.
 */
const AGENTIC_QUERY_TIMEOUT = 120_000;

/**
 * Execute an agentic query against Gemini CLI.
 *
 * Text queries run under --approval-mode plan (read-only agentic).
 * Image queries run under --yolo (CLI needs native pixel access).
 * Change-mode queries run in default agentic mode (no approval flag) with a
 * pre/post-spawn workdir snapshot guardrail. See `executeChangeModeQuery`.
 * In all cases, text files are passed as @{path} hints, not inlined.
 */
export async function executeQuery(input: QueryInput): Promise<QueryResult> {
  const { prompt, files = [], timeout, maxResponseLength, changeMode } = input;
  const model = resolveModel(input.model);

  // Resolve working directory
  const cwd = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();

  if (files.length > MAX_FILES) {
    throw new Error(`Too many files: ${files.length} (max ${MAX_FILES})`);
  }

  // Partition files into text and image
  const textFiles = files.filter((f) => !isImageFile(f));
  const imageFiles = files.filter((f) => isImageFile(f));

  if (changeMode) {
    if (imageFiles.length > 0) {
      throw new Error(
        "changeMode does not support image files. Use a text-only query.",
      );
    }
    return executeChangeModeQuery({ prompt, textFiles, model, timeout, cwd, maxResponseLength });
  }

  if (imageFiles.length > 0) {
    return executeImageQuery({ prompt, textFiles, imageFiles, model, timeout, cwd, maxResponseLength });
  }

  return executePlanQuery({ prompt, textFiles, model, timeout, cwd, maxResponseLength });
}

interface PlanQueryInput {
  prompt: string;
  textFiles: string[];
  model?: string;
  timeout?: number;
  cwd: string;
  maxResponseLength?: number;
}

interface ImageQueryInput extends PlanQueryInput {
  imageFiles: string[];
}

/**
 * Text query: agentic read-only mode (--approval-mode plan).
 * Files are passed as @{path} hints; Gemini reads them with its own tools.
 */
async function executePlanQuery(input: PlanQueryInput): Promise<QueryResult> {
  const { prompt, textFiles, model, timeout, cwd, maxResponseLength } = input;

  // Verify text file paths (fail-fast, CLI would also reject)
  const { verified, skipped } = textFiles.length > 0
    ? await verifyFilePaths(textFiles, cwd)
    : { verified: [] as string[], skipped: [] as string[] };

  const fullPrompt = appendLengthLimit(
    prompt + buildFileHints(verified),
    maxResponseLength,
  );

  const effectiveTimeout = Math.min(timeout ?? AGENTIC_QUERY_TIMEOUT, HARD_TIMEOUT_CAP);

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      const args: string[] = ["--approval-mode", "plan"];
      if (m) args.push("--model", m);
      args.push("--output-format", OUTPUT_FORMAT);
      return spawnGemini({ args, cwd, stdin: fullPrompt, timeout: t });
    },
    effectiveTimeout,
  );

  const actualModel = fallbackUsed ? fallbackModel : model;

  if (result.timedOut) {
    const partial = tryParsePartial(result.stdout, result.stderr, effectiveTimeout);
    return {
      response: partial.text,
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      filesIncluded: verified,
      filesSkipped: skipped,
      imagesIncluded: [],
      timedOut: true,
      resolvedCwd: cwd,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseStreamJson(result.stdout, result.stderr);

  return {
    response: parsed.response,
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    filesIncluded: verified,
    filesSkipped: skipped,
    imagesIncluded: [],
    timedOut: false,
    resolvedCwd: cwd,
  };
}

/**
 * Image query: agentic mode (--yolo) so the CLI reads images natively.
 * Text files are passed as @{path} hints, not inlined. Image files are
 * referenced by path with instructions for the CLI to read them.
 */
async function executeImageQuery(input: ImageQueryInput): Promise<QueryResult> {
  const { prompt, textFiles, imageFiles, model, timeout, cwd, maxResponseLength } = input;

  // Resolve and verify image paths (security + size check) in parallel
  const imageResults = await Promise.all(
    imageFiles.map(async (img) => {
      try {
        const resolved = await resolveAndVerify(img, cwd);
        const size = await checkFileSize(resolved);
        if (size > MAX_IMAGE_FILE_SIZE) {
          return { skipped: `${img}: ${(size / 1024).toFixed(0)}KB exceeds ${(MAX_IMAGE_FILE_SIZE / 1024).toFixed(0)}KB limit` };
        }
        return { resolved };
      } catch (err) {
        return { skipped: `${img}: ${(err as Error).message}` };
      }
    }),
  );
  const validImages = imageResults
    .map((r, i) => ({ ...r, original: imageFiles[i] }))
    .filter((r): r is { resolved: string; original: string } => "resolved" in r);
  const imageNames = validImages.map((r) => r.original);
  const skippedImages = imageResults.filter((r): r is { skipped: string } => "skipped" in r).map((r) => r.skipped);

  // Verify text file paths (fail-fast, no content reading)
  const { verified: verifiedText, skipped: skippedText } = textFiles.length > 0
    ? await verifyFilePaths(textFiles, cwd)
    : { verified: [] as string[], skipped: [] as string[] };

  // Build prompt: user prompt + text file hints + image instructions
  let fullPrompt = prompt + buildFileHints(verifiedText);

  const imagePart = imageNames
    .map((p) => `Read and analyze the image at: ${p}`)
    .join("\n");
  if (imageNames.length > 0) {
    fullPrompt += `\n\n## Image Files\n\n${imagePart}`;
  }

  fullPrompt = appendLengthLimit(fullPrompt, maxResponseLength);

  const effectiveTimeout = Math.min(timeout ?? AGENTIC_QUERY_TIMEOUT, HARD_TIMEOUT_CAP);

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      const args: string[] = [];
      if (imageNames.length > 0) {
        args.push("--yolo");
      } else {
        // All images failed verification; fall back to read-only agentic
        args.push("--approval-mode", "plan");
      }
      if (m) args.push("--model", m);
      args.push("--output-format", OUTPUT_FORMAT);
      return spawnGemini({ args, cwd, stdin: fullPrompt, timeout: t });
    },
    effectiveTimeout,
  );

  const actualModel = fallbackUsed ? fallbackModel : model;

  if (result.timedOut) {
    const partial = tryParsePartial(result.stdout, result.stderr, effectiveTimeout);
    return {
      response: partial.text,
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      filesIncluded: verifiedText,
      filesSkipped: [...skippedText, ...skippedImages],
      imagesIncluded: imageNames,
      timedOut: true,
      resolvedCwd: cwd,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseStreamJson(result.stdout, result.stderr);

  return {
    response: parsed.response,
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    filesIncluded: verifiedText,
    filesSkipped: [...skippedText, ...skippedImages],
    imagesIncluded: imageNames,
    timedOut: false,
    resolvedCwd: cwd,
  };
}

/**
 * Change-mode query: Gemini is asked to emit structured edit blocks instead
 * of prose.
 *
 * ## Trust model (layered, not a sandbox)
 *
 * Spawned with NO `--approval-mode` flag, which selects the CLI's `default`
 * approval mode. That's more privileged than `plan` (read-only) but less
 * than `--yolo` (auto-approve-everything): each write tool call is *meant*
 * to prompt for approval, and stdin is closed so any such prompt fails.
 * Plan mode isn't an option here because it refuses to emit edit blocks
 * (verified on CLI 0.38.0, 2026-04-20).
 *
 * Three mitigations stack:
 *   1. Prompt (`prompts/change-mode.md`): explicit "do NOT mutate files,
 *      use read-only tools only" instructions.
 *   2. CLI approval mode: default mode prompts on each write; piped stdin
 *      means approval never comes, so write tools should no-op.
 *   3. `workdirSnapshot` pre/post-spawn: detects mtime/size changes on
 *      tracked + existing-untracked files plus `git status --porcelain`
 *      drift. Any change sets `appliedWrites: true` and suppresses `edits`.
 *
 * Limits: the guardrail only watches files under `cwd` (the resolved
 * workingDirectory), does not watch gitignored paths (build output,
 * caches), and cannot detect network calls or spawned subprocesses. Treat
 * this as a detector, not a sandbox.
 *
 * ## Result shape
 *
 * - Timeout, no writes: partial prose + `warning: "Timeout before ..."`, no edits.
 * - Timeout, writes detected: partial prose + `appliedWrites: true` + write warning, no edits.
 * - Writes detected (non-timeout): raw response + `appliedWrites: true`, no edits.
 * - Parse failure: raw response + parse warning, no edits.
 * - Success: raw response + parsed `edits` array.
 */
async function executeChangeModeQuery(input: PlanQueryInput): Promise<QueryResult> {
  const { prompt, textFiles, model, timeout, cwd, maxResponseLength } = input;

  const { verified, skipped } = textFiles.length > 0
    ? await verifyFilePaths(textFiles, cwd)
    : { verified: [] as string[], skipped: [] as string[] };

  const filesSection = verified.length > 0
    ? `## Referenced files\n\n${verified.map((f) => `@{${f}}`).join("\n")}`
    : "";

  const fullPrompt = loadPrompt("change-mode.md", {
    PROMPT: prompt,
    FILES_SECTION: filesSection,
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength),
  });

  const effectiveTimeout = Math.min(timeout ?? AGENTIC_QUERY_TIMEOUT, HARD_TIMEOUT_CAP);

  // Capture workdir state before the spawn. A git-less working directory
  // means we can't enforce the guardrail, so refuse rather than giving the
  // caller a false sense of safety.
  let beforeSnapshot;
  try {
    beforeSnapshot = await snapshotWorkdir(cwd);
  } catch (e) {
    const msg = (e as Error).message;
    const prefix = /not a git repository/i.test(msg)
      ? "changeMode requires a git working directory for its write-guardrail"
      : "changeMode failed to capture pre-spawn workdir snapshot";
    throw new Error(`${prefix}: ${msg}`);
  }

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      const args: string[] = [];
      if (m) args.push("--model", m);
      args.push("--output-format", OUTPUT_FORMAT);
      return spawnGemini({ args, cwd, stdin: fullPrompt, timeout: t });
    },
    effectiveTimeout,
  );

  const actualModel = fallbackUsed ? fallbackModel : model;

  // Fail-closed guardrail: if the post-spawn snapshot itself throws, assume
  // Gemini may have corrupted the workdir and treat it as a write event.
  // Losing the `appliedWrites` signal because snapshotting failed would
  // defeat the whole point of the guardrail.
  let diff;
  let snapshotError: Error | undefined;
  try {
    const afterSnapshot = await snapshotWorkdir(cwd);
    diff = diffSnapshots(beforeSnapshot, afterSnapshot);
  } catch (e) {
    snapshotError = e as Error;
    diff = { changed: true, modified: [], appeared: [], disappeared: [], statusChanged: false };
  }

  const base = {
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    filesIncluded: verified,
    filesSkipped: skipped,
    imagesIncluded: [],
    resolvedCwd: cwd,
  };

  // Write detection wins over timeout: if Gemini mutated files AND the spawn
  // timed out, the caller must see `appliedWrites: true` so they don't treat
  // the workspace as untouched. Timeout-only (no writes) returns the
  // "Timeout before complete output" warning.
  if (result.timedOut && !diff.changed) {
    const partial = tryParsePartial(result.stdout, result.stderr, effectiveTimeout);
    return {
      ...base,
      response: partial.text,
      timedOut: true,
      warning: "Timeout before complete output",
    };
  }

  // Partial response capture for the timed-out-AND-wrote case. We skip the
  // error-pattern check since a timeout + file writes is not a normal exit.
  let responseText: string;
  if (result.timedOut) {
    responseText = tryParsePartial(result.stdout, result.stderr, effectiveTimeout).text;
  } else {
    checkErrorPatterns(result.exitCode, result.stderr);
    responseText = parseStreamJson(result.stdout, result.stderr).response;
  }

  if (diff.changed) {
    return {
      ...base,
      response: responseText,
      timedOut: result.timedOut,
      appliedWrites: true,
      warning: snapshotError
        ? `Post-spawn workdir snapshot failed (fail-closed): ${snapshotError.message}`
        : buildWriteWarning(diff),
    };
  }

  const parsed = { response: responseText };

  try {
    const { edits } = parseChangeModeOutput(parsed.response, { workingDirectory: cwd });
    return {
      ...base,
      response: parsed.response,
      timedOut: false,
      edits,
    };
  } catch (e) {
    const message = e instanceof ChangeModeParseError
      ? e.message
      : (e as Error).message;
    return {
      ...base,
      response: parsed.response,
      timedOut: false,
      warning: `Could not parse edits from response: ${message}`,
    };
  }
}

function buildWriteWarning(diff: {
  modified: string[];
  appeared: string[];
  disappeared: string[];
  statusChanged?: boolean;
}): string {
  const parts: string[] = [];
  if (diff.modified.length > 0) parts.push(`modified ${diff.modified.length}`);
  if (diff.appeared.length > 0) parts.push(`created ${diff.appeared.length}`);
  if (diff.disappeared.length > 0) parts.push(`deleted ${diff.disappeared.length}`);
  // Neutral fallback when statusChanged is the only signal: we can't tell
  // without parsing porcelain lines whether that was an untracked file, a
  // mode change, a staged/unstaged transition, etc. Say what we know.
  if (parts.length === 0 && diff.statusChanged) {
    parts.push("workdir status changed");
  }
  const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `Gemini wrote files${summary}; edits were not returned for safety`;
}
