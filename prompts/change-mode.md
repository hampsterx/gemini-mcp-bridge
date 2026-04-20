# Task

{{PROMPT}}

{{FILES_SECTION}}

# Output Contract (strict)

You MUST output ONLY structured edit blocks in the exact format below. Do NOT apply, write, patch, or modify any file yourself. Do NOT call any tool that mutates files. Use read-only tools (read_file, grep_search, list_directory) to gather the context you need, then emit edit blocks as text output.

Each edit block MUST use this exact format:

**FILE: <absolute-file-path>:<startLine>-<endLine>**
===OLD===
<exact original code from the file>
===NEW===
<replacement code>

Rules:
1. `<absolute-file-path>` is the absolute filesystem path of the file being edited.
2. `<startLine>-<endLine>` is the 1-based inclusive line range of the OLD block as it currently exists in the file.
3. The OLD section MUST match the current file contents exactly (every character, including whitespace and indentation). Read the file first if you are not sure.
4. The NEW section is the replacement text that should go in place of the OLD section.
5. Separate consecutive edit blocks with a single blank line.
6. Do NOT wrap edit blocks in markdown code fences (no triple backticks).
7. Do NOT add commentary between blocks. A brief preamble before the first `**FILE:` header is tolerated, but everything after the first header must be edit blocks only.
8. For pure insertions, set `<startLine>` and `<endLine>` to the single-line anchor you are replacing and include that anchor line in both OLD and NEW.
9. The `===OLD===` and `===NEW===` delimiter lines are chosen to avoid collision with code content. Emit them exactly as shown (three or more `=` signs on each side, uppercase OLD / NEW, no trailing punctuation).

{{LENGTH_LIMIT}}
