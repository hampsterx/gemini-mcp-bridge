import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock tool execution functions — tool logic is tested individually in tests/tools/.
// Here we test the MCP transport wiring: tool listing, response formatting, and
// progress notification delivery through InMemoryTransport.

vi.mock("../../src/tools/query.js", () => ({
  executeQuery: vi.fn(),
}));
vi.mock("../../src/tools/search.js", () => ({
  executeSearch: vi.fn(),
}));
vi.mock("../../src/tools/ping.js", () => ({
  executePing: vi.fn(),
}));
vi.mock("../../src/tools/structured.js", () => ({
  executeStructured: vi.fn(),
}));
vi.mock("../../src/tools/fetchChunk.js", () => ({
  executeFetchChunk: vi.fn(),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../../src/server.js";
import { executeQuery } from "../../src/tools/query.js";
import { executeSearch } from "../../src/tools/search.js";
import { executePing } from "../../src/tools/ping.js";
import { executeFetchChunk } from "../../src/tools/fetchChunk.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mockQuery = vi.mocked(executeQuery);
const mockSearch = vi.mocked(executeSearch);
const mockPing = vi.mocked(executePing);
const mockFetchChunk = vi.mocked(executeFetchChunk);

describe("MCP server wiring", () => {
  let client: InstanceType<typeof Client>;
  let server: McpServer;

  async function connectPair() {
    server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await c.connect(clientTransport);
    client = c;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await connectPair();
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("lists all five registered tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["fetch-chunk", "ping", "query", "search", "structured"]);
  });

  it("returns tool response with metadata footer", async () => {
    mockQuery.mockResolvedValue({
      response: "pong",
      timedOut: false,
      resolvedCwd: "/tmp/test",
      filesIncluded: ["src/index.ts"],
      filesSkipped: [],
      imagesIncluded: [],
    });

    const result = await client.callTool({
      name: "query",
      arguments: { prompt: "say pong" },
    });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("pong");
    expect(text).toContain("Working directory: /tmp/test");
    expect(text).toContain("Files hinted: src/index.ts");
  });

  it("returns isError on tool failure", async () => {
    mockQuery.mockRejectedValue(new Error("gemini CLI not found"));

    const result = await client.callTool({
      name: "query",
      arguments: { prompt: "test" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("gemini CLI not found");
  });

  it("chunks oversized query responses and returns cache metadata", async () => {
    mockQuery.mockResolvedValue({
      response: "A".repeat(13_000),
      timedOut: false,
      resolvedCwd: "/tmp/test",
      filesIncluded: [],
      filesSkipped: [],
      imagesIncluded: [],
    });

    const result = await client.callTool({
      name: "query",
      arguments: { prompt: "long output" },
    });

    const content = result.content[0] as {
      text: string;
      _meta?: { chunked?: boolean; chunkCacheKey?: string | null; totalChunks?: number | null };
    };

    expect(content.text).toContain("Response chunk 1/");
    expect(content.text).toContain("Use fetch-chunk");
    expect(content.text).toContain("Working directory: /tmp/test");
    expect(content._meta?.chunked).toBe(true);
    expect(content._meta?.chunkCacheKey).toBeTruthy();
    expect(content._meta?.totalChunks).toBeGreaterThan(1);
  });

  it("query tool passes changeMode through to executeQuery and exposes edits in _meta", async () => {
    mockQuery.mockResolvedValue({
      response: "**FILE: /tmp/repo/x.ts:1-1**\nOLD:\nold\nNEW:\nnew",
      timedOut: false,
      resolvedCwd: "/tmp/repo",
      filesIncluded: [],
      filesSkipped: [],
      imagesIncluded: [],
      edits: [
        { filename: "x.ts", startLine: 1, endLine: 1, oldCode: "old", newCode: "new" },
      ],
    });

    const result = await client.callTool({
      name: "query",
      arguments: { prompt: "rename", changeMode: true },
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ changeMode: true }),
    );

    const content = result.content[0] as {
      text: string;
      _meta?: { edits?: unknown; appliedWrites?: boolean };
    };
    expect(content.text).toContain("Edits: 1 structured edit block");
    expect(content._meta?.edits).toEqual([
      { filename: "x.ts", startLine: 1, endLine: 1, oldCode: "old", newCode: "new" },
    ]);
  });

  it("query tool surfaces appliedWrites warning and omits edits in _meta", async () => {
    mockQuery.mockResolvedValue({
      response: "raw text from Gemini",
      timedOut: false,
      resolvedCwd: "/tmp/repo",
      filesIncluded: [],
      filesSkipped: [],
      imagesIncluded: [],
      appliedWrites: true,
      warning: "Gemini wrote files; edits were not returned for safety",
    });

    const result = await client.callTool({
      name: "query",
      arguments: { prompt: "rename", changeMode: true },
    });

    const content = result.content[0] as {
      text: string;
      _meta?: { appliedWrites?: boolean; edits?: unknown };
    };
    expect(content.text).toContain("Warning: Gemini wrote files");
    expect(content._meta?.appliedWrites).toBe(true);
    expect(content._meta?.edits).toBeUndefined();
  });

  it("fetch-chunk returns cached chunk text with metadata", async () => {
    mockFetchChunk.mockResolvedValue({
      chunk: "second chunk text",
      cacheKey: "abc123",
      chunkIndex: 2,
      totalChunks: 3,
      expiresAt: Date.parse("2026-04-15T12:00:00.000Z"),
    });

    const result = await client.callTool({
      name: "fetch-chunk",
      arguments: { cacheKey: "abc123", chunkIndex: 2 },
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("second chunk text");
    expect(text).toContain("Response chunk 2/3");
    expect(text).toContain("Cache key: abc123");
  });

  it("ping tool returns formatted status lines", async () => {
    mockPing.mockResolvedValue({
      cliFound: true,
      version: "1.2.3",
      authStatus: "ok",
      defaultModel: "gemini-2.5-flash",
      fallbackModel: null,
      serverVersion: "0.2.4",
      nodeVersion: "v22.0.0",
      maxConcurrent: 3,
    });

    const result = await client.callTool({ name: "ping", arguments: {} });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("CLI found: yes");
    expect(text).toContain("CLI version: 1.2.3");
    expect(text).toContain("Auth status: ok");
  });

  describe("progress notifications", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("delivers heartbeats to client when progressToken is provided", async () => {
      // Mock search to take 20s so the 15s heartbeat fires at least once
      mockSearch.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  response: "Search synthesis result.",
                  timedOut: false,
                  resolvedCwd: "/tmp/repo",
                }),
              20_000,
            ),
          ),
      );

      const notifications: Array<{
        progressToken: string | number;
        progress: number;
        message?: string;
      }> = [];

      client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
        notifications.push(notification.params);
      });

      const resultPromise = client.callTool({
        name: "search",
        arguments: { query: "MCP" },
        _meta: { progressToken: "test-tok-1" },
      });

      // Advance past the first heartbeat interval (15s)
      await vi.advanceTimersByTimeAsync(15_000);
      expect(notifications.length).toBeGreaterThanOrEqual(1);

      // Verify notification content
      expect(notifications[0].progressToken).toBe("test-tok-1");
      expect(notifications[0].progress).toBe(1);
      expect(notifications[0].message).toMatch(/Processing/);

      // Advance to complete the tool call (20s total)
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Search synthesis result.");
    });

    it("does not send heartbeats when no progressToken is provided", async () => {
      mockSearch.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  response: "OK",
                  timedOut: false,
                  resolvedCwd: "/tmp/repo",
                }),
              20_000,
            ),
          ),
      );

      const notifications: unknown[] = [];
      client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
        notifications.push(notification);
      });

      const resultPromise = client.callTool({
        name: "search",
        arguments: { query: "MCP" },
        // No _meta / progressToken
      });

      await vi.advanceTimersByTimeAsync(20_000);
      await resultPromise;

      expect(notifications).toHaveLength(0);
    });
  });
});
