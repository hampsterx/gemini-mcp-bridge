import { randomUUID } from "node:crypto";

export interface CachedChunkSet {
  cacheKey: string;
  chunks: string[];
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
}

export interface ChunkedTextResult {
  chunked: boolean;
  text: string;
  cacheKey?: string;
  chunkIndex?: number;
  totalChunks?: number;
}

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

export function splitIntoChunks(text: string, chunkSize = DEFAULT_CHUNK_SIZE): string[] {
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
