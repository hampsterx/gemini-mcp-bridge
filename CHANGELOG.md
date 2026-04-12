# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Always-agentic query and structured tools**: Both `query` and `structured` now run in agentic mode by default (`--approval-mode plan`). Gemini launches inside the working directory with read_file, grep, list_directory, and glob tools, exploring the repo for context instead of receiving pre-inlined file blobs. Text files are passed as `@{path}` hints, not inlined content. Image queries still use `--yolo` for native pixel access.
- **Default timeout raised to 120s** for both `query` and `structured` (was 60s for text queries). Plan mode boots the CLI tool system, which adds to the ~16s cold start.
- **Tool descriptions updated**: Both tools now explicitly describe themselves as agentic. The `files` parameter documentation clarifies that contents are NOT inlined.
- **Footer label**: `Files included:` renamed to `Files hinted:` in tool responses to reflect the new semantics (paths passed, Gemini may or may not have read them).

### Removed
- **File content inlining**: `readFiles()` and `assemblePrompt()` removed from `src/utils/files.ts`. No text file content is pre-read or inlined into prompts.

### Note
- **Gitignored files are unreadable** in text-query mode (plan mode restriction). Image queries (`--yolo`) can still read gitignored files. This is a CLI-level constraint with no bypass.
- **Breaking for callers relying on guaranteed file reads**: Gemini now decides which hinted files are relevant. If a file isn't pertinent to the query, Gemini may skip it. Callers who depended on "Gemini definitely saw the contents of file X" should verify via the response.

## [0.2.8] - 2026-04-12

