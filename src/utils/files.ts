import path from "node:path";
import { resolveAndVerify, checkFileSize, MAX_FILE_SIZE } from "./security.js";

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
 * Verify file paths exist, are within the allowed root directory, and
 * are under the size limit. Returns verified paths and error messages
 * for any that failed. Defense-in-depth: the CLI also validates paths,
 * but catching oversized files here avoids wasting Gemini's token budget.
 */
export async function verifyFilePaths(
  files: string[],
  rootDir: string,
): Promise<VerifiedFiles> {
  const results = await Promise.all(
    files.map(async (f): Promise<{ verified: string } | { skipped: string }> => {
      try {
        const resolved = await resolveAndVerify(f, rootDir);
        const size = await checkFileSize(resolved);
        if (size > MAX_FILE_SIZE) {
          return { skipped: `${f}: ${(size / 1024).toFixed(0)}KB exceeds ${(MAX_FILE_SIZE / 1024).toFixed(0)}KB limit` };
        }
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
