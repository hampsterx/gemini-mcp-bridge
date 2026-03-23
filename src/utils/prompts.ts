import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../../prompts");

/**
 * Load a prompt template from prompts/ and replace placeholders.
 * Placeholders use the format {{KEY}}. Only keys present in `vars`
 * are replaced; unknown placeholders pass through unchanged.
 */
export function loadPrompt(filename: string, vars: Record<string, string>): string {
  let result = readFileSync(resolve(PROMPTS_DIR, basename(filename)), "utf8");
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
