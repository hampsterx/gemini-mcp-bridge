import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executeQuery } from "./tools/query.js";
import { executeSearch } from "./tools/search.js";
import { executePing } from "./tools/ping.js";
import { executeStructured } from "./tools/structured.js";
import { executeFetchChunk } from "./tools/fetchChunk.js";
import { formatTextResponse } from "./utils/mcpResponse.js";
import { maybeStartHeartbeat, type ProgressNotificationSender } from "./utils/progress.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as { version: string };

/**
 * Create and configure the MCP server with all tools registered.
 * Separated from transport setup so tests can connect via InMemoryTransport.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "gemini-mcp-bridge",
    version: PKG_VERSION,
  });

  // --- query tool ---

  server.tool(
    "query",
    `Agentic query: Gemini runs inside your workingDirectory with read_file, grep, list_directory, and glob tools. Pass file paths as hints (not content) — Gemini reads them itself and can explore surrounding code for context.

Capabilities:
- Code analysis with full repo exploration (Gemini follows imports, reads tests, checks related files)
- Image understanding: screenshots, diagrams, architecture charts (png/jpg/gif/webp/bmp)
- General knowledge questions and technical research
- Text transformation, summarization, and generation
- Change mode: structured edit blocks parsed into a machine-applicable \`edits\` array (see 'changeMode' below)

File handling: Pass file paths in the 'files' array as hints. Text files are referenced via @{path} — Gemini reads them with its own tools. Image files use --yolo mode for native pixel access. Gemini may also read files beyond the ones you hint at.

Note: Gitignored files cannot be read in text-query mode (plan mode restriction). Image queries (--yolo) can read gitignored files.

Change mode: set 'changeMode: true' to ask Gemini to emit structured \`**FILE: <path>:<start>-<end>**\` / \`===OLD===\` / \`===NEW===\` blocks instead of prose. The response text stays in \`response\`; parsed edits are returned on \`_meta.edits\` and never chunked. The tool runs in default agentic mode (NOT plan mode, which refuses to emit edit blocks) with a pre/post-spawn git snapshot that detects any file writes Gemini might attempt. If writes are detected the tool returns \`_meta.appliedWrites: true\` and omits edits for safety. Text-only (image files rejected). Requires a git working directory.

Model tips: Use gemini-2.5-flash for speed, gemini-2.5-pro for depth and complex reasoning. If omitted, the CLI auto-selects via its routing model.

Each invocation spawns a fresh CLI process (~15-20s startup overhead). Plan timeouts accordingly.`,
    {
      prompt: z.string().describe("The prompt to send to Gemini"),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths relative to workingDirectory, passed as hints. Gemini reads them with its own tools — contents are NOT inlined. Image files (png, jpg, jpeg, gif, webp, bmp) trigger --yolo mode. Max 20 files, 1MB per text file, 5MB per image."),
      model: z.string().optional().describe("Gemini model override. Options: gemini-2.5-flash (fast), gemini-2.5-pro (deep). Omit to let CLI auto-route."),
      workingDirectory: z
        .string()
        .optional()
        .describe("Working directory for file resolution and project context. The CLI reads GEMINI.md/AGENTS.md from here automatically."),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in milliseconds (default: 120000, max: 1800000). Minimum useful: ~20s due to CLI startup."),
      maxResponseLength: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Soft limit on response length in words (e.g. 500). Reduces oversized responses from Gemini's large context window."),
      changeMode: z
        .boolean()
        .optional()
        .describe("When true, Gemini emits structured **FILE: path:start-end** / ===OLD=== / ===NEW=== edit blocks. Legacy OLD:/NEW: markers are still parsed for back-compat. Parsed edits are returned on _meta.edits (never chunked). A pre/post-spawn git snapshot enforces that Gemini did not write any files; if writes are detected, _meta.appliedWrites is true and edits are omitted. Text-only, requires a git workingDirectory."),
    },
    {
      title: "Gemini Query",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (input) => {
      const startMs = performance.now();
      try {
        const result = await executeQuery(input);
        const durationMs = Math.round(performance.now() - startMs);
        const meta: string[] = [`Working directory: ${result.resolvedCwd}`];
        if (result.filesIncluded.length > 0) {
          meta.push(`Files hinted: ${result.filesIncluded.join(", ")}`);
        }
        if (result.imagesIncluded.length > 0) {
          meta.push(`Images included: ${result.imagesIncluded.join(", ")}`);
        }
        if (result.filesSkipped.length > 0) {
          meta.push(`Files skipped: ${result.filesSkipped.join(", ")}`);
        }
        if (result.timedOut) {
          meta.push("(timed out)");
        }
        if (result.fallbackUsed) {
          meta.push(`Note: ${result.model ?? "primary model"} used after quota exhaustion on original model`);
        } else if (result.model) {
          meta.push(`Model: ${result.model}`);
        }
        if (result.edits) {
          meta.push(`Edits: ${result.edits.length} structured edit block${result.edits.length === 1 ? "" : "s"} (see _meta.edits)`);
        }
        if (result.appliedWrites) {
          meta.push("Warning: Gemini wrote files during the spawn; edits were not returned for safety");
        }
        if (result.warning && !result.appliedWrites) {
          meta.push(`Warning: ${result.warning}`);
        }

        const extraMeta: Record<string, unknown> = {};
        if (result.edits) extraMeta.edits = result.edits;
        if (result.appliedWrites) extraMeta.appliedWrites = true;
        if (result.warning) extraMeta.changeModeWarning = result.warning;

        return formatTextResponse({
          body: result.response,
          metaLines: meta,
          enableChunking: true,
          responseMeta: {
            model: result.model ?? null,
            durationMs,
            partial: result.timedOut,
          },
          extraMeta: Object.keys(extraMeta).length > 0 ? extraMeta : undefined,
        });
      } catch (e) {
        const durationMs = Math.round(performance.now() - startMs);
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${(e as Error).message}`,
            _meta: { durationMs, partial: false },
          }],
          isError: true,
        };
      }
    },
  );

  // --- search tool ---

  server.tool(
    "search",
    `Google Search grounded research. Gemini searches the web using google_web_search and synthesizes a comprehensive answer with source URLs and citations.

Use for: current events, documentation lookups, API references, comparing technologies, verifying facts, finding recent releases or changelogs.

The query can be a natural language question or a search-style keyword string. Gemini may issue multiple searches to build a complete answer. Results include source URLs for verification.

Output is a synthesized summary (500-1500 words by default), not raw search results. Use maxResponseLength to adjust.`,
    {
      query: z.string().describe("Search query or research question. Natural language works best (e.g. 'What changed in Node.js 22?' or 'MCP protocol specification transport options')."),
      model: z.string().optional().describe("Gemini model override. Omit to let CLI auto-route."),
      workingDirectory: z
        .string()
        .optional()
        .describe("Working directory for the CLI process."),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in ms (default: 120000, max: 1800000). Complex multi-search queries may need more time."),
      maxResponseLength: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Soft limit on synthesis length in words. Default aims for 500-1500 words."),
    },
    {
      title: "Web Search",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (input, extra) => {
      const startMs = performance.now();
      const heartbeat = maybeStartHeartbeat(
        extra._meta as { progressToken?: string | number } | undefined,
        extra.sendNotification as ProgressNotificationSender,
      );
      try {
        const result = await executeSearch(input);
        const durationMs = Math.round(performance.now() - startMs);
        const meta: string[] = [`Working directory: ${result.resolvedCwd}`];
        if (result.timedOut) meta.push("(timed out)");
        if (result.fallbackUsed) {
          meta.push(`Note: ${result.model ?? "fallback model"} used after quota exhaustion on original model`);
        } else if (result.model) {
          meta.push(`Model: ${result.model}`);
        }

        return formatTextResponse({
          body: result.response,
          metaLines: meta,
          enableChunking: true,
          responseMeta: {
            model: result.model ?? null,
            durationMs,
            partial: result.timedOut,
          },
        });
      } catch (e) {
        const durationMs = Math.round(performance.now() - startMs);
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${(e as Error).message}`,
            _meta: { durationMs, partial: false },
          }],
          isError: true,
        };
      } finally {
        heartbeat.stop();
      }
    },
  );

  // --- structured tool ---

  server.tool(
    "structured",
    "Agentic structured output: generate a JSON response conforming to a provided JSON Schema. Gemini runs inside workingDirectory with read_file and grep tools, so it can read files for context. Use for data extraction, classification, or any task needing machine-parseable output. The response is validated against the schema; isError is true if validation fails.",
    {
      prompt: z.string().describe("What to generate or extract from the provided context"),
      schema: z
        .string()
        .describe("JSON Schema as a string. The response will be validated against this. Max 20KB."),
      files: z
        .array(z.string())
        .optional()
        .describe("Text file paths to reference as context (no images). Gemini reads them with its own tools — contents are NOT inlined. Max 20 files, 1MB each."),
      model: z
        .string()
        .optional()
        .describe("Gemini model override. Omit to let CLI auto-route."),
      workingDirectory: z
        .string()
        .optional()
        .describe("Working directory for file resolution."),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in ms (default: 120000, max: 1800000)."),
    },
    {
      title: "Structured Output",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (input) => {
      const startMs = performance.now();
      try {
        const result = await executeStructured(input);
        const durationMs = Math.round(performance.now() - startMs);
        const meta: string[] = [];
        if (result.errors) meta.push(`Errors: ${result.errors}`);
        if (result.filesIncluded.length > 0) {
          meta.push(`Files hinted: ${result.filesIncluded.join(", ")}`);
        }
        if (result.timedOut) meta.push("(timed out)");
        if (result.fallbackUsed) {
          meta.push(`Note: ${result.model ?? "fallback model"} used after quota exhaustion on original model`);
        } else if (result.model) {
          meta.push(`Model: ${result.model}`);
        }
        meta.push(`Working directory: ${result.resolvedCwd}`);

        return {
          ...formatTextResponse({
            body: result.valid
              ? result.response
              : `${result.response}\n\n---\nSchema validation failed. ${meta.join("\n")}`,
            metaLines: result.valid ? meta : undefined,
            enableChunking: false,
            responseMeta: {
              model: result.model ?? null,
              durationMs,
              partial: result.timedOut,
            },
          }),
          isError: !result.valid,
        };
      } catch (e) {
        const durationMs = Math.round(performance.now() - startMs);
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${(e as Error).message}`,
            _meta: { durationMs, partial: false },
          }],
          isError: true,
        };
      }
    },
  );

  // --- fetch-chunk tool ---

  server.tool(
    "fetch-chunk",
    "Retrieve a cached chunk from a previously chunked response. Large query and search responses may return only the first chunk plus a cacheKey. Use this tool with that cacheKey and a 1-based chunkIndex to fetch the remaining segments before the 10-minute in-memory cache expires.",
    {
      cacheKey: z.string().describe("Cache key returned in the initial chunked response."),
      chunkIndex: z
        .number()
        .int()
        .positive()
        .describe("1-based chunk index to retrieve. Use 2 for the next segment after the initial response."),
      workingDirectory: z
        .string()
        .optional()
        .describe("Unused for now. Accepted for tool contract consistency with the other bridge tools."),
    },
    {
      title: "Fetch Cached Chunk",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (input) => {
      const startMs = performance.now();
      try {
        const result = await executeFetchChunk(input);
        const durationMs = Math.round(performance.now() - startMs);
        return formatTextResponse({
          body: result.chunk,
          metaLines: [
            `Response chunk ${result.chunkIndex}/${result.totalChunks}`,
            `Cache key: ${result.cacheKey}`,
            `Expires at: ${new Date(result.expiresAt).toISOString()}`,
          ],
          enableChunking: false,
          responseMeta: {
            durationMs,
            partial: false,
          },
        });
      } catch (e) {
        const durationMs = Math.round(performance.now() - startMs);
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${(e as Error).message}`,
            _meta: { durationMs, partial: false },
          }],
          isError: true,
        };
      }
    },
  );

  // --- ping tool ---

  server.tool(
    "ping",
    "Health check. Verifies gemini CLI is installed and authenticated, reports CLI version, auth status, configured models, and server version. Fast (~1s, no model call).",
    {},
    {
      title: "Health Check",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
      const startMs = performance.now();
      try {
        const result = await executePing();
        const durationMs = Math.round(performance.now() - startMs);

        const lines = [
          `CLI found: ${result.cliFound ? "yes" : "NO — install with: npm i -g @google/gemini-cli"}`,
          `CLI version: ${result.version ?? "unknown"}`,
          `Auth status: ${result.authStatus}`,
          `Default model: ${result.defaultModel ?? "(CLI default)"}`,
          `Fallback model: ${result.fallbackModel ?? "disabled"}`,
          `Server version: ${result.serverVersion}`,
          `Node version: ${result.nodeVersion}`,
          `Max concurrent: ${result.maxConcurrent}`,
        ];

        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
            _meta: { durationMs, partial: false },
          }],
        };
      } catch (e) {
        const durationMs = Math.round(performance.now() - startMs);
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${(e as Error).message}`,
            _meta: { durationMs, partial: false },
          }],
          isError: true,
        };
      }
    },
  );

  return server;
}
