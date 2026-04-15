import { randomUUID } from "node:crypto";

export interface CachedChunkSet {
  cacheKey: string;
  chunks: string[];
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
}

export type ChunkedTextResult =
  | { chunked: false; text: string }
  | { chunked: true; text: string; cacheKey: string; chunkIndex: number; totalChunks: number };

export const CHUNK_CACHE_TTL_MS = 10 * 60 * 1000;
export const CHUNK_CACHE_MAX_ENTRIES = 50;
export const DEFAULT_CHUNK_SIZE = 8_000;
export const DEFAULT_CHUNK_THRESHOLD = 12_000;

class ChunkCache {
  private readonly entries = new Map<string, CachedChunkSet>();

  get(cacheKey: string): CachedChunkSet | undefined {
    this.pruneExpired();
    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;
    entry.lastAccessedAt = Date.now();
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    return entry;
  }

  set(chunks: string[]): CachedChunkSet {
    this.pruneExpired();
    const now = Date.now();
    const entry: CachedChunkSet = {
      cacheKey: randomUUID(),
      chunks,
      createdAt: now,
      expiresAt: now + CHUNK_CACHE_TTL_MS,
      lastAccessedAt: now,
    };
    this.entries.set(entry.cacheKey, entry);
    this.evictOverflow();
    return entry;
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > CHUNK_CACHE_MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) return;
      this.entries.delete(oldestKey);
    }
  }
}

export const chunkCache = new ChunkCache();

/**
 * Split text into bounded chunks, preferring paragraph, line, then word boundaries.
 *
 * Uses `DEFAULT_CHUNK_SIZE` unless an explicit positive integer `chunkSize` is
 * provided. The splitter prefers `\n\n`, then `\n`, then space within the last
 * 40% of the target window. If no suitable boundary is found, it falls back to a
 * hard split at the validated chunk size.
 *
 * @param text Text to split into chunk-sized segments.
 * @param chunkSize Maximum size of each chunk. Must be a positive integer.
 * @returns Ordered chunk strings whose concatenation matches the original text.
 */
export function splitIntoChunks(text: string, chunkSize = DEFAULT_CHUNK_SIZE): string[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`Invalid chunkSize ${chunkSize}. Use a positive integer such as ${DEFAULT_CHUNK_SIZE}.`);
  }

  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= chunkSize) {
      chunks.push(text.slice(cursor));
      break;
    }

    const targetEnd = cursor + chunkSize;
    const minBreak = cursor + Math.floor(chunkSize * 0.6);
    const slice = text.slice(cursor, targetEnd);

    let breakAt = slice.lastIndexOf("\n\n");
    if (breakAt < minBreak - cursor) {
      breakAt = slice.lastIndexOf("\n");
    }
    if (breakAt < minBreak - cursor) {
      breakAt = slice.lastIndexOf(" ");
    }

    let end = breakAt > 0 ? cursor + breakAt : targetEnd;
    if (breakAt > 0) {
      if (slice.startsWith("\n\n", breakAt)) {
        end += 2;
      } else if (slice.startsWith("\n", breakAt) || slice.startsWith(" ", breakAt)) {
        end += 1;
      }
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }

  return chunks;
}

/**
 * Return the original text when below threshold, otherwise cache all chunks and
 * return chunk 1 plus retrieval metadata.
 *
 * Uses `DEFAULT_CHUNK_THRESHOLD` and `DEFAULT_CHUNK_SIZE` when options are
 * omitted. When chunking occurs, all chunks are stored in `chunkCache` and the
 * returned `ChunkedTextResult` includes the cache key, 1-based chunk index, and
 * total chunk count.
 *
 * @param text Response body to inspect for chunking.
 * @param options Optional threshold and chunk size overrides.
 * @returns Either the unmodified text or the first cached chunk with metadata.
 */
export function maybeChunkText(
  text: string,
  options?: { threshold?: number; chunkSize?: number },
): ChunkedTextResult {
  const threshold = options?.threshold ?? DEFAULT_CHUNK_THRESHOLD;
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;

  if (text.length <= threshold) {
    return { chunked: false, text };
  }

  const chunks = splitIntoChunks(text, chunkSize);
  if (chunks.length <= 1) {
    return { chunked: false, text };
  }

  const entry = chunkCache.set(chunks);
  return {
    chunked: true,
    text: chunks[0],
    cacheKey: entry.cacheKey,
    chunkIndex: 1,
    totalChunks: chunks.length,
  };
}
