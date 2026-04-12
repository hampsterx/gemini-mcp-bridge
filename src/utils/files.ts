import path from "node:path";
import { resolveAndVerify } from "./security.js";

/** Maximum file size for image files (5MB). */
export const MAX_IMAGE_FILE_SIZE = 5_000_000;

/** Extensions treated as image files (binary, passed by path to CLI). */
export const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
]);

/**
 * Check whether a file path refers to an image based on extension.
 */
export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface VerifiedFiles {
  /** Paths that passed validation (original relative paths). */
  verified: string[];
  /** Paths that failed with "path: reason" messages. */
  skipped: string[];
}

/**
 * Verify file paths exist and are within the allowed root directory.
 * Returns verified paths and error messages for any that failed.
 * This is fail-fast defense-in-depth; the CLI also validates paths.
 */
export async function verifyFilePaths(
  files: string[],
  rootDir: string,
): Promise<VerifiedFiles> {
  const results = await Promise.all(
    files.map(async (f): Promise<{ verified: string } | { skipped: string }> => {
      try {
        await resolveAndVerify(f, rootDir);
        return { verified: f };
      } catch (err) {
        return { skipped: `${f}: ${(err as Error).message}` };
      }
    }),
  );

  return {
    verified: results.filter((r): r is { verified: string } => "verified" in r).map((r) => r.verified),
    skipped: results.filter((r): r is { skipped: string } => "skipped" in r).map((r) => r.skipped),
  };
}

/**
 * Build @{path} file reference hints for agentic mode prompts.
 * The Gemini CLI interprets @{path} as read_file targets.
 */
export function buildFileHints(files: string[]): string {
  if (files.length === 0) return "";
  const refs = files.map((f) => `@{${f}}`).join("\n");
  return `\n\nReferenced files:\n${refs}`;
}
