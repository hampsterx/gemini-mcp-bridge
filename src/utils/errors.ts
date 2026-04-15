import { extractCapacityFailure } from "./parse.js";

/**
 * Non-throwing check: does this result look like a retryable quota/rate-limit error?
 * Used by the fallback wrapper to decide whether to retry with a different model.
 * Must be called BEFORE checkErrorPatterns (which throws).
 */
export function isRetryableError(exitCode: number | null, stderr: string): boolean {
  if (exitCode === 0 || !stderr) return false;
  return extractCapacityFailure(stderr) !== null;
}

/**
 * Check stderr for common Gemini CLI error patterns and throw
 * a user-friendly error. Called by all tool implementations.
 */
export function checkErrorPatterns(exitCode: number | null, stderr: string): void {
  if (exitCode !== 0 && stderr) {
    const lower = stderr.toLowerCase();
    if (lower.includes("auth") || lower.includes("credential") || lower.includes("login")) {
      throw new Error(
        `Gemini CLI authentication error. Run: gemini auth login\n\nDetails: ${stderr.trim()}`,
      );
    }
    const capacity = extractCapacityFailure(stderr);
    if (capacity) {
      throw new Error(
        `Gemini API capacity limit hit (${capacity.kind}). Wait and retry.\n\nDetails: ${capacity.message}`,
      );
    }
  }
}
