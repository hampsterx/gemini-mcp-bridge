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
 *   node scripts/smoke-test.mjs fetch-chunk        # chunk cache round-trip
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
  } else if (tool === "query-change-mode") {
    const { executeQuery } = await import("../dist/tools/query.js");
    const result = await executeQuery({
      prompt:
        "Rename the variable 'greeting' to 'welcome' in src/index.ts. Output only the edit blocks required, nothing else.",
      workingDirectory,
      changeMode: true,
      timeout: 180_000,
    });
    console.log("response (first 300):", result.response.slice(0, 300) + (result.response.length > 300 ? "..." : ""));
    console.log("resolvedCwd:", result.resolvedCwd);
    console.log("timedOut:", result.timedOut);
    console.log("appliedWrites:", result.appliedWrites ?? false);
    console.log("warning:", result.warning ?? "(none)");
    console.log("edits:", result.edits ? result.edits.length : 0);
    if (result.edits) {
      for (const e of result.edits) {
        console.log(`  - ${e.filename}:${e.startLine}-${e.endLine}`);
      }
    }
    // The smoke target must fail loudly when the change-mode path didn't
    // yield structured edits: any of timeout, applied writes, parse failure,
    // or an empty edit list means the feature is not round-tripping end to
    // end. Print result fields first, then exit non-zero.
    if (!result.edits || result.edits.length === 0 || result.appliedWrites || result.timedOut) {
      console.error("\n--- FAIL: no structured edits produced ---");
      process.exit(1);
    }
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
  } else if (tool === "fetch-chunk") {
    const { maybeChunkText } = await import("../dist/utils/chunkCache.js");
    const { executeFetchChunk } = await import("../dist/tools/fetchChunk.js");
    const seeded = maybeChunkText("chunk-demo ".repeat(2_000), {
      threshold: 1_000,
      chunkSize: 4_000,
    });
    if (!seeded.chunked || !seeded.cacheKey) {
      throw new Error("Failed to seed chunk cache");
    }
    const result = await executeFetchChunk({
      cacheKey: seeded.cacheKey,
      chunkIndex: 2,
    });
    console.log("cacheKey:", result.cacheKey);
    console.log("chunkIndex:", result.chunkIndex);
    console.log("totalChunks:", result.totalChunks);
    console.log("chunk:", result.chunk.slice(0, 120) + (result.chunk.length > 120 ? "..." : ""));
  } else {
    console.error(`Unknown tool: ${tool}. Use: query, query-change-mode, search, review, ping, fetch-chunk`);
    process.exit(1);
  }

  console.log("\n--- PASS ---");
} catch (e) {
  console.error("\n--- FAIL ---");
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