### Fixed
- **npm publish workflow**: Run `npm publish` via `npx --yes npm@latest` instead of corepack. OIDC trusted publishing requires npm ≥ 11.5.1 but Node 22 ships with npm 10.9.7, and neither `npm install -g npm@latest` (v0.2.6, self-upgrade race breaks `promise-retry`) nor `corepack prepare npm@latest --activate` (v0.2.7, doesn't reroute `npm` without a `packageManager` field in `package.json`) actually got a modern npm onto PATH. npx downloads the package fresh into a temp dir and runs its bin directly, which sidesteps both problems.

### Note
- v0.2.6 and v0.2.7 never reached the registry: both publish jobs aborted before `npm publish` completed. `npm view gemini-mcp-bridge version` still shows 0.2.5 immediately before this release.

## [0.2.5] - 2026-04-08

## [0.2.5] - 2026-04-08

### Added
- **MCP tool annotations**: Tools declare `readOnlyHint`, `destructiveHint`, `openWorldHint`, and `idempotentHint` so MCP clients can make informed permission and caching decisions.
- **Execution metadata**: All tool results now include `executionTime`, `timedOut`, and `resolvedModel` fields alongside the response.
- **Rich tool descriptions**: Tool descriptions include parameter docs and usage examples, rendered inline for clients that display them.
- **Progress heartbeats**: Long-running operations emit MCP progress notifications so clients can show activity indicators instead of appearing stalled.
- **MCP transport wiring tests**: 7 new tests verifying server tool registration, stdio transport, and progress token propagation.
- **CI smoke step**: `npm run smoke:ci` runs a minimal MCP handshake in CI to catch wiring regressions.

## [0.2.4] - 2026-04-05

### Added
- **Stream-JSON output format**: Switch from `--output-format json` to `--output-format stream-json` (NDJSON) for progressive capture. Timeouts now return partial responses instead of generic error messages.
- **Smoke test script**: `npm run smoke` / `scripts/smoke-test.mjs` for testing tool functions directly without restarting the MCP client. Supports all four tools with configurable workingDirectory.
- **Resolved working directory**: All tool results now include `resolvedCwd` showing the actual directory used after git root resolution and path validation.
- **Latency budget documentation**: Document ~16s CLI cold start, per-layer timing breakdown, and implications for timeout configuration in CLAUDE.md and README.

### Changed
- `parseStreamJson()` replaces `parseGeminiOutput()` as the primary parser, with automatic fallback to legacy JSON parsing for older CLI versions.
- `tryParsePartial()` extracts partial content from NDJSON on timeout, forwarding stderr for fallback parsing.
- Smoke test timeouts aligned with real CLI cold start times (60-120s).

## [0.2.3] - 2026-03-30

### Added
- **Response length awareness**: Optional `maxResponseLength` parameter (in words) on query, search, and review tools. Appends a soft length instruction to the prompt.
- Conciseness guidance in review and search prompt templates to reduce verbose output by default.
- `buildLengthLimit()` and `appendLengthLimit()` helpers in `src/utils/prompts.ts`.
- `GEMINI_DEFAULT_MODEL` env var support for default model selection.
- Auto-retry with fallback model on quota exhaustion (`GEMINI_FALLBACK_MODEL` env var).
- 10 new tests for response length controls.

### Changed
- `maxResponseLength` zod schemas enforce `.int().positive()`.

## [0.2.2] - 2026-03-25

### Added
- **`search` tool**: Google Search grounded queries. Spawns CLI in agentic mode with `google_web_search`, synthesizes answers with source URLs. Default 120s timeout.
- **`structured` tool**: JSON output conforming to a provided JSON Schema, with validation.
- **Image support in `query`**: Image files (png, jpg, jpeg, gif, webp, bmp) trigger agentic mode so the CLI reads them natively. Text files still inlined as before. Mixed text+image queries supported. 5MB size limit for images (vs 1MB for text).
- `src/utils/errors.ts`: Shared `checkErrorPatterns()` for consistent auth/rate-limit error handling across all tools.
- `isImageFile()` and `IMAGE_EXTENSIONS` helpers in `src/utils/files.ts`.
- 23 new tests (query tool: 11, search tool: 8, isImageFile: 4).

### Fixed
- Review tool now checks for rate-limit/quota errors (previously only checked auth errors).

### Changed
- File reads in `readFiles()` run in parallel via `Promise.all` instead of sequentially.
- Image path validation runs in parallel.

## [0.2.1] - 2026-03-18

### Changed
- Review prompts extracted from inline template literals to standalone markdown files in `prompts/`, loaded at runtime via `loadPrompt()`.

### Fixed
- Prompt placeholder replacement no longer corrupts diffs containing `{{word}}` patterns (Handlebars, Go templates, etc.).
- `loadPrompt` now uses `basename()` to prevent path traversal.

### Added
- 9 tests for prompt template loading and placeholder substitution.

## [0.2.0] - 2026-03-18

### Added
- **Agentic code review** (default): Spawns Gemini CLI with `--yolo` inside the target repo. The CLI runs `git diff` itself, reads full files, follows imports, checks tests, and reads project instruction files (CLAUDE.md, GEMINI.md, AGENTS.md, etc.) for context-aware reviews.
- `quick` parameter on review tool: set `true` to skip repo exploration and get a fast diff-only review (previous behavior).
- `focus` parameter on review tool: direct attention to specific areas (e.g. "security", "performance", "error handling").
- Bundled `policies/review.toml` for future policy-based shell filtering (waiting on upstream CLI fix google-gemini/gemini-cli#20469).

### Fixed
- JSON output parsing: Gemini CLI with `--output-format json` writes JSON to stderr in newer versions. Parser now checks both stdout and stderr.

## [0.1.1] - 2026-03-17

### Fixed
- `ping` auth detection: validate OAuth cred types instead of trusting shape
- Return "unknown" for malformed/partial OAuth creds (missing both refresh_token and expiry_date)
- Distinguish ENOENT (return "missing") from parse/permission errors (return "unknown") in catch block

## [0.1.0] - 2026-03-16

### Added
- `query` tool: one-shot Gemini queries with optional file context
- `review` tool: code review via native git-diff sent to Gemini
- `ping` tool: health check and CLI capability detection
- Hardened subprocess environment (minimal env allowlist)
- Path sandboxing (realpath validation, traversal prevention)
- Concurrency limiter (max 3 concurrent spawns, FIFO queue)
- Configurable timeouts with 600s hard cap
- JSON output parsing with ANSI-strip fallback
