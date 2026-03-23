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
    if (lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("429") || lower.includes("quota")) {
      throw new Error(
        `Gemini API rate limit hit. Wait and retry.\n\nDetails: ${stderr.trim()}`,
      );
    }
  }
}
