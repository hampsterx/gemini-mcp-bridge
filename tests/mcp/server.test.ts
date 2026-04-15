import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock tool execution functions — tool logic is tested individually in tests/tools/.
// Here we test the MCP transport wiring: tool listing, response formatting, and
// progress notification delivery through InMemoryTransport.

vi.mock("../../src/tools/query.js", () => ({
  executeQuery: vi.fn(),
}));
vi.mock("../../src/tools/review.js", () => ({
  executeReview: vi.fn(),
  buildAgenticPrompt: vi.fn(),
  buildQuickPrompt: vi.fn(),
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
vi.mock("../../src/tools/assess.js", () => ({
  executeAssess: vi.fn(),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../../src/server.js";
import { executeQuery } from "../../src/tools/query.js";
import { executeReview } from "../../src/tools/review.js";
import { executePing } from "../../src/tools/ping.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mockQuery = vi.mocked(executeQuery);
const mockReview = vi.mocked(executeReview);
const mockPing = vi.mocked(executePing);

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

  it("lists all six registered tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["assess", "ping", "query", "review", "search", "structured"]);
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

  it("review tool includes diff metadata in response", async () => {
    mockReview.mockResolvedValue({
      response: "LGTM, no issues found.",
      diffSource: "uncommitted",
      mode: "scan",
      timedOut: false,
      resolvedCwd: "/tmp/repo",
      appliedTimeout: 180_000,
      timeoutScaled: false,
    });

    const result = await client.callTool({
      name: "review",
      arguments: { quick: true },
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("LGTM");
    expect(text).toContain("Diff source: uncommitted");
    expect(text).toContain("Mode: scan");
  });

  it("review tool accepts the depth parameter and reports the resolved depth", async () => {
    mockReview.mockResolvedValue({
      response: "Focused review output.",
      diffSource: "uncommitted",
      mode: "focused",
      timedOut: false,
      resolvedCwd: "/tmp/repo",
      appliedTimeout: 195_000,
      timeoutScaled: true,
      diffStat: { files: 5, insertions: 20, deletions: 4 },
    });

    const result = await client.callTool({
      name: "review",
      arguments: { depth: "focused" },
    });

    expect(mockReview).toHaveBeenCalledWith(expect.objectContaining({ depth: "focused" }));
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Focused review output.");
    expect(text).toContain("Mode: focused");
    expect(text).toContain("scaled for 5-file diff");
  });

  it("review tool surfaces capacity failure metadata without marking the tool call as an error", async () => {
    mockReview.mockResolvedValue({
      response: "The requested deep review could not be completed because Gemini returned a capacity-related failure: service_unavailable (503).",
      diffSource: "uncommitted",
      mode: "deep",
      timedOut: false,
      resolvedCwd: "/tmp/repo",
      appliedTimeout: 375_000,
      timeoutScaled: true,
      diffStat: { files: 3, insertions: 10, deletions: 2 },
      capacityFailure: {
        kind: "service_unavailable",
        statusCode: 503,
        message: "503 Service Unavailable",
      },
    });

    const result = await client.callTool({
      name: "review",
      arguments: { depth: "deep" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("capacity-related failure");
    expect(text).toContain("Capacity failure: service_unavailable (503)");
  });

  describe("progress notifications", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("delivers heartbeats to client when progressToken is provided", async () => {
      // Mock review to take 20s so the 15s heartbeat fires at least once
      mockReview.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  response: "Looks good.",
                  diffSource: "uncommitted" as const,
                  mode: "scan" as const,
                  timedOut: false,
                  resolvedCwd: "/tmp/repo",
                  appliedTimeout: 180_000,
                  timeoutScaled: false,
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
        name: "review",
        arguments: { quick: true },
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
      expect(text).toContain("Looks good.");
    });

    it("does not send heartbeats when no progressToken is provided", async () => {
      mockReview.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  response: "OK",
                  diffSource: "uncommitted" as const,
                  mode: "scan" as const,
                  timedOut: false,
                  resolvedCwd: "/tmp/repo",
                  appliedTimeout: 180_000,
                  timeoutScaled: false,
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
        name: "review",
        arguments: { quick: true },
        // No _meta / progressToken
      });

      await vi.advanceTimersByTimeAsync(20_000);
      await resultPromise;

      expect(notifications).toHaveLength(0);
    });
  });
});
