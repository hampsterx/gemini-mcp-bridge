# Design

Architecture and implementation details for gemini-mcp-bridge.

## Architecture

```
MCP Client  --stdio-->  gemini-mcp-bridge  --spawn-->  gemini CLI subprocess
```

The bridge assembles prompts in TypeScript and spawns the Gemini CLI as a subprocess. The CLI runs in agentic mode inside the target repo, using its built-in tools (read_file, grep_search, list_directory, google_web_search) to explore code or the web for context. The bridge captures output, parses it, and returns structured MCP responses.

## Subprocess Spawning

- Always `spawn()` with `shell: false`, args as array (never `exec()`)
- Large prompts piped via stdin to avoid `ARG_MAX` limits
- `-p` flag used only for short prompts
- Kill process group on timeout: SIGTERM, 5s grace period, then SIGKILL
- `NODE_OPTIONS=--max-old-space-size=8192` is set for every spawn (without it, GC pressure nearly doubles wall time)

## Output Streaming (NDJSON)

The bridge uses `--output-format stream-json` for progressive capture of CLI output. Each line is a JSON object with partial content.

On timeout, the bridge parses whatever NDJSON lines were captured and returns partial content prefixed with `[Partial response, timed out after Xs ...]`. This is a key differentiator: callers always get something back, even from slow operations.

Falls back to legacy JSON parsing (stdout then stderr) for older CLI versions. Tolerates malformed JSON and extracts response text from partial output.

## Concurrency

Requests are managed by a FIFO queue:
- **Max concurrent**: 3 subprocess spawns (configurable via `GEMINI_MAX_CONCURRENT`)
- **Queue timeout**: 30s (requests that can't acquire a slot within 30s are rejected)
- **Timeout enforcement**: Per-tool defaults, 1800s (30 min) hard cap

## Model Fallback

When the primary model returns a quota or rate-limit error, the bridge automatically retries with `GEMINI_FALLBACK_MODEL` (default: `gemini-2.5-flash`). Set to `none` to disable. Fallback usage is indicated in the response text footer and by the `_meta.model` field reflecting the actual model used.

## Response Metadata

All tools attach an `_meta` object to the MCP `CallToolResult`:

| Field | Type | Description |
|-------|------|-------------|
| `durationMs` | number | Wall-clock execution time |
| `model` | string | Model used for this call |
| `partial` | boolean | Whether the response was truncated by timeout |

The `_meta.model` field reflects the model actually used, so callers can detect fallback by comparing it against the requested model.

## MCP Annotations

All tools declare [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) so clients can make informed permission and safety decisions:

| Tool | readOnlyHint | destructiveHint | openWorldHint |
|------|-------------|----------------|---------------|
| query | true | false | true |
| search | true | false | true |
| review | true | false | true |
| structured | true | false | true |
| ping | true | false | false |

## Progress Notifications

The `review` and `search` tools emit MCP `notifications/progress` every 15 seconds when the client provides a `progressToken` in the request's `_meta`. Heartbeats include elapsed time. Notifications are fire-and-forget; clients that don't support progress notifications are unaffected.

## Prompt Templates

The `review`, `search`, and `structured` tools load prompt templates from the `prompts/` directory:

```
prompts/
├── review-agentic.md   # Full agentic review (default)
├── review-quick.md     # Quick diff-only review
├── search.md           # Web search synthesis
└── structured.md       # JSON Schema output
```

Templates are loaded by `src/utils/prompts.ts` and filled with placeholders (diff content, schema, focus area, etc.). When running via `npx`, the bundled templates are used. When running from a local clone, you can edit them to adjust review style, search instructions, or output formatting.

## Agentic Review Timeout Scaling

The `review` tool auto-scales its default timeout linearly from the diff size:

**180s baseline + 30s per changed file**, capped at 1800s (30 min).

| Files changed | Default timeout |
|---|---|
| 1 | 210s (3.5 min) |
| 5 | 330s (5.5 min) |
| 15 | 630s (10.5 min) |
| 30 | 1080s (18 min) |
| 54+ | 1800s (30 min, hard cap) |

A caller-supplied `timeout` parameter always takes precedence. File count isn't a perfect workload signal (30 YAML lines differ from 30 TypeScript files with deep imports), so the formula is deliberately generous. For very large diffs, prefer `quick: true` (diff-text only, no repo exploration) or pass a narrowed `base`.

The scaling logic lives in `scaleAgenticTimeout()` in `src/tools/review.ts`, with the hard cap defined in `src/utils/limits.ts`.

## Latency Budget

The Gemini CLI has a ~16s cold start (584MB package, synchronous init). Every spawn pays this cost. Known upstream: [optimization epic #21259](https://github.com/google-gemini/gemini-cli/issues/21259), [daemon mode PR #20700](https://github.com/google-gemini/gemini-cli/pull/20700).

| Layer | Time | Notes |
|-------|------|-------|
| CLI startup | ~16s | Constant per spawn |
| Utility router | ~1-2s | Skipped when `--model` is specified |
| Model inference | 1-27s | Scales with prompt size and model |

Timeouts under 20s are never useful for query/search/review/structured (ping is exempt, it only checks `--version`). Once daemon mode ships upstream, we plan to support it as an alternative to per-invocation spawning.
