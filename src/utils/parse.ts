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
 * Strategy:
 * 1. Try parsing as JSON (--output-format json)
 * 2. Fall back to ANSI-stripped plain text
 */
export function parseGeminiOutput(stdout: string, stderr: string): GeminiJsonOutput {
  const cleaned = stripAnsi(stdout).trim();

  // Try JSON parse first
  try {
    const parsed = JSON.parse(cleaned);
    return extractFromJson(parsed);
  } catch {
    // Not JSON — treat as plain text response
  }

  // Plain text fallback
  if (cleaned.length > 0) {
    return { response: cleaned };
  }

  // No stdout — check stderr for useful info
  const cleanedStderr = stripAnsi(stderr).trim();
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
