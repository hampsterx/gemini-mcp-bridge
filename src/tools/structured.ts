import _Ajv from "ajv";
import { spawnGemini } from "../utils/spawn.js";
import { parseStreamJson, tryParsePartial, extractJson, OUTPUT_FORMAT } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import { isImageFile, verifyFilePaths, buildFileHints } from "../utils/files.js";
import { verifyDirectory, MAX_FILES } from "../utils/security.js";
import { loadPrompt } from "../utils/prompts.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";

// Ajv's CJS/ESM interop wraps the constructor in a default property at runtime
const Ajv = _Ajv.default ?? _Ajv;

/** Maximum schema size in bytes (20KB). */
export const MAX_SCHEMA_SIZE = 20_000;

/**
 * Default timeout for agentic structured queries. Plan mode boots the
 * tool system (~16s cold start), so 120s is the minimum useful default.
 */
const AGENTIC_TIMEOUT = 120_000;

/**
 * Create a fresh Ajv instance per validation to avoid schema caching
 * conflicts when different schemas share the same $id.
 */
function createAjv() {
  return new Ajv({ allErrors: true });
}

export interface StructuredInput {
  prompt: string;
  schema: string;
  files?: string[];
  model?: string;
  workingDirectory?: string;
  timeout?: number;
}

export interface StructuredResult {
  response: string;
  valid: boolean;
  errors?: string;
  model?: string;
  fallbackUsed?: boolean;
  /** File paths passed as @{path} hints (Gemini may or may not have read them). */
  filesIncluded: string[];
  filesSkipped: string[];
  timedOut: boolean;
  /** The directory the CLI actually ran in. */
  resolvedCwd: string;
}

/**
 * Execute a structured output query against Gemini CLI.
 *
 * Runs in agentic mode (--approval-mode plan) so Gemini can read files
 * from the working directory. Files are passed as @{path} hints, not
 * inlined. The JSON response is validated against the provided schema.
 */
export async function executeStructured(input: StructuredInput): Promise<StructuredResult> {
  const { prompt, files = [], timeout } = input;
  const model = resolveModel(input.model);

  // Validate schema string
  if (input.schema.length > MAX_SCHEMA_SIZE) {
    throw new Error(`Schema too large: ${input.schema.length} bytes (max ${MAX_SCHEMA_SIZE})`);
  }

  let parsedSchema: object;
  try {
    parsedSchema = JSON.parse(input.schema) as object;
  } catch {
    throw new Error("Invalid schema: not valid JSON");
  }

  // Compile schema to catch invalid JSON Schema before spawning
  const ajv = createAjv();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let validate: any;
  try {
    validate = ajv.compile(parsedSchema);
  } catch (e: unknown) {
    throw new Error(`Invalid JSON Schema: ${(e as Error).message}`);
  }

  // Reject image files
  const imageFiles = files.filter((f) => isImageFile(f));
  if (imageFiles.length > 0) {
    throw new Error("Structured tool does not support image files (text only)");
  }

  if (files.length > MAX_FILES) {
    throw new Error(`Too many files: ${files.length} (max ${MAX_FILES})`);
  }

  // Resolve working directory
  const cwd = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();

  // Verify text file paths (fail-fast, CLI would also reject)
  const { verified, skipped } = files.length > 0
    ? await verifyFilePaths(files, cwd)
    : { verified: [] as string[], skipped: [] as string[] };

  // Build prompt from template + file hints
  const canonicalSchema = JSON.stringify(parsedSchema, null, 2);
  const templatePrompt = loadPrompt("structured.md", {
    SCHEMA: canonicalSchema,
    PROMPT: prompt,
  });
  const fullPrompt = templatePrompt + buildFileHints(verified);

  const effectiveTimeout = Math.min(timeout ?? AGENTIC_TIMEOUT, HARD_TIMEOUT_CAP);

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
      valid: false,
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      filesIncluded: verified,
      filesSkipped: skipped,
      timedOut: true,
      resolvedCwd: cwd,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseStreamJson(result.stdout, result.stderr);

  // Extract JSON from model's text response
  const extracted = extractJson(parsed.response);
  if (!extracted) {
    return {
      response: parsed.response,
      valid: false,
      errors: "Could not extract JSON from response",
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      filesIncluded: verified,
      filesSkipped: skipped,
      timedOut: false,
      resolvedCwd: cwd,
    };
  }

  // Validate against schema
  const valid = validate(extracted.json);
  if (!valid) {
    const errors = (validate.errors as Array<{ instancePath?: string; message?: string }> | null)
      ?.map((e) => `${e.instancePath || "/"}: ${e.message}`)
      .join("; ");
    return {
      response: extracted.raw,
      valid: false,
      errors,
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      filesIncluded: verified,
      filesSkipped: skipped,
      timedOut: false,
      resolvedCwd: cwd,
    };
  }

  return {
    response: extracted.raw,
    valid: true,
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    filesIncluded: verified,
    filesSkipped: skipped,
    timedOut: false,
    resolvedCwd: cwd,
  };
}
