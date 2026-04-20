import path from "node:path";
import { realpathSync, statSync, readFileSync } from "node:fs";

/**
 * A single structured edit emitted by the `query` tool in change mode.
 *
 * `filename` is always a path relative to the working directory used for the
 * query. `startLine` / `endLine` are 1-based inclusive line numbers of the
 * OLD block in the file. When Gemini emits a bare `**FILE: <path>**` header
 * (no line range), the parser searches the file for `oldCode` and fills in
 * the inferred range; if the file can't be read or no match is found, that
 * edit is rejected.
 */
export interface ChangeModeEdit {
  filename: string;
  startLine: number;
  endLine: number;
  oldCode: string;
  newCode: string;
}

/** Header regex for the primary format: `**FILE: <path>:<start>-<end>**`. */
const FILE_HEADER_WITH_RANGE = /^\*\*FILE:\s+(.+?):(\d+)-(\d+)\*\*\s*$/;

/** Header regex for the bare fallback: `**FILE: <path>**` (no line range). */
const FILE_HEADER_BARE = /^\*\*FILE:\s+(.+?)\*\*\s*$/;

/** Any `**FILE:` header on its own line. Used for quick block detection. */
const ANY_FILE_HEADER = /^\*\*FILE:\s+.+\*\*\s*$/;

export interface ParseResult {
  edits: ChangeModeEdit[];
}

export interface ParseOptions {
  /** Working directory. Paths are resolved and validated against this root. */
  workingDirectory: string;
}

class ChangeModeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeModeParseError";
  }
}

interface RawBlock {
  headerLine: string;
  body: string[];
}

/**
 * Split raw text into ordered edit blocks, tolerating arbitrary prose before
 * the first `**FILE:` header. Lines before the first header are dropped.
 */
function splitIntoBlocks(text: string): RawBlock[] {
  // Normalize line endings before splitting so CRLF output doesn't leak
  // `\r` characters into oldCode/newCode, which would break downstream
  // exact-match applicators that read files with LF endings. Lone CRs
  // (classic-Mac) are converted to LF, not dropped, so adjacent content
  // stays on its own line.
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;

  for (const line of lines) {
    if (ANY_FILE_HEADER.test(line)) {
      if (current) blocks.push(current);
      current = { headerLine: line, body: [] };
      continue;
    }
    if (current) {
      current.body.push(line);
    }
  }

  if (current) blocks.push(current);
  return blocks;
}

/**
 * Markers that delimit the OLD / NEW sections inside an edit block. We use
 * `===OLD===` and `===NEW===` rather than bare `OLD:` / `NEW:` so the
 * markers are very unlikely to collide with lines that appear naturally in
 * source code (YAML keys, dict labels, docstrings). Legacy `OLD:` / `NEW:`
 * markers are still accepted as a fallback for Gemini outputs that predate
 * this change.
 */
const OLD_MARKER = /^={3,}\s*OLD\s*={3,}\s*$/;
const NEW_MARKER = /^={3,}\s*NEW\s*={3,}\s*$/;
const LEGACY_OLD_MARKER = /^OLD:\s*$/;
const LEGACY_NEW_MARKER = /^NEW:\s*$/;

/**
 * Parse a block body into `oldCode` / `newCode` strings. Expects the body to
 * contain `OLD:` and `NEW:` marker lines (in that order). Leading/trailing
 * blank lines inside each section are trimmed off but internal blank lines
 * are preserved.
 */
function parseBody(body: string[]): { oldCode: string; newCode: string } {
  // Decide which marker family this block uses, based on what appears first.
  // We commit to one family per block so the `OLD:` substring inside code
  // doesn't end a `===OLD===` section prematurely.
  const family = detectMarkerFamily(body);
  const oldRe = family === "legacy" ? LEGACY_OLD_MARKER : OLD_MARKER;
  const newRe = family === "legacy" ? LEGACY_NEW_MARKER : NEW_MARKER;

  let mode: "preamble" | "old" | "new" = "preamble";
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of body) {
    if (mode === "preamble" && oldRe.test(line)) {
      mode = "old";
      continue;
    }
    if (mode === "old" && newRe.test(line)) {
      mode = "new";
      continue;
    }
    if (mode === "old") oldLines.push(line);
    else if (mode === "new") newLines.push(line);
    // else: preamble before OLD marker is ignored (shouldn't happen in valid output)
  }

  if (mode === "preamble") {
    throw new ChangeModeParseError("Missing OLD marker in edit block");
  }
  if (mode === "old") {
    throw new ChangeModeParseError("Missing NEW marker in edit block");
  }

  return {
    oldCode: stripSurroundingBlankLines(oldLines).join("\n"),
    newCode: stripSurroundingBlankLines(newLines).join("\n"),
  };
}

