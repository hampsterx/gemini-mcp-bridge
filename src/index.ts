#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeQuery } from "./tools/query.js";
import { executeReview } from "./tools/review.js";
import { executeSearch } from "./tools/search.js";
import { executePing } from "./tools/ping.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as { version: string };

const server = new McpServer({
  name: "gemini-mcp-bridge",
  version: PKG_VERSION,
});

// --- query tool ---

server.tool(
  "query",
  "Send a prompt to Gemini CLI with optional file context (text and images). Text files are inlined; image files (png, jpg, etc.) trigger agentic mode for native image reading. The CLI reads GEMINI.md for project context automatically.",
  {
    prompt: z.string().describe("The prompt to send to Gemini"),
    files: z
      .array(z.string())
      .optional()
      .describe("File paths (text or images) relative to workingDirectory. Images: png, jpg, jpeg, gif, webp, bmp"),
    model: z.string().optional().describe("Gemini model to use (e.g. gemini-2.5-flash, gemini-2.5-pro)"),
    workingDirectory: z
      .string()
      .optional()
      .describe("Working directory for the CLI (reads GEMINI.md from here)"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 60000 for text, 120000 for images, max: 600000)"),
  },
  async (input) => {
    try {
      const result = await executeQuery(input);
      const meta: string[] = [];
      if (result.filesIncluded.length > 0) {
        meta.push(`Files included: ${result.filesIncluded.join(", ")}`);
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
      if (result.model) {
        meta.push(`Model: ${result.model}`);
      }

      const text = meta.length > 0
        ? `${result.response}\n\n---\n${meta.join("\n")}`
        : result.response;

      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// --- review tool ---

server.tool(
  "review",
  "Repo-aware code review. Computes diff locally, then Gemini explores the repo with its built-in tools (read_file, grep, etc.) for full context before reviewing. Use quick: true for fast diff-only review.",
  {
    uncommitted: z
      .boolean()
      .optional()
      .describe("Review uncommitted changes (staged + unstaged). Default: true"),
    base: z
      .string()
      .optional()
      .describe("Base branch/ref to diff against (e.g. 'main'). Overrides uncommitted."),
    focus: z
      .string()
      .optional()
      .describe("Optional focus area for the review (e.g. 'security', 'performance', 'error handling')"),
    quick: z
      .boolean()
      .optional()
      .describe("Skip repo exploration, just review the diff text. Faster but less context. Default: false"),
    workingDirectory: z
      .string()
      .optional()
      .describe("Repository directory (auto-resolves to git root)"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 300000 agentic / 120000 quick, max: 600000)"),
  },
  async (input) => {
    try {
      const result = await executeReview(input);
      const meta: string[] = [
        `Diff source: ${result.diffSource}`,
        `Mode: ${result.mode}`,
      ];
      if (result.base) meta.push(`Base: ${result.base}`);
      if (result.timedOut) meta.push("(timed out)");

      return {
        content: [{
          type: "text",
          text: `${result.response}\n\n---\n${meta.join("\n")}`,
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// --- search tool ---

server.tool(
  "search",
  "Google Search grounded query. Gemini searches the web via google_web_search and synthesizes an answer with source URLs. Uses agentic mode.",
  {
    query: z.string().describe("Search query or question to research using Google Search"),
    model: z.string().optional().describe("Gemini model to use (e.g. gemini-2.5-flash, gemini-2.5-pro)"),
    workingDirectory: z
      .string()
      .optional()
      .describe("Working directory for the CLI"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 120000, max: 600000)"),
  },
  async (input) => {
    try {
      const result = await executeSearch(input);
      const meta: string[] = [];
      if (result.timedOut) meta.push("(timed out)");
      if (result.model) meta.push(`Model: ${result.model}`);

      const text = meta.length > 0
        ? `${result.response}\n\n---\n${meta.join("\n")}`
        : result.response;

      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// --- ping tool ---

server.tool(
  "ping",
  "Health check: verifies gemini CLI is installed and authenticated, reports versions and capabilities.",
  {},
  async () => {
    try {
      const result = await executePing();

      const lines = [
        `CLI found: ${result.cliFound ? "yes" : "NO — install with: npm i -g @google/gemini-cli"}`,
        `CLI version: ${result.version ?? "unknown"}`,
        `Auth status: ${result.authStatus}`,
        `Server version: ${result.serverVersion}`,
        `Node version: ${result.nodeVersion}`,
        `Max concurrent: ${result.maxConcurrent}`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
