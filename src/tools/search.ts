import { spawnGemini } from "../utils/spawn.js";
import { parseStreamJson, tryParsePartial, OUTPUT_FORMAT } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import { loadPrompt, buildLengthLimit } from "../utils/prompts.js";
import { verifyDirectory } from "../utils/security.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";

export interface SearchInput {
  query: string;
  model?: string;
  workingDirectory?: string;
  timeout?: number;
  maxResponseLength?: number;
}

export interface SearchResult {
  response: string;
  model?: string;
  fallbackUsed?: boolean;
  timedOut: boolean;
  /** The directory the CLI actually ran in. */
  resolvedCwd: string;
}

/** Default timeout for search queries (search + synthesis). */
const SEARCH_TIMEOUT = 120_000;

/**
 * Execute a Google Search grounded query via Gemini CLI.
 *
 * Spawns the CLI in agentic mode (--yolo) so it has access to the
 * google_web_search tool. The prompt instructs Gemini to search the
 * web and synthesize an answer with source URLs.
 */
export async function executeSearch(input: SearchInput): Promise<SearchResult> {
  const { query, maxResponseLength } = input;
  const model = resolveModel(input.model);
  const timeout = Math.min(input.timeout ?? SEARCH_TIMEOUT, HARD_TIMEOUT_CAP);

  const cwd = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();

  const prompt = loadPrompt("search.md", {
    QUERY: query,
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength) || "Provide a focused synthesis. Aim for 500-1500 words unless the topic clearly warrants more.",
  });

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

  if (result.timedOut) {
    const partial = tryParsePartial(result.stdout, result.stderr, timeout);
    return {
      response: partial.text,
      model: fallbackUsed ? fallbackModel : model,
      timedOut: true,
      resolvedCwd: cwd,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseStreamJson(result.stdout, result.stderr);

  return {
    response: parsed.response,
    model: fallbackUsed ? fallbackModel : model,
    fallbackUsed: fallbackUsed || undefined,
    timedOut: false,
    resolvedCwd: cwd,
  };
}