/**
 * Pick a marker family for this block: prefer the new `===OLD===` /
 * `===NEW===` if either shows up, otherwise fall back to legacy `OLD:` /
 * `NEW:`. Committing per-block avoids the collision where a `NEW:` line
 * inside OLD code prematurely ends the section: if the block uses
 * `===OLD===`, we ignore stray `NEW:` lines entirely.
 */
function detectMarkerFamily(body: string[]): "legacy" | "fenced" {
  for (const line of body) {
    if (OLD_MARKER.test(line) || NEW_MARKER.test(line)) return "fenced";
  }
  return "legacy";
}

function stripSurroundingBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * Resolve a path emitted by Gemini against `rootDir` and verify it's within
 * the root. Gemini typically emits absolute paths; we accept absolute or
 * relative and always return the path relative to `rootDir`.
 *
 * Uses synchronous realpath so this runs inside the synchronous parsing
 * pipeline. File existence is required — a missing file rejects the edit.
 */
function resolveRelative(rawPath: string, rootDir: string): string {
  const resolvedRoot = realpathSync(rootDir);
  const absolute = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(resolvedRoot, rawPath);

  let resolved: string;
  try {
    resolved = realpathSync(absolute);
  } catch {
    throw new ChangeModeParseError(`File not found: ${rawPath}`);
  }

  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new ChangeModeParseError(
      `Path traversal blocked: "${rawPath}" resolves outside working directory`,
    );
  }

  const rel = path.relative(resolvedRoot, resolved);
  return rel === "" ? "." : rel;
}

/**
 * Read an inclusive 1-based line range from a file, normalising line endings
 * to LF. Returns null if the file can't be read or the range extends beyond
 * EOF. Used to verify that an explicit `**FILE: <path>:<start>-<end>**`
 * header actually points at the OLD block.
 */
function readLineRange(
  absolutePath: string,
  startLine: number,
  endLine: number,
): string | null {
  let content: string;
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) return null;
    content = readFileSync(absolutePath, "utf8").replace(/\r\n?/g, "\n");
  } catch {
    return null;
  }
  const lines = content.split("\n");
  // Files usually end with a trailing newline, producing an empty final entry.
  // Ignore that entry for range-end validation so `endLine` up to the last
  // real line is accepted.
  const lastRealLine = lines.length > 0 && lines[lines.length - 1] === ""
    ? lines.length - 1
    : lines.length;
  if (endLine > lastRealLine) return null;
  return lines.slice(startLine - 1, endLine).join("\n");
}

/**
 * Search a file on disk for `oldCode` and return the 1-based inclusive line
 * range of the first exact match. Used for bare `**FILE: <path>**` headers
 * that omit the line range. Returns null when the file can't be read or the
 * content isn't found verbatim.
 */
function inferRangeFromContent(
  absolutePath: string,
  oldCode: string,
): { startLine: number; endLine: number } | null {
  // `indexOf("")` returns 0, which would silently anchor an empty-OLD edit
  // to line 1 and corrupt any caller applying the edit. Reject instead and
  // let the block fall through to the empty-OLD-AND-NEW guard in the
  // primary parser.
  if (oldCode.length === 0) return null;

  let content: string;
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) return null;
    // Normalize file content to LF so CRLF files match LF-normalized oldCode.
    // Keeping parse-side normalization asymmetric with the file side silently
    // rejects every multi-line bare-header edit on Windows checkouts.
    content = readFileSync(absolutePath, "utf8").replace(/\r\n?/g, "\n");
  } catch {
    return null;
  }

  const idx = content.indexOf(oldCode);
  if (idx === -1) return null;

  const before = content.slice(0, idx);
  const startLine = before.split("\n").length;
  const oldLineCount = oldCode.split("\n").length;
  const endLine = startLine + oldLineCount - 1;
  return { startLine, endLine };
}

