import stripAnsi from "strip-ansi";

export interface GeminiJsonOutput {
  /** The main text response from Gemini. */
  response: string;
  /** Raw parsed JSON (full structure from CLI). */
  raw?: unknown;
}

/**
 * Parse Gemini CLI output, handling JSON and plain text modes.
 *
 * With --output-format json, Gemini CLI writes JSON to stderr (not stdout).
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
