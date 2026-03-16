import { spawnGemini } from "../utils/spawn.js";
import { parseGeminiOutput } from "../utils/parse.js";
import { readFiles, assemblePrompt } from "../utils/files.js";
import { verifyDirectory } from "../utils/security.js";

export interface QueryInput {
  prompt: string;
  files?: string[];
  model?: string;
  workingDirectory?: string;
  timeout?: number;
}

export interface QueryResult {
  response: string;
  model?: string;
  filesIncluded: string[];
  filesSkipped: string[];
  timedOut: boolean;
}

/**
 * Prompt length threshold for using stdin vs positional arg.
 * Positional args are subject to ARG_MAX (~2MB), so pipe large prompts via stdin.
 */
const STDIN_THRESHOLD = 4000;

/**
 * Execute a one-shot query against Gemini CLI.
 * Optionally includes file contents in the prompt.
 */
export async function executeQuery(input: QueryInput): Promise<QueryResult> {
  const { prompt, files = [], model, timeout } = input;

  // Resolve working directory
  const cwd = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();

  // Read and assemble files into prompt
  const fileContents = files.length > 0 ? await readFiles(files, cwd) : [];
  const fullPrompt = assemblePrompt(prompt, fileContents);

  // Large prompts or file attachments: pipe via stdin
  // Short prompts: pass as positional arg (gemini "prompt")
  const useStdin = fullPrompt.length > STDIN_THRESHOLD || files.length > 0;

  const args: string[] = [];

  if (model) {
    args.push("--model", model);
  }

  args.push("--output-format", "json");

  if (!useStdin) {
    args.push(fullPrompt); // positional prompt
  }

  const result = await spawnGemini({
    args,
    cwd,
    stdin: useStdin ? fullPrompt : undefined,
    timeout,
  });

  if (result.timedOut) {
    return {
      response: `Query timed out after ${(timeout ?? 60000) / 1000}s. Try a simpler prompt or increase the timeout.`,
      filesIncluded: fileContents.filter((f) => !f.skipped).map((f) => f.path),
      filesSkipped: fileContents.filter((f) => f.skipped).map((f) => `${f.path}: ${f.skipped}`),
      timedOut: true,
    };
  }

  // Check for common error patterns in stderr
  if (result.exitCode !== 0 && result.stderr) {
    const stderr = result.stderr.toLowerCase();
    if (stderr.includes("auth") || stderr.includes("credential") || stderr.includes("login")) {
      throw new Error(
        `Gemini CLI authentication error. Run: gemini auth login\n\nDetails: ${result.stderr.trim()}`,
      );
    }
    if (stderr.includes("rate") || stderr.includes("429") || stderr.includes("quota")) {
      throw new Error(
        `Gemini API rate limit hit. Wait and retry.\n\nDetails: ${result.stderr.trim()}`,
      );
    }
  }

  const parsed = parseGeminiOutput(result.stdout, result.stderr);

  return {
    response: parsed.response,
    model,
    filesIncluded: fileContents.filter((f) => !f.skipped).map((f) => f.path),
    filesSkipped: fileContents.filter((f) => f.skipped).map((f) => `${f.path}: ${f.skipped}`),
    timedOut: false,
  };
}
