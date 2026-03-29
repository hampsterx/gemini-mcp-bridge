/**
 * Return the configured default model from GEMINI_DEFAULT_MODEL.
 * Treats empty/whitespace-only strings as unset.
 */
export function getDefaultModel(): string | undefined {
  return process.env["GEMINI_DEFAULT_MODEL"]?.trim() || undefined;
}

/**
 * Resolve the Gemini model to use, applying precedence:
 * 1. Explicit `model` parameter (caller override)
 * 2. `GEMINI_DEFAULT_MODEL` env var (server-level default)
 * 3. undefined (let the CLI use its own default)
 */
export function resolveModel(explicit?: string): string | undefined {
  return explicit?.trim() || getDefaultModel();
}
