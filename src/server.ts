import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executeAssess } from "./tools/assess.js";
import { executeQuery } from "./tools/query.js";
import { executeReview } from "./tools/review.js";
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

File handling: Pass file paths in the 'files' array as hints. Text files are referenced via @{path} — Gemini reads them with its own tools. Image files use --yolo mode for native pixel access. Gemini may also read files beyond the ones you hint at.

Note: Gitignored files cannot be read in text-query mode (plan mode restriction). Image queries (--yolo) can read gitignored files.

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
      }
    },
  );

  // --- review tool ---

  server.tool(
    "review",
    `Repo-aware code review powered by Gemini. Computes the diff locally, then Gemini reviews at the requested depth.

Three depths:
- scan: diff-only, single-pass, no repo exploration. Fastest (~180s timeout). Good for sanity checks and small diffs.
- focused: diff + Gemini reads changed files for surrounding context. Plan mode, no shell. Medium (~120-300s). Good for light-to-moderate reviews.
- deep (default): full agentic exploration with shell access. Gemini runs git itself, follows imports, checks tests, reads project instruction files (CLAUDE.md, GEMINI.md, etc.). Slowest but deepest (~180s-30min).

Use the 'assess' tool first to classify diff complexity, change kind, and get a depth recommendation.

Latency scales with diff size on focused and deep. Timeouts:
- scan: constant 180s.
- focused: 120s + 15s per file, capped at 300s. Fallback 240s when diff stat unavailable.
- deep: 240s + 45s per file, capped at 1800s (30 min). Fallback 600s when diff stat unavailable. Capacity failures such as 429/503 are returned as structured metadata instead of triggering an internal fallback retry.

A 5-file diff: scan=180s, focused=195s, deep=465s. A 15-file diff: scan=180s, focused=300s (capped), deep=915s.

Diff source: By default reviews uncommitted changes (staged + unstaged) vs HEAD. Set 'base' to diff against a branch (e.g. base: "main" for PR review).

Focus examples: "security", "performance", "error handling", "test coverage", "backwards compatibility". Directs Gemini's attention without limiting the review scope.

On timeout, the tool returns whatever Gemini streamed so far. For focused/deep the prefix includes diff size and a hint to try a shallower depth. Partial reviews are often still useful.

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
      depth: z
        .enum(["scan", "focused", "deep"])
        .optional()
        .describe("Review depth: 'scan' (diff-only, ~180s), 'focused' (diff + changed files, ~120-300s), 'deep' (full agentic exploration, ~180s-30min). Default: 'deep'. Takes precedence over 'quick' if both are set."),
      quick: z
        .boolean()
        .optional()
        .describe("DEPRECATED: use 'depth' instead. 'quick: true' maps to 'depth: \"scan\"'; 'quick: false' maps to 'depth: \"deep\"'. Kept for backwards compatibility."),
      model: z.string().optional().describe("Gemini model override. Omit to let CLI auto-route. gemini-2.5-pro recommended for thorough reviews."),
      workingDirectory: z
        .string()
        .optional()
        .describe("Repository directory. Auto-resolves to git root, so subdirectories work."),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in ms. Defaults scale by depth: scan=180000, focused=120000+15000*files (cap 300000), deep=240000+45000*files (cap 1800000). Explicit value always wins."),
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
        if (result.capacityFailure) {
          const code = result.capacityFailure.statusCode ? ` (${result.capacityFailure.statusCode})` : "";
          meta.push(`Capacity failure: ${result.capacityFailure.kind}${code}`);
        }
        if (result.timedOut) meta.push("(timed out)");
        return formatTextResponse({
          body: result.response,
          metaLines: meta,
          enableChunking: true,
          responseMeta: {
            model: result.model ?? null,
            durationMs,
            partial: result.timedOut,
          },
          extraMeta: {
            capacityFailure: result.capacityFailure ?? null,
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
    "Retrieve a cached chunk from a previously chunked response. Large query, review, and search responses may return only the first chunk plus a cacheKey. Use this tool with that cacheKey and a 1-based chunkIndex to fetch the remaining segments before the 10-minute in-memory cache expires.",
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

  // --- assess tool ---

  server.tool(
    "assess",
    `Zero-cost diff analysis pre-flight for the review tool. Runs git locally (no CLI spawn, no model call) and returns in <2 seconds.

Returns: diff stats, changed file list, complexity classification (trivial/moderate/complex), change kind, guidance, and review depth suggestions with estimated wall-clock durations.

Complexity levels:
- trivial: 1-2 files, <100 lines
- moderate: 3-8 files, or >100 lines
- complex: 9+ files, or cross-cutting changes spanning 3+ directories

Use this before calling 'review' to choose the right depth level and set timeout expectations.`,
    {
      uncommitted: z
        .boolean()
        .optional()
        .describe("Assess uncommitted changes (staged + unstaged) vs HEAD. Default: true."),
      base: z
        .string()
        .optional()
        .describe("Base branch/ref to diff against (e.g. 'main'). Overrides uncommitted."),
      workingDirectory: z
        .string()
        .optional()
        .describe("Repository directory. Auto-resolves to git root."),
    },
    {
      title: "Diff Assessment",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (input) => {
      const startMs = performance.now();
      try {
        const result = await executeAssess(input);
        const durationMs = Math.round(performance.now() - startMs);

        const lines = [
          `Complexity: ${result.complexity}`,
          `Change kind: ${result.diffKind}`,
          `Files changed: ${result.diffStat.files} (+${result.diffStat.insertions} / -${result.diffStat.deletions})`,
          `Guidance: ${result.guidance}`,
          "",
          "Changed files:",
          ...result.changedFiles.map((f) => `  ${f}`),
          "",
          "Suggested review depths:",
          ...result.suggestions.map(
            (s) => `  ${s.depth} (~${s.estimatedSeconds}s): ${s.description}`,
          ),
        ];

        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
            _meta: {
              durationMs,
              complexity: result.complexity,
              diffKind: result.diffKind,
              diffStat: result.diffStat,
              guidance: result.guidance,
              suggestions: result.suggestions,
            },
          }],
        };
      } catch (e) {
        const durationMs = Math.round(performance.now() - startMs);
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${(e as Error).message}`,
            _meta: { durationMs },
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
