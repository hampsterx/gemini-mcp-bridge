import { chunkCache } from "../utils/chunkCache.js";

export interface FetchChunkInput {
  cacheKey: string;
  chunkIndex: number;
  workingDirectory?: string;
}

export interface FetchChunkResult {
  chunk: string;
  cacheKey: string;
  chunkIndex: number;
  totalChunks: number;
  expiresAt: number;
}

/**
 * Fetch a cached response chunk from an earlier chunked tool result.
 */
export async function executeFetchChunk(input: FetchChunkInput): Promise<FetchChunkResult> {
  const entry = chunkCache.get(input.cacheKey);
  if (!entry) {
    throw new Error(
      `Chunk cache entry not found or expired for cacheKey "${input.cacheKey}". Re-run query, review, or search to get a fresh cacheKey, then call fetch-chunk again.`,
    );
  }

  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 1) {
    throw new Error(
      `Invalid chunkIndex "${input.chunkIndex}". Use a positive integer starting at 1, and parse client input before calling fetch-chunk.`,
    );
  }

  if (input.chunkIndex > entry.chunks.length) {
    throw new Error(
      `chunkIndex ${input.chunkIndex} is out of range for cacheKey "${input.cacheKey}". Valid range is 1-${entry.chunks.length}. Use the total chunk count from the original response or re-run the source operation to refresh the cache.`,
    );
  }

  return {
    chunk: entry.chunks[input.chunkIndex - 1],
    cacheKey: entry.cacheKey,
    chunkIndex: input.chunkIndex,
    totalChunks: entry.chunks.length,
    expiresAt: entry.expiresAt,
  };
}
