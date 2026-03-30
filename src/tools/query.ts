import { spawnGemini } from "../utils/spawn.js";
import { parseGeminiOutput } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import {
  readFiles,
  assemblePrompt,
  isImageFile,
  MAX_IMAGE_FILE_SIZE,
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
  filesIncluded: string[];
  filesSkipped: string[];
  imagesIncluded: string[];
  timedOut: boolean;
}

/**
 * Prompt length threshold for using stdin vs positional arg.
 * Positional args are subject to ARG_MAX (~2MB), so pipe large prompts via stdin.
 */
const STDIN_THRESHOLD = 4000;

/** Default timeout for agentic image queries (CLI needs to read files). */
const IMAGE_QUERY_TIMEOUT = 120_000;

/**
 * Execute a one-shot query against Gemini CLI.
 * Optionally includes file contents in the prompt.
 *
 * When image files are included, switches to agentic mode (--yolo) so the CLI
 * can read them natively via its read_file tool. Text files are still inlined
 * in the prompt as before.
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

  return executeTextQuery({ prompt, textFiles, model, timeout, cwd, maxResponseLength });
}

interface TextQueryInput {
  prompt: string;
  textFiles: string[];
  model?: string;
  timeout?: number;
  cwd: string;
  maxResponseLength?: number;
}

interface ImageQueryInput extends TextQueryInput {
  imageFiles: string[];
}

/**
 * Text-only query: non-agentic, files inlined in prompt.
 * This is the original behaviour, unchanged.
 */
async function executeTextQuery(input: TextQueryInput): Promise<QueryResult> {
  const { prompt, textFiles, model, timeout, cwd, maxResponseLength } = input;

  const fileContents = textFiles.length > 0 ? await readFiles(textFiles, cwd) : [];
  const fullPrompt = appendLengthLimit(assemblePrompt(prompt, fileContents), maxResponseLength);

  const useStdin = fullPrompt.length > STDIN_THRESHOLD || textFiles.length > 0;
  const effectiveTimeout = Math.min(timeout ?? 60_000, HARD_TIMEOUT_CAP);

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      const args: string[] = [];
      if (m) args.push("--model", m);
      args.push("--output-format", "json");
      if (!useStdin) args.push(fullPrompt);
      return spawnGemini({ args, cwd, stdin: useStdin ? fullPrompt : undefined, timeout: t });
    },
    effectiveTimeout,
  );

  const actualModel = fallbackUsed ? fallbackModel : model;

  if (result.timedOut) {
    return {
      response: `Query timed out after ${effectiveTimeout / 1000}s. Try a simpler prompt or increase the timeout.`,
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      filesIncluded: fileContents.filter((f) => !f.skipped).map((f) => f.path),
      filesSkipped: fileContents.filter((f) => f.skipped).map((f) => `${f.path}: ${f.skipped}`),
      imagesIncluded: [],
      timedOut: true,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseGeminiOutput(result.stdout, result.stderr);

  return {
    response: parsed.response,
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    filesIncluded: fileContents.filter((f) => !f.skipped).map((f) => f.path),
    filesSkipped: fileContents.filter((f) => f.skipped).map((f) => `${f.path}: ${f.skipped}`),
    imagesIncluded: [],
    timedOut: false,
  };
}

/**
 * Image query: agentic mode (--yolo) so the CLI reads images natively.
 * Text files are still inlined in the prompt; image files are referenced by
 * absolute path with instructions for the CLI to read them.
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

  // Read text files
  const fileContents = textFiles.length > 0 ? await readFiles(textFiles, cwd) : [];
  const textPart = assemblePrompt(prompt, fileContents);

  // Build image instructions for the CLI (use original names, CLI resolves from cwd)
  const imagePart = imageNames
    .map((p) => `Read and analyze the image at: ${p}`)
    .join("\n");
  const fullPrompt = appendLengthLimit(
    imageNames.length > 0 ? `${textPart}\n\n## Image Files\n\n${imagePart}` : textPart,
    maxResponseLength,
  );

  const effectiveTimeout = Math.min(timeout ?? IMAGE_QUERY_TIMEOUT, HARD_TIMEOUT_CAP);

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      const args: string[] = [];
      if (imageNames.length > 0) args.push("--yolo");
      if (m) args.push("--model", m);
      args.push("--output-format", "json");
      return spawnGemini({ args, cwd, stdin: fullPrompt, timeout: t });
    },
    effectiveTimeout,
  );

  const actualModel = fallbackUsed ? fallbackModel : model;

  if (result.timedOut) {
    return {
      response: `Query timed out after ${effectiveTimeout / 1000}s. Try a simpler prompt or increase the timeout.`,
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      filesIncluded: fileContents.filter((f) => !f.skipped).map((f) => f.path),
      filesSkipped: [
        ...fileContents.filter((f) => f.skipped).map((f) => `${f.path}: ${f.skipped}`),
        ...skippedImages,
      ],
      imagesIncluded: imageNames,
      timedOut: true,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseGeminiOutput(result.stdout, result.stderr);

  return {
    response: parsed.response,
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    filesIncluded: fileContents.filter((f) => !f.skipped).map((f) => f.path),
    filesSkipped: [
      ...fileContents.filter((f) => f.skipped).map((f) => `${f.path}: ${f.skipped}`),
      ...skippedImages,
    ],
    imagesIncluded: imageNames,
    timedOut: false,
  };
}

