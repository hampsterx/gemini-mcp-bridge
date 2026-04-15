import { maybeChunkText } from "./chunkCache.js";

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
}

function appendMetaLines(text: string, metaLines?: string[]): string {
  return metaLines && metaLines.length > 0
    ? `${text}\n\n---\n${metaLines.join("\n")}`
    : text;
}

export function formatTextResponse(options: FormatTextResponseOptions) {
  const chunked = options.enableChunking ? maybeChunkText(options.body) : { chunked: false, text: options.body };
  const finalText = chunked.chunked
    ? appendMetaLines(
      `${chunked.text}\n\n---\nResponse chunk 1/${chunked.totalChunks}\nCache key: ${chunked.cacheKey}\nUse fetch-chunk with cacheKey="${chunked.cacheKey}" and chunkIndex=2 for the next segment.`,
      options.metaLines,
    )
    : appendMetaLines(chunked.text, options.metaLines);

  return {
    content: [{
      type: "text" as const,
      text: finalText,
      _meta: {
        model: options.responseMeta.model ?? null,
        durationMs: options.responseMeta.durationMs,
        partial: options.responseMeta.partial,
        chunked: chunked.chunked || undefined,
        chunkCacheKey: chunked.cacheKey ?? null,
        chunkIndex: chunked.chunkIndex ?? null,
        totalChunks: chunked.totalChunks ?? null,
      },
    }],
  };
}
