# gemini-mcp-bridge

[![npm version](https://img.shields.io/npm/v/gemini-mcp-bridge)](https://www.npmjs.com/package/gemini-mcp-bridge)
[![npm downloads](https://img.shields.io/npm/dm/gemini-mcp-bridge)](https://www.npmjs.com/package/gemini-mcp-bridge)
[![CI](https://github.com/hampsterx/gemini-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/hampsterx/gemini-mcp-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/node/v/gemini-mcp-bridge)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2)](https://modelcontextprotocol.io/)

MCP server that wraps [Gemini CLI](https://github.com/google-gemini/gemini-cli) as a subprocess, exposing its capabilities as [Model Context Protocol](https://modelcontextprotocol.io/) tools.

Works with any MCP client: Claude Code, Codex CLI, Cursor, Windsurf, VS Code, or any tool that speaks MCP.

## Do you need this?

If you're in a terminal agent (Claude Code, Codex CLI) with shell access, call Gemini CLI directly:

```bash
# Agentic review (Gemini explores the repo, reads files, follows imports)
cd /path/to/repo && gemini -p --yolo "Review the changes on this branch vs main"

# Review specific files
gemini -p "Review this code for bugs and security issues" -- @src/file.ts @src/other.ts

# Pipe a diff
git diff origin/main...HEAD | gemini -p "Review this diff"

# Quick question
gemini -p "Is this approach sound for handling retries?"
```

**Tips:** `--yolo` is needed for agentic file access in headless mode (without it, tool calls block). Use `-m gemini-2.5-pro` to skip the CLI's internal model routing (~1-2s). Cold start is ~16s per invocation.

**Use this MCP bridge instead when:**
- Your client has no shell access (Cursor, Windsurf, Claude Desktop, VS Code)
- You want to know the cost before you pay it, `assess` classifies a diff in <2s (no spawn) and recommends a review depth with an estimated wall time
- You need graduated review depth rather than all-or-nothing: `scan` (diff-only, ~40s), `focused` (reads changed files, 1-3min), `deep` (full agentic, up to 30min) with per-depth auto-scaled timeouts
- You need structured output with JSON Schema validation (Gemini CLI has [no custom schema support](https://github.com/google-gemini/gemini-cli/issues/13388))
- You need concurrency management (max 3 parallel spawns, FIFO queue, optional pacing/jitter between CLI starts)
- You need partial response capture on timeout (NDJSON streaming), automatic model fallback on quota errors for most tools, and structured capacity failures for deep review
- You need response length controls (`maxResponseLength` parameter)
- You need oversized query/review/search responses paginated safely instead of getting truncated by MCP client limits
- You want subprocess isolation: env allowlist, path sandboxing, no shell escape

## Quick Start

```bash
npx gemini-mcp-bridge
```

### Prerequisites

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed (`npm i -g @google/gemini-cli`)
- Authenticated (`gemini auth login`)

### Claude Code

```bash
claude mcp add gemini -s user -- npx -y gemini-mcp-bridge
```

### Codex CLI

Add to `~/.codex/config.json`:
```json
{
  "mcpServers": {
    "gemini": {
      "command": "npx",
      "args": ["-y", "gemini-mcp-bridge"]
    }
  }
}
```

### Cursor / Windsurf / VS Code

Add to your MCP settings:
```json
{
  "gemini": {
    "command": "npx",
    "args": ["-y", "gemini-mcp-bridge"]
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| **query** | Agentic prompt with optional file context. Gemini runs inside your repo with read/grep/glob tools. Supports text and images. |
| **search** | Google Search grounded query. Gemini searches the web and synthesizes an answer with source URLs. |
| **assess** | Zero-cost diff analysis pre-flight. Classifies complexity and change kind, adds guidance, and recommends a `review` depth. No CLI spawn. |
| **review** | Repo-aware code review at three depths: `scan` (diff-only), `focused` (reads changed files), `deep` (full agentic exploration). |
| **structured** | JSON Schema validated output via [Ajv](https://ajv.js.org/). Data extraction, classification, or any task needing machine-parseable output. |
| **ping** | Health check. Verifies CLI is installed and authenticated, reports versions and capabilities. |
| **fetch-chunk** | Retrieve later segments from a chunked `query`, `review`, or `search` response using its `cacheKey`. |

### query

Send a prompt with optional file paths as hints. Gemini reads the files itself and can explore surrounding code for context. Text queries run under `--approval-mode plan` (read-only agentic). Image queries use `--yolo` for native pixel access.

Key parameters: `prompt` (required), `files` (text or images), `model`, `workingDirectory`, `timeout` (default 120s, max 1800s).

### assess

Runs `git diff --numstat` and `--name-only` locally and returns diff stats, changed file list, complexity (trivial/moderate/complex), change kind (`empty` / `code` / `mixed` / `non-code` / `generated`), guidance, and suggested `review` depths with estimated wall-clock time. No CLI spawn, no model call, returns in under 2 seconds.

Key parameters: `uncommitted` (default true), `base`, `workingDirectory`.

### review

Three depth tiers, selectable via the `depth` parameter. Use the `assess` tool first for a recommendation.

- **scan**: diff-only, single-pass, no repo exploration. Constant 180s timeout. Good for sanity checks and small diffs.
- **focused**: pre-computed diff + Gemini reads changed files for surrounding context. Plan mode, no shell. Timeout `120s + 15s * files` (cap 300s; 240s fallback). Good for light-to-moderate reviews.
- **deep** (default): full agentic exploration with `--yolo`. Gemini runs `git diff` itself, follows imports, checks tests, reads project instruction files (CLAUDE.md, GEMINI.md, etc.). Timeout `240s + 45s * files` (cap 1800s; 600s fallback). On capacity failures such as 429/503, deep review returns structured failure metadata instead of retrying or silently downgrading. Deepest.

The legacy `quick` boolean is deprecated but still honoured: `quick: true` → `depth: "scan"`, `quick: false` → `depth: "deep"`. `depth` wins when both are set.

Key parameters: `uncommitted` (default true), `base`, `focus`, `depth`, `workingDirectory`, `timeout`, `maxResponseLength`.

### search

Google Search grounded query. Spawns Gemini CLI in agentic mode with `google_web_search`, then synthesizes an answer with source URLs.

Key parameters: `query` (required), `model`, `workingDirectory`, `timeout`.

Large `query`, `review`, and `search` responses are automatically chunked when they exceed the bridge threshold. The first chunk includes a `cacheKey` and chunk count in `_meta` and the response footer. Use `fetch-chunk` with that `cacheKey` and a 1-based `chunkIndex` to retrieve later segments within the 10-minute in-memory cache window.

### structured

Generate JSON conforming to a provided schema. Schema is embedded in the prompt, response validated with Ajv. Returns `isError: true` with validation details on failure.

Key parameters: `prompt` (required), `schema` (required, JSON string), `files`, `model`, `workingDirectory`, `timeout`.

### ping

No parameters. Returns CLI version, auth status, and server info.

All tools attach execution metadata (`_meta`) with `durationMs`, `model`, and `partial` (timeout indicator). Review may also attach `capacityFailure`; assess includes `diffKind`, `guidance`, and `suggestions`. See [DESIGN.md](DESIGN.md) for details.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_DEFAULT_MODEL` | *(CLI default)* | Default model for all tools |
| `GEMINI_FALLBACK_MODEL` | `gemini-2.5-flash` | Fallback on quota/rate-limit errors (`none` to disable) |
| `GEMINI_CLI_PATH` | `gemini` | Path to CLI binary |
| `GEMINI_MAX_CONCURRENT` | `3` | Max concurrent subprocess spawns |
| `GEMINI_MIN_INVOCATION_GAP_MS` | `5000` | Minimum gap between Gemini CLI start times |
| `GEMINI_SPAWN_JITTER_MAX_MS` | `200` | Random extra delay before spawn to avoid deterministic timing |

Prompt templates for review, search, and structured tools live in `prompts/`. Editable when running from a local clone; bundled when running via `npx`.

## Choosing a Gemini MCP server

| You need... | Consider |
|-------------|----------|
| Agentic code review, structured output, concurrency management | This bridge |
| Shell command generation, Google Workspace integration | [@tuannvm/gemini-mcp-server](https://github.com/tuannvm/gemini-mcp-server) |
| Lightweight large-context codebase analysis | [gemini-mcp-tool](https://github.com/jamubc/gemini-mcp-tool) |
| No CLI dependency (API-only, broadest feature set) | [@rlabs-inc/gemini-mcp](https://github.com/RLabs-Inc/gemini-mcp) |
| Simple API wrapper with broad client support | [mcp-server-gemini](https://github.com/aliargun/mcp-server-gemini) |

## Performance

Each invocation spawns a fresh CLI process with ~15-20s cold start (large dependency tree, sync auth checks). No daemon mode yet ([tracking](https://github.com/google-gemini/gemini-cli/issues/21259); [PR in progress](https://github.com/google-gemini/gemini-cli/pull/20700)).

| Scenario | Typical time |
|----------|-------------|
| Minimal query | 17-25s |
| Scan review (diff-only) | 35-50s |
| Focused review (reads changed files) | 60-180s |
| Deep review (explores repo) | 60s to 30 min |
| Web search + synthesis | 35-60s |

Setting `GEMINI_DEFAULT_MODEL` avoids the CLI's internal model routing step (~1-2s savings per call).

## Bridge family

Three MCP servers, same architecture, different underlying CLIs. Each wraps a terminal agent as a subprocess and exposes it as MCP tools. Pick the one that matches your model provider, or run multiple for cross-model workflows.

| | [gemini-mcp-bridge](https://github.com/hampsterx/gemini-mcp-bridge) | [claude-mcp-bridge](https://github.com/hampsterx/claude-mcp-bridge) | [codex-mcp-bridge](https://github.com/hampsterx/codex-mcp-bridge) |
|---|---|---|---|
| **CLI** | Gemini CLI | Claude Code | Codex CLI |
| **Provider** | Google | Anthropic | OpenAI |
| **Tools** | query, review, search, structured, ping | query, review, search, structured, ping, listSessions | codex, review, search, query, structured, ping, listSessions |
| **Agentic review** | Gemini explores repo with file reads and git | Claude explores repo with Read/Grep/Glob/git | Codex explores repo in full-auto mode |
| **Structured output** | Ajv validation | Native `--json-schema` | Ajv validation |
| **Session resume** | Not supported | Native `--resume` | Session IDs with multi-turn |
| **Budget caps** | Not supported | Native `--max-budget-usd` | Not supported |
| **Effort control** | Not supported | `--effort low/medium/high/max` | `reasoningEffort` (low/medium/high) |
| **Cold start** | ~16s | ~1-2s | <100ms (inference dominates) |
| **Auth** | `gemini auth login` | `claude login` (subscription) or `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` |
| **Cost** | Free tier available | Subscription (included) or API credits | Pay-per-token |
| **Concurrency** | 3 (configurable) | 3 (configurable) | 3 (configurable) |
| **Model fallback** | Auto-retry with fallback model | Auto-retry with fallback model | Auto-retry with fallback model |

All three share: subprocess env isolation, path sandboxing, FIFO concurrency queue, MCP tool annotations, `_meta` response metadata, progress heartbeats. The codex and claude bridges also perform output redaction (secret stripping).

## Development

```bash
npm install
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm test             # Run tests
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

## Further reading

- [DESIGN.md](DESIGN.md) - Architecture, output streaming, concurrency, response metadata, prompt templates
- [SECURITY.md](SECURITY.md) - Environment isolation, path sandboxing, agentic mode caveats, resource limits
- [CHANGELOG.md](CHANGELOG.md) - Release history

## License

MIT
