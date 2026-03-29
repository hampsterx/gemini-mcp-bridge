import { spawnGemini } from "../utils/spawn.js";
import { parseGeminiOutput } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import { loadPrompt } from "../utils/prompts.js";
import { verifyDirectory } from "../utils/security.js";
import { resolveModel } from "../utils/model.js";

export interface SearchInput {
  query: string;
  model?: string;
  workingDirectory?: string;
  timeout?: number;
}

export interface SearchResult {
  response: string;
  model?: string;
  timedOut: boolean;
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
  const { query } = input;
  const model = resolveModel(input.model);
  const timeout = input.timeout ?? SEARCH_TIMEOUT;

  const cwd = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();

  const prompt = loadPrompt("search.md", { QUERY: query });

  const args: string[] = ["--yolo"];
  if (model) args.push("--model", model);
  args.push("--output-format", "json");

  const result = await spawnGemini({
    args,
    cwd,
    stdin: prompt,
    timeout,
  });

  if (result.timedOut) {
    return {
      response: `Search timed out after ${timeout / 1000}s. Try a more specific query or increase the timeout.`,
      model,
      timedOut: true,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseGeminiOutput(result.stdout, result.stderr);

  return {
    response: parsed.response,
    model,
    timedOut: false,
  };
}
