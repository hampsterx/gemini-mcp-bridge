#!/usr/bin/env node

/**
 * Smoke test for gemini-mcp-bridge tool functions.
 *
 * Bypasses the running MCP server and imports compiled tool functions
 * directly, so you can test changes without restarting your MCP client.
 *
 * Usage:
 *   npm run build && node scripts/smoke-test.mjs [tool] [workingDirectory]
 *
 * Examples:
 *   node scripts/smoke-test.mjs                    # query tool, cwd
 *   node scripts/smoke-test.mjs query /tmp         # query tool, /tmp
 *   node scripts/smoke-test.mjs search             # search tool
 *   node scripts/smoke-test.mjs review ~/NUI/cream # review tool against cream
 */

import { homedir } from "os";

const tool = process.argv[2] || "query";
const rawDir = process.argv[3] || process.cwd();
const workingDirectory = rawDir.startsWith("~/") ? rawDir.replace("~", homedir()) : rawDir;

console.log(`\n--- smoke-test: ${tool} ---`);
console.log(`workingDirectory: ${workingDirectory}\n`);

try {
  if (tool === "query") {
    const { executeQuery } = await import("../dist/tools/query.js");
    const result = await executeQuery({
      prompt: 'Reply with exactly: "pong"',
      workingDirectory,
      maxResponseLength: 10,
      timeout: 60_000,
    });
    console.log("response:", result.response);
    console.log("resolvedCwd:", result.resolvedCwd);
    console.log("timedOut:", result.timedOut);
  } else if (tool === "search") {
    const { executeSearch } = await import("../dist/tools/search.js");
    const result = await executeSearch({
      query: "What is MCP (Model Context Protocol)?",
      workingDirectory,
      maxResponseLength: 50,
      timeout: 120_000,
    });
    console.log("response:", result.response.slice(0, 200) + (result.response.length > 200 ? "..." : ""));
    console.log("resolvedCwd:", result.resolvedCwd);
    console.log("timedOut:", result.timedOut);
  } else if (tool === "review") {
    const { executeReview } = await import("../dist/tools/review.js");
    const result = await executeReview({
      uncommitted: true,
      quick: true,
      workingDirectory,
      maxResponseLength: 100,
      timeout: 120_000,
    });
    console.log("response:", result.response.slice(0, 200) + (result.response.length > 200 ? "..." : ""));
    console.log("resolvedCwd:", result.resolvedCwd);
    console.log("mode:", result.mode);
    console.log("timedOut:", result.timedOut);
  } else if (tool === "ping") {
    const { executePing } = await import("../dist/tools/ping.js");
    const result = await executePing();
    console.log("cliFound:", result.cliFound);
    console.log("version:", result.version);
    console.log("authStatus:", result.authStatus);
  } else {
    console.error(`Unknown tool: ${tool}. Use: query, search, review, ping`);
    process.exit(1);
  }

  console.log("\n--- PASS ---");
} catch (e) {
  console.error("\n--- FAIL ---");
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