/**
 * Parse Gemini change-mode output into structured edits.
 *
 * Expects zero or more edit blocks in the form:
 *
 *     **FILE: <absolute-path>:<start>-<end>**
 *     OLD:
 *     <exact original code>
 *     NEW:
 *     <replacement code>
 *
 * Prose before the first `**FILE:` marker is ignored. Bare `**FILE: <path>**`
 * headers (no line range) are accepted as a fallback: the parser reads the
 * file and searches for `oldCode` to infer the range. Paths must resolve
 * inside `options.workingDirectory`; paths outside the root are rejected.
 *
 * Throws on:
 *   - Zero edit blocks found (no `**FILE:` marker anywhere in the text)
 *   - A block missing `OLD:` or `NEW:` markers
 *   - An empty OLD or NEW section
 *   - A header with a malformed line range
 *   - An invalid or out-of-root path
 *   - A bare header whose `oldCode` can't be located in the referenced file
 *   - Overlapping or equal line ranges within the same file
 */
export function parseChangeModeOutput(
  text: string,
  options: ParseOptions,
): ParseResult {
  const rawBlocks = splitIntoBlocks(text);
  if (rawBlocks.length === 0) {
    throw new ChangeModeParseError("No edit blocks found in response");
  }

  const resolvedRoot = realpathSync(options.workingDirectory);
  const edits: ChangeModeEdit[] = [];

  for (const block of rawBlocks) {
    const withRange = FILE_HEADER_WITH_RANGE.exec(block.headerLine);
    const bare = withRange ? null : FILE_HEADER_BARE.exec(block.headerLine);

    if (!withRange && !bare) {
      throw new ChangeModeParseError(`Unparseable FILE header: ${block.headerLine.trim()}`);
    }

    const rawPath = (withRange ? withRange[1] : bare![1]).trim();
    const filename = resolveRelative(rawPath, resolvedRoot);

    const { oldCode, newCode } = parseBody(block.body);

    if (oldCode.length === 0 && newCode.length === 0) {
      throw new ChangeModeParseError(
        `Empty OLD: and NEW: sections for ${filename}`,
      );
    }

    let startLine: number;
    let endLine: number;
    if (withRange) {
      startLine = parseInt(withRange[2], 10);
      endLine = parseInt(withRange[3], 10);
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) {
        throw new ChangeModeParseError(
          `Invalid line range ${withRange[2]}-${withRange[3]} for ${filename}`,
        );
      }
      // Verify the declared line range actually contains the OLD block.
      // Catches hallucinated line numbers where Gemini emits a syntactically
      // valid but semantically wrong range. Only enforced for non-empty
      // oldCode (pure insertions via anchor-line convention are allowed).
      if (oldCode.length > 0) {
        const slice = readLineRange(
          path.resolve(resolvedRoot, filename),
          startLine,
          endLine,
        );
        if (slice === null) {
          throw new ChangeModeParseError(
            `Range ${startLine}-${endLine} for ${filename}: cannot read file to verify OLD block`,
          );
        }
        if (slice !== oldCode) {
          throw new ChangeModeParseError(
            `Range ${startLine}-${endLine} for ${filename}: OLD block does not match file contents at that range`,
          );
        }
      }
    } else {
      const inferred = inferRangeFromContent(
        path.resolve(resolvedRoot, filename),
        oldCode,
      );
      if (!inferred) {
        throw new ChangeModeParseError(
          `Bare header for ${filename}: could not locate OLD block in file`,
        );
      }
      startLine = inferred.startLine;
      endLine = inferred.endLine;
    }

    edits.push({ filename, startLine, endLine, oldCode, newCode });
  }

  rejectOverlaps(edits);
  return { edits };
}

/**
 * Reject edits that overlap within the same file. Edits in different files
 * are independent.
 */
function rejectOverlaps(edits: ChangeModeEdit[]): void {
  const byFile = new Map<string, ChangeModeEdit[]>();
  for (const edit of edits) {
    const list = byFile.get(edit.filename) ?? [];
    list.push(edit);
    byFile.set(edit.filename, list);
  }

  for (const [filename, list] of byFile) {
    const sorted = [...list].sort((a, b) => a.startLine - b.startLine);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.startLine <= prev.endLine) {
        throw new ChangeModeParseError(
          `Overlapping edits in ${filename}: ${prev.startLine}-${prev.endLine} and ${cur.startLine}-${cur.endLine}`,
        );
      }
    }
  }
}

export { ChangeModeParseError };
