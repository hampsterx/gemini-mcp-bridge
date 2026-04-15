import { chunkCache } from "../utils/chunkCache.js";

export interface FetchChunkInput {
  cacheKey: string;
  chunkIndex: number;
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
    throw new Error("Chunk cache entry not found or expired");
  }

  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 1) {
    throw new Error("chunkIndex must be a positive integer");
  }

  if (input.chunkIndex > entry.chunks.length) {
    throw new Error(`chunkIndex ${input.chunkIndex} out of range (max ${entry.chunks.length})`);
  }

  return {
    chunk: entry.chunks[input.chunkIndex - 1],
    cacheKey: entry.cacheKey,
    chunkIndex: input.chunkIndex,
    totalChunks: entry.chunks.length,
    expiresAt: entry.expiresAt,
  };
}
