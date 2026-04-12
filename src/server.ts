import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executeQuery } from "./tools/query.js";
import { executeReview } from "./tools/review.js";
import { executeSearch } from "./tools/search.js";
import { executePing } from "./tools/ping.js";
import { executeStructured } from "./tools/structured.js";
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

File handling: Pass file paths in the 'files' array as hints. Text files are referenced via @{path} — Gemini reads them with its own tools. Image files use --yolo mode for native pixel access. Gemini may also read files beyond the ones you hint at.

Note: Gitignored files cannot be read in text-query mode (plan mode restriction). Image queries (--yolo) can read gitignored files.

Model tips: Use gemini-2.5-flash for speed, gemini-2.5-pro for depth and complex reasoning. If omitted, the CLI auto-selects via its routing model.

Each invocation spawns a fresh CLI process (~15-20s startup overhead). Plan timeouts accordingly.`,
    {
      prompt: z.string().describe("The prompt to send to Gemini"),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths relative to workingDirectory, passed as hints. Gemini reads them with its own tools — contents are NOT inlined. Image files (png, jpg, jpeg, gif, webp, bmp) trigger --yolo mode. Max 20 files, 5MB per image."),
      model: z.string().optional().describe("Gemini model override. Options: gemini-2.5-flash (fast), gemini-2.5-pro (deep). Omit to let CLI auto-route."),
      workingDirectory: z
        .string()
        .optional()
        .describe("Working directory for file resolution and project context. The CLI reads GEMINI.md/AGENTS.md from here automatically."),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in milliseconds (default: 120000, max: 600000). Minimum useful: ~20s due to CLI startup."),
      maxResponseLength: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Soft limit on response length in words (e.g. 500). Reduces oversized responses from Gemini's large context window."),
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

        const text = meta.length > 0
          ? `${result.response}\n\n---\n${meta.join("\n")}`
          : result.response;

        return {
          content: [{
            type: "text" as const,
            text,
            _meta: {
              model: result.model ?? null,
              durationMs,
              partial: result.timedOut,
            },
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

  // --- review tool ---

  server.tool(
    "review",
    `Repo-aware code review powered by Gemini. Computes the diff locally, then Gemini explores the repository for full context before reviewing.

Two modes:
- Agentic (default): Gemini runs inside the repo with read_file, grep, list_directory tools. It reads the diff, follows imports, checks tests, and reads project instruction files (CLAUDE.md, GEMINI.md, etc.) before producing its review. Deep and context-aware.
- Quick (quick: true): Sends only the diff text. Single-pass, no repo exploration. Faster but shallow. Default timeout: 180s.

Latency scales with diff size in agentic mode. The default timeout is linear in file count: 180s base + 30s per changed file, capped at 1800s (30 min). A 5-file diff gets 330s, a 15-file diff gets 630s, a 30-file diff gets 1080s. If the diff stat can't be computed (e.g. non-git dir), the default falls back to 600s. For very large diffs prefer 'quick: true' or a narrowed 'base'.

Diff source: By default reviews uncommitted changes (staged + unstaged) vs HEAD. Set 'base' to diff against a branch (e.g. base: "main" for PR review).

Focus examples: "security", "performance", "error handling", "test coverage", "backwards compatibility". Directs Gemini's attention without limiting the review scope.

On timeout, the tool returns whatever Gemini streamed so far, prefixed with '[Partial response, timed out after Xs on N-file diff ...]'. Not an error; partial reviews are often still useful.

The diff is auto-computed. Do not pre-compute or pass the diff yourself.`,
    {
      uncommitted: z
        .boolean()
        .optional()
        .describe("Review uncommitted changes (staged + unstaged) vs HEAD. Default: true."),
      base: z
        .string()
        .optional()
        .describe("Base branch/ref to diff against (e.g. 'main', 'origin/develop'). Produces a three-dot diff (base...HEAD). Overrides uncommitted."),
      focus: z
        .string()
        .optional()
        .describe("Direct review attention to a specific area. Examples: 'security', 'performance', 'error handling', 'test coverage'."),
      quick: z
        .boolean()
        .optional()
        .describe("Quick mode: diff-only review, no repo exploration. ~2x faster, less context. Default: false (agentic)."),
      model: z.string().optional().describe("Gemini model override. Omit to let CLI auto-route. gemini-2.5-pro recommended for thorough reviews."),
      workingDirectory: z
        .string()
        .optional()
        .describe("Repository directory. Auto-resolves to git root, so subdirectories work."),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in ms. Default for agentic is linear in file count: 180000 + 30000 * files, capped at 1800000. Default for quick: 180000. Explicit value always wins."),
      maxResponseLength: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Soft limit on review length in words. Useful for large diffs where the review could be very long."),
    },
    {
      title: "Code Review",
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
        const result = await executeReview(input);
        const durationMs = Math.round(performance.now() - startMs);
        const diffSourceLine = result.diffStat
          ? `Diff source: ${result.diffSource} (${result.diffStat.files} files, +${result.diffStat.insertions} / -${result.diffStat.deletions})`
          : `Diff source: ${result.diffSource}`;
        const timeoutSec = Math.round(result.appliedTimeout / 1000);
        const modeLine = result.timeoutScaled && result.diffStat
          ? `Mode: ${result.mode} (timeout: ${timeoutSec}s, scaled for ${result.diffStat.files}-file diff)`
          : `Mode: ${result.mode} (timeout: ${timeoutSec}s)`;
        const meta: string[] = [
          `Working directory: ${result.resolvedCwd}`,
          diffSourceLine,
          modeLine,
        ];
        if (result.base) meta.push(`Base: ${result.base}`);
        if (result.fallbackUsed) meta.push(`Note: ${result.model ?? "fallback model"} used after quota exhaustion on original model`);
        if (result.timedOut) meta.push("(timed out)");

        return {
          content: [{
            type: "text" as const,
            text: `${result.response}\n\n---\n${meta.join("\n")}`,
            _meta: {
              model: result.model ?? null,
              durationMs,
              partial: result.timedOut,
            },
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
      } finally {
        heartbeat.stop();
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
        .describe("Timeout in ms (default: 120000, max: 600000). Complex multi-search queries may need more time."),
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

        const text = meta.length > 0
          ? `${result.response}\n\n---\n${meta.join("\n")}`
          : result.response;

        return {
          content: [{
            type: "text" as const,
            text,
            _meta: {
              model: result.model ?? null,
              durationMs,
              partial: result.timedOut,
            },
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
        .describe("Text file paths to reference as context (no images). Gemini reads them with its own tools — contents are NOT inlined. Max 20 files."),
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
        .describe("Timeout in ms (default: 120000, max: 600000)."),
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
          content: [{
            type: "text" as const,
            text: result.valid
              ? result.response
              : `${result.response}\n\n---\nSchema validation failed. ${meta.join("\n")}`,
            _meta: {
              model: result.model ?? null,
              durationMs,
              partial: result.timedOut,
            },
          }],
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
