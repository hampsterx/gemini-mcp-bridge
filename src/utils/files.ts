import { readFile } from "node:fs/promises";
import {
  resolveAndVerify,
  checkFileSize,
  MAX_FILE_SIZE,
  MAX_FILES,
} from "./security.js";

export interface FileContent {
  path: string;
  content: string;
  skipped?: string;
}

/**
 * Read multiple files with path sandboxing and size limits.
 * Returns file contents assembled for prompt inclusion.
 */
export async function readFiles(
  files: string[],
  rootDir: string,
): Promise<FileContent[]> {
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files: ${files.length} (max ${MAX_FILES})`);
  }

  const results: FileContent[] = [];

  for (const f of files) {
    const resolved = await resolveAndVerify(f, rootDir);
    const size = await checkFileSize(resolved);

    if (size > MAX_FILE_SIZE) {
      results.push({
        path: f,
        content: "",
        skipped: `${(size / 1024).toFixed(0)}KB exceeds ${(MAX_FILE_SIZE / 1024).toFixed(0)}KB limit`,
      });
      continue;
    }

    const content = await readFile(resolved, "utf8");
    results.push({ path: f, content });
  }

  return results;
}

/**
 * Assemble a prompt with file contents for Gemini.
 */
export function assemblePrompt(prompt: string, fileContents: FileContent[]): string {
  if (fileContents.length === 0) return prompt;

  const parts = fileContents.map((f) => {
    if (f.skipped) {
      return `--- ${f.path} ---\n[SKIPPED: ${f.skipped}]`;
    }
    return `--- ${f.path} ---\n${f.content}`;
  });

  return `${prompt}\n\n${parts.join("\n\n")}`;
}
