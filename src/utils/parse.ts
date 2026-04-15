import stripAnsi from "strip-ansi";

export interface GeminiJsonOutput {
  /** The main text response from Gemini. */
  response: string;
  /** Raw parsed JSON (full structure from CLI). */
  raw?: unknown;
  /** Number of NDJSON stream events parsed (stream-json mode only). */
  eventCount?: number;
}

/** Output format used for all spawn calls. */
export const OUTPUT_FORMAT = "stream-json";

/**
 * Parse Gemini CLI output for legacy --output-format json mode.
 *
 * This is a fallback for CLI versions that do not support stream-json.
 * With --output-format json, the CLI writes JSON to stderr (not stdout).
 * We check both streams for JSON content.
 *
 * Strategy:
 * 1. Try parsing stdout as JSON
 * 2. Try parsing stderr as JSON (where --output-format json actually writes)
 * 3. Fall back to ANSI-stripped plain text from stdout
 * 4. Error if both streams are empty
 */
export function parseGeminiOutput(stdout: string, stderr: string): GeminiJsonOutput {
  const cleanedStdout = stripAnsi(stdout).trim();
  const cleanedStderr = stripAnsi(stderr).trim();

  // Try stdout as JSON first
  if (cleanedStdout.length > 0) {
    try {
      const parsed = JSON.parse(cleanedStdout);
      return extractFromJson(parsed);
    } catch {
      // Not JSON — will try stderr or use as plain text below
    }
  }

  // Try stderr as JSON (--output-format json writes here)
  if (cleanedStderr.length > 0) {
    try {
      const parsed = JSON.parse(cleanedStderr);
      return extractFromJson(parsed);
    } catch {
      // Full string isn't JSON — try extracting JSON object from mixed output
      // (--yolo mode may prepend progress lines before the JSON)
      const jsonStart = cleanedStderr.indexOf("{");
      const jsonEnd = cleanedStderr.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        try {
          const parsed = JSON.parse(cleanedStderr.slice(jsonStart, jsonEnd + 1));
          return extractFromJson(parsed);
        } catch {
          // Not valid JSON either
        }
      }
    }
  }

  // Plain text fallback from stdout
  if (cleanedStdout.length > 0) {
    return { response: cleanedStdout };
  }

  // No parseable output anywhere
  if (cleanedStderr.length > 0) {
    throw new Error(`Gemini CLI produced no output. stderr: ${cleanedStderr}`);
  }

  throw new Error("Gemini CLI produced no output");
}

/**
 * Extract the response text from Gemini's JSON output.
 * The schema is undocumented, so we parse defensively.
 */
function extractFromJson(parsed: unknown): GeminiJsonOutput {
  if (typeof parsed === "string") {
    return { response: parsed };
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;

    // Try common response fields
    for (const key of ["response", "text", "content", "message", "output"]) {
      if (typeof obj[key] === "string") {
        return { response: obj[key] as string, raw: parsed };
      }
    }

    // Nested: result.response or result.text
    if (obj["result"] && typeof obj["result"] === "object") {
      const result = obj["result"] as Record<string, unknown>;
      for (const key of ["response", "text", "content"]) {
        if (typeof result[key] === "string") {
          return { response: result[key] as string, raw: parsed };
        }
      }
    }

    // If it's an array (stream-json collected), join text parts
    if (Array.isArray(parsed)) {
      const texts = parsed
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            const i = item as Record<string, unknown>;
            return (i["text"] ?? i["response"] ?? i["content"] ?? "") as string;
          }
          return "";
        })
        .filter(Boolean);
      if (texts.length > 0) {
        return { response: texts.join(""), raw: parsed };
      }
    }

    // Last resort: stringify the whole thing
    return { response: JSON.stringify(parsed, null, 2), raw: parsed };
  }

  return { response: String(parsed) };
}

/** Maximum size of text to attempt JSON parsing on (1MB). */
const MAX_EXTRACT_SIZE = 1_000_000;

/**
 * Extract a JSON value from model output text.
 *
 * The model may return raw JSON, JSON inside markdown fences, or JSON
 * surrounded by explanatory text. This function tries progressively
 * looser extraction strategies.
 *
 * Returns the parsed value and the raw JSON string, or null if no
 * valid JSON could be found.
 */
export function extractJson(text: string): { json: unknown; raw: string } | null {
  if (!text || text.length > MAX_EXTRACT_SIZE) return null;

  // 1. Try parsing the full text as JSON
  try {
    return { json: JSON.parse(text), raw: text };
  } catch { /* continue */ }

  // 2. Strip markdown code fences and try the fenced content
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) {
    try {
      return { json: JSON.parse(fenced[1]), raw: fenced[1] };
    } catch { /* continue */ }
  }

  // 3. Find first {/[ and last }/] and try that slice
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  const start =
    objStart === -1 ? arrStart :
    arrStart === -1 ? objStart :
    Math.min(objStart, arrStart);
  if (start !== -1) {
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (end > start) {
      try {
        const slice = text.slice(start, end + 1);
        return { json: JSON.parse(slice), raw: slice };
      } catch { /* continue */ }
    }
  }

  return null;
}

