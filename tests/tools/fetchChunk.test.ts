import { beforeEach, describe, expect, it } from "vitest";
import { executeFetchChunk } from "../../src/tools/fetchChunk.js";
import { chunkCache, maybeChunkText } from "../../src/utils/chunkCache.js";

describe("executeFetchChunk", () => {
  beforeEach(() => {
    chunkCache.clear();
  });

  it("returns a requested cached chunk", async () => {
    const seeded = maybeChunkText("A".repeat(20_000), { threshold: 1_000, chunkSize: 5_000 });

    const result = await executeFetchChunk({
      cacheKey: seeded.cacheKey!,
      chunkIndex: 2,
    });

    expect(result.chunkIndex).toBe(2);
    expect(result.totalChunks).toBeGreaterThan(1);
    expect(result.chunk.length).toBeGreaterThan(0);
  });

  it("rejects invalid chunk indices", async () => {
    const seeded = maybeChunkText("A".repeat(20_000), { threshold: 1_000, chunkSize: 5_000 });

    await expect(
      executeFetchChunk({ cacheKey: seeded.cacheKey!, chunkIndex: 0 }),
    ).rejects.toThrow("positive integer");
  });

  it("rejects missing cache keys", async () => {
    await expect(
      executeFetchChunk({ cacheKey: "missing", chunkIndex: 1 }),
    ).rejects.toThrow("not found or expired");
  });
});
