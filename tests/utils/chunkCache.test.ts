import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHUNK_CACHE_MAX_ENTRIES,
  CHUNK_CACHE_TTL_MS,
  chunkCache,
  maybeChunkText,
  splitIntoChunks,
} from "../../src/utils/chunkCache.js";

describe("chunkCache", () => {
  beforeEach(() => {
    vi.useRealTimers();
    chunkCache.clear();
  });

  it("does not chunk short text", () => {
    const result = maybeChunkText("short text");
    expect(result.chunked).toBe(false);
    expect(result.text).toBe("short text");
  });

  it("chunks long text and stores it in cache", () => {
    const text = `${"A".repeat(8_000)}\n\n${"B".repeat(8_000)}`;
    const result = maybeChunkText(text, { threshold: 1_000, chunkSize: 8_000 });

    expect(result.chunked).toBe(true);
    expect(result.cacheKey).toBeTruthy();
    expect(result.totalChunks).toBeGreaterThan(1);

    const cached = chunkCache.get(result.cacheKey!);
    expect(cached?.chunks[0]).toBe(result.text);
  });

  it("expires old entries on read", () => {
    vi.useFakeTimers();
    const result = maybeChunkText("X".repeat(20_000), { threshold: 1_000, chunkSize: 5_000 });
    expect(result.cacheKey).toBeTruthy();

    vi.advanceTimersByTime(CHUNK_CACHE_TTL_MS + 1);
    expect(chunkCache.get(result.cacheKey!)).toBeUndefined();
  });

  it("evicts least recently used entries when full", () => {
    const keys: string[] = [];
    for (let i = 0; i < CHUNK_CACHE_MAX_ENTRIES; i += 1) {
      const result = maybeChunkText(String(i).repeat(20_000), { threshold: 1_000, chunkSize: 4_000 });
      keys.push(result.cacheKey!);
    }

    chunkCache.get(keys[1]);
    const overflow = maybeChunkText("overflow".repeat(5_000), { threshold: 1_000, chunkSize: 4_000 });

    expect(chunkCache.size()).toBe(CHUNK_CACHE_MAX_ENTRIES);
    expect(chunkCache.get(keys[0])).toBeUndefined();
    expect(chunkCache.get(keys[1])).toBeDefined();
    expect(chunkCache.get(overflow.cacheKey!)).toBeDefined();
  });

  it("prefers natural boundaries when splitting", () => {
    const text = `alpha\nbeta\n\n${"gamma ".repeat(3000)}`;
    const chunks = splitIntoChunks(text, 8_000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(8_000);
    expect(chunks.join("")).toBe(text);
  });

  it("preserves newline delimiters when splitting on paragraph boundaries", () => {
    const text = `${"A".repeat(4_100)}\n\n${"B".repeat(4_100)}`;
    const chunks = splitIntoChunks(text, 5_000);

    expect(chunks.length).toBe(2);
    expect(chunks.join("")).toBe(text);
    expect(chunks[0].endsWith("\n\n")).toBe(true);
  });
});
