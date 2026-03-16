#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeQuery } from "./tools/query.js";
import { executeReview } from "./tools/review.js";
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
  "Send a prompt to Gemini CLI with optional file context. The CLI reads GEMINI.md for project context automatically.",
  {
    prompt: z.string().describe("The prompt to send to Gemini"),
    files: z
      .array(z.string())
      .optional()
      .describe("File paths (relative to workingDirectory) to include in the prompt"),
    model: z.string().optional().describe("Gemini model to use (e.g. gemini-2.5-flash, gemini-2.5-pro)"),
    workingDirectory: z
      .string()
      .optional()
      .describe("Working directory for the CLI (reads GEMINI.md from here)"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 60000, max: 600000)"),
  },
  async (input) => {
    try {
      const result = await executeQuery(input);
      const meta: string[] = [];
      if (result.filesIncluded.length > 0) {
        meta.push(`Files included: ${result.filesIncluded.join(", ")}`);
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
  "Code review via git diff sent to Gemini. Computes diff locally and asks Gemini for a structured review.",
  {
    uncommitted: z
      .boolean()
      .optional()
      .describe("Review uncommitted changes (staged + unstaged). Default: true"),
    base: z
      .string()
      .optional()
      .describe("Base branch/ref to diff against (e.g. 'main'). Overrides uncommitted."),
    workingDirectory: z
      .string()
      .optional()
      .describe("Repository directory (auto-resolves to git root)"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 120000, max: 600000)"),
  },
  async (input) => {
    try {
      const result = await executeReview(input);
      const meta: string[] = [
        `Diff source: ${result.diffSource}`,
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
