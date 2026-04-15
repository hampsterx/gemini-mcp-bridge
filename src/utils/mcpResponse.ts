import { maybeChunkText } from "./chunkCache.js";
import type { ChunkedTextResult } from "./chunkCache.js";

export interface ResponseMeta {
  durationMs: number;
  model?: string | null;
  partial: boolean;
}

export interface FormatTextResponseOptions {
  body: string;
  metaLines?: string[];
  responseMeta: ResponseMeta;
  enableChunking?: boolean;
  extraMeta?: Record<string, unknown>;
}

function appendMetaLines(text: string, metaLines?: string[]): string {
  return metaLines && metaLines.length > 0
    ? `${text}\n\n---\n${metaLines.join("\n")}`
    : text;
}

/**
 * Format an MCP text response with optional footer metadata and optional
 * first-chunk pagination for oversized outputs.
 *
 * When `enableChunking` is true, the function calls `maybeChunkText()` on the
 * body only, then appends standard footer metadata after the chunk instructions
 * so key lines like working directory and model remain visible in the initial
 * response.
 *
 * @param options Formatting options including body text, footer metadata, and response meta.
 * @returns MCP-compatible content with `_meta` fields for timing, model, and chunk state.
 */
export function formatTextResponse(options: FormatTextResponseOptions) {
  const chunked: ChunkedTextResult = options.enableChunking
    ? maybeChunkText(options.body)
    : { chunked: false, text: options.body };

  let finalText = appendMetaLines(chunked.text, options.metaLines);
  if (chunked.chunked) {
    finalText = appendMetaLines(
      `${chunked.text}\n\n---\nResponse chunk 1/${chunked.totalChunks}\nCache key: ${chunked.cacheKey}\nUse fetch-chunk with cacheKey="${chunked.cacheKey}" and chunkIndex=2 for the next segment.`,
      options.metaLines,
    );
  }

  const chunkMeta = chunked.chunked
    ? {
      chunked: true,
      chunkCacheKey: chunked.cacheKey,
      chunkIndex: chunked.chunkIndex,
      totalChunks: chunked.totalChunks,
    }
    : {
      chunked: undefined,
      chunkCacheKey: null,
      chunkIndex: null,
      totalChunks: null,
    };

  return {
    content: [{
      type: "text" as const,
      text: finalText,
      _meta: {
        model: options.responseMeta.model ?? null,
        durationMs: options.responseMeta.durationMs,
        partial: options.responseMeta.partial,
        chunked: chunkMeta.chunked,
        chunkCacheKey: chunkMeta.chunkCacheKey,
        chunkIndex: chunkMeta.chunkIndex,
        totalChunks: chunkMeta.totalChunks,
        ...(options.extraMeta ?? {}),
      },
    }],
  };
}
