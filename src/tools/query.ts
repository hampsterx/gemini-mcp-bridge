import { spawnGemini } from "../utils/spawn.js";
import { parseStreamJson, tryParsePartial, OUTPUT_FORMAT } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import {
  isImageFile,
  MAX_IMAGE_FILE_SIZE,
  verifyFilePaths,
  buildFileHints,
} from "../utils/files.js";
import { appendLengthLimit } from "../utils/prompts.js";
import { resolveAndVerify, checkFileSize, verifyDirectory, MAX_FILES } from "../utils/security.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";

export interface QueryInput {
  prompt: string;
  files?: string[];
  model?: string;
  workingDirectory?: string;
  timeout?: number;
  maxResponseLength?: number;
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
 * In both cases, text files are passed as @{path} hints, not inlined.
 */
export async function executeQuery(input: QueryInput): Promise<QueryResult> {
  const { prompt, files = [], timeout, maxResponseLength } = input;
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
