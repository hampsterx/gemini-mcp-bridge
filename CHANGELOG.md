# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