/**
 * Parse stream-json (NDJSON) output from the Gemini CLI.
 *
 * The `--output-format stream-json` mode writes one JSON object per line to stdout:
 *   {"type":"init", ...}
 *   {"type":"message","role":"user","content":"..."}
 *   {"type":"message","role":"assistant","content":"chunk...","delta":true}
 *   {"type":"result","response":"...full assembled text","stats":{...}}
 *
 * On timeout, the "result" line may be missing. We concatenate all assistant
 * message content to produce whatever partial response was generated.
 *
 * Falls back to `parseGeminiOutput()` if no stream-json lines are found
 * (handles CLI versions that don't support stream-json).
 */
export function parseStreamJson(stdout: string, stderr: string): GeminiJsonOutput {
  const cleaned = stripAnsi(stdout).trim();
  if (!cleaned) {
    return parseGeminiOutput(stdout, stderr);
  }

  const lines = cleaned.split("\n");
  const chunks: string[] = [];
  let foundStreamLines = false;
  let eventCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj["type"]) {
        foundStreamLines = true;
        eventCount++;
      }

      // Collect assistant message content
      if (obj["type"] === "message" && obj["role"] === "assistant" && typeof obj["content"] === "string") {
        chunks.push(obj["content"] as string);
      }

      // If we got a full result line with a response field, prefer that
      if (obj["type"] === "result" && typeof obj["response"] === "string") {
        return { response: obj["response"] as string, raw: obj, eventCount };
      }
    } catch {
      // Not JSON, skip (could be progress output from --yolo mode)
    }
  }

  if (chunks.length > 0) {
    return { response: chunks.join(""), eventCount };
  }

  // No stream-json lines found, fall back to standard parsing
  if (!foundStreamLines) {
    return parseGeminiOutput(stdout, stderr);
  }

  // Had stream-json lines but no assistant content — try stderr as fallback
  return parseGeminiOutput(stdout, stderr);
}

export interface PartialParseResult {
  /** Formatted response text (with timeout prefix or cold-start hint). */
  text: string;
  /** Number of NDJSON events parsed, if any. */
  eventCount: number;
}

export interface CapacityFailure {
  kind: "rate_limit" | "service_unavailable" | "quota" | "resource_exhausted";
  statusCode?: 429 | 503;
  message: string;
}

function cleanErrorText(stderr: string): string {
  return stripAnsi(stderr).trim();
}

function normalizeCapacityMessage(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 240 ? `${singleLine.slice(0, 237)}...` : singleLine;
}

/**
 * Parse Gemini stderr and classify recognized capacity-related failures.
 *
 * Supports structured JSON payloads such as `{ error: { code, status, message } }`
 * as well as plain-text stderr containing explicit 429 / 503 / rate-limit /
 * service-unavailable / quota-exceeded signals.
 *
 * @param stderr Raw stderr text from the Gemini CLI subprocess.
 * @returns A normalized `CapacityFailure` when a known capacity pattern is
 * detected, otherwise `null`.
 */
export function extractCapacityFailure(stderr: string): CapacityFailure | null {
  const cleaned = cleanErrorText(stderr);
  if (!cleaned) return null;

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const error = (parsed.error ?? parsed) as Record<string, unknown>;
    const code = String(error.code ?? "").toUpperCase();
    const status = String(error.status ?? "").toUpperCase();
    const detail = normalizeCapacityMessage(
      String(error.message ?? error.details ?? cleaned),
    );

    if (code === "503" || status === "503" || status === "UNAVAILABLE") {
      return { kind: "service_unavailable", statusCode: 503, message: detail };
    }
    if (code === "RESOURCE_EXHAUSTED" || status === "RESOURCE_EXHAUSTED") {
      return { kind: "resource_exhausted", message: detail };
    }
    if (code === "QUOTA_EXCEEDED" || status === "QUOTA_EXCEEDED") {
      return { kind: "quota", message: detail };
    }
    if (code === "429" || status === "429") {
      return { kind: "rate_limit", statusCode: 429, message: detail };
    }
  } catch {
    // Non-JSON stderr, fall through to free-text heuristics.
  }

  const lower = cleaned.toLowerCase();
  const message = normalizeCapacityMessage(cleaned);

  if (
    lower.includes("503")
    || lower.includes("service unavailable")
  ) {
    return { kind: "service_unavailable", statusCode: 503, message };
  }

  if (lower.includes("resource_exhausted")) {
    return { kind: "resource_exhausted", message };
  }

  if (
    /quota\s+exceed(?:ed|s)?/i.test(cleaned)
    || /exceed(?:ed|s)?\s+quota/i.test(cleaned)
  ) {
    return { kind: "quota", message };
  }

  if (
    lower.includes("rate limit")
    || lower.includes("too many requests")
    || lower.includes("429")
  ) {
    return { kind: "rate_limit", statusCode: 429, message };
  }

  return null;
}

/**
 * Try to extract partial response from stream-json stdout on timeout.
 * Returns the partial content prefixed with a timeout note, or a
 * cold-start hint message if no content was captured.
 */
export function tryParsePartial(stdout: string, stderr: string, timeoutMs: number): PartialParseResult {
  const timeoutSec = Math.round(timeoutMs / 1000);
  try {
    const parsed = parseStreamJson(stdout, stderr);
    if (parsed.response.trim()) {
      return {
        text: `[Partial response, timed out after ${timeoutSec}s]\n\n${parsed.response}`,
        eventCount: parsed.eventCount ?? 0,
      };
    }
  } catch {
    // No parseable content
  }
  return {
    text: `Timed out after ${timeoutSec}s with no response. The gemini CLI may still be starting up (~15-20s cold start). Try increasing the timeout.`,
    eventCount: 0,
  };
}
