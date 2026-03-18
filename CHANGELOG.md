# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
