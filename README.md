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
# File context query
gemini -p "Explain how this auth flow works" -- @src/auth.ts @src/session.ts

# Quick question
gemini -p "Is this approach sound for handling retries?"

# Web search
gemini -p --yolo "What's the latest stable Node.js LTS?"
```

**Tips:** `--yolo` is needed for agentic file access in headless mode (without it, tool calls block). Use `-m gemini-2.5-pro` to skip the CLI's internal model routing (~1-2s). Cold start is ~16s per invocation. For code review, see [Code review with this CLI](#code-review-with-this-cli) below.

**Use this MCP bridge instead when:**
- Your client has no shell access (Cursor, Windsurf, Claude Desktop, VS Code)
- You need structured output with JSON Schema validation (Gemini CLI has [no custom schema support](https://github.com/google-gemini/gemini-cli/issues/13388))
- You need concurrency management (max 3 parallel spawns, FIFO queue, optional pacing/jitter between CLI starts)
- You need partial response capture on timeout (NDJSON streaming) and automatic model fallback on quota errors
- You need response length controls (`maxResponseLength` parameter)
- You need oversized query/search responses paginated safely instead of getting truncated by MCP client limits (`structured` is intentionally not chunked, preserves machine-consumable JSON)
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
| **structured** | JSON Schema validated output via [Ajv](https://ajv.js.org/). Data extraction, classification, or any task needing machine-parseable output. |
| **ping** | Health check. Verifies CLI is installed and authenticated, reports versions and capabilities. |
| **fetch-chunk** | Retrieve later segments from a chunked `query` or `search` response using its `cacheKey`. |

### query

Send a prompt with optional file paths as hints. Gemini reads the files itself and can explore surrounding code for context. Text queries run under `--approval-mode plan` (read-only agentic). Image queries use `--yolo` for native pixel access.

Key parameters: `prompt` (required), `files` (text or images), `model`, `workingDirectory`, `timeout` (default 120s, max 1800s), `changeMode` (see below).

**Change mode**: set `changeMode: true` to ask Gemini to emit structured `**FILE: <path>:<start>-<end>**` / `===OLD===` / `===NEW===` edit blocks instead of prose. The raw response stays in `response` (chunked normally); parsed edits are returned on `_meta.edits` as a machine-applicable array and are never chunked. A pre/post-spawn git snapshot detects any file writes Gemini might attempt, if writes are found, `_meta.appliedWrites` is set to true and `edits` is omitted so callers can't re-apply half-applied state. Text-only for v1; requires a git `workingDirectory`. Plan mode refuses to emit edit blocks (verified on CLI 0.38.0), so change mode runs in default agentic mode with the snapshot guardrail as the safety net.

### search

Google Search grounded query. Spawns Gemini CLI in agentic mode with `google_web_search`, then synthesizes an answer with source URLs.

Key parameters: `query` (required), `model`, `workingDirectory`, `timeout`.

Large `query` and `search` responses are automatically chunked when they exceed the bridge threshold. The first chunk includes a `cacheKey` and chunk count in `_meta` and the response footer. Use `fetch-chunk` with that `cacheKey` and a 1-based `chunkIndex` to retrieve later segments within the 10-minute in-memory cache window. `structured` responses are intentionally not chunked (preserves machine-consumable JSON output).

### structured

Generate JSON conforming to a provided schema. Schema is embedded in the prompt, response validated with Ajv. Returns `isError: true` with validation details on failure.

Key parameters: `prompt` (required), `schema` (required, JSON string), `files`, `model`, `workingDirectory`, `timeout`.

### ping

No parameters. Returns CLI version, auth status, and server info.

All tools attach execution metadata (`_meta`) with `durationMs`, `model`, and `partial` (timeout indicator). See [DESIGN.md](DESIGN.md) for details.

## Code review with this CLI

The `review` and `assess` tools were removed in v0.7.0 (see [ADR-001](docs/decisions/001-remove-review-and-assess-tools.md)). The gemini ecosystem already ships several review surfaces, listed here in priority order:

1. **Official `gemini-cli-extensions/code-review` extension** ([repo](https://github.com/gemini-cli-extensions/code-review)). Adds `/code-review` and `/pr-code-review` slash commands to the CLI.
2. **Skills** (`/skills`, `.gemini/skills/code-reviewer/SKILL.md`). Project- or user-scoped review prompts, invokable as slash commands.
3. **Subagents** (`.gemini/agents/`, `~/.gemini/agents/`). Specialized reviewer personas the CLI can delegate to.
4. **Gemini Code Assist** GitHub app. Inline review on pull requests.
5. **Direct `gemini -p`** with hardened isolation flags. Pipe the diff via stdin (using `$(git diff ...)` as positional args expands the diff into shell tokens):

   ```bash
   git diff origin/main...HEAD | gemini --approval-mode plan \
     -e "" \
     --allowed-mcp-server-names "" \
     -p "Review the diff on stdin for bugs, missing tests, and unhandled errors"
   ```

   `--approval-mode plan` is read-only agentic. `-e ""` disables loaded extensions for this run. `--allowed-mcp-server-names ""` blocks bundled MCP servers. Default text output is preferred over `--output-format json` for human-readable review notes.

6. **Third-party MCP servers** if you specifically need an MCP-shaped review tool (e.g. [`nicobailon/gemini-code-review-mcp`](https://github.com/nicobailon/gemini-code-review-mcp)).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_DEFAULT_MODEL` | *(CLI default)* | Default model for all tools |
| `GEMINI_FALLBACK_MODEL` | `gemini-2.5-flash` | Fallback on quota/rate-limit errors (`none` to disable) |
| `GEMINI_CLI_PATH` | `gemini` | Path to CLI binary |
| `GEMINI_MAX_CONCURRENT` | `3` | Max concurrent subprocess spawns |
| `GEMINI_MIN_INVOCATION_GAP_MS` | `5000` | Minimum gap between Gemini CLI start times |
| `GEMINI_SPAWN_JITTER_MAX_MS` | `200` | Random extra delay before spawn to avoid deterministic timing |

Prompt templates for the search, structured, and `query` change-mode tools live in `prompts/`. Editable when running from a local clone; bundled when running via `npx`.

## Choosing a Gemini MCP server

| You need... | Consider |
|-------------|----------|
| Schema-validated structured output, concurrency management, response chunking | This bridge |
| Shell command generation, Google Workspace integration | [@tuannvm/gemini-mcp-server](https://github.com/tuannvm/gemini-mcp-server) |
| Lightweight large-context codebase analysis | [gemini-mcp-tool](https://github.com/jamubc/gemini-mcp-tool) |
| No CLI dependency (API-only, broadest feature set) | [@rlabs-inc/gemini-mcp](https://github.com/RLabs-Inc/gemini-mcp) |
| Simple API wrapper with broad client support | [mcp-server-gemini](https://github.com/aliargun/mcp-server-gemini) |

## Performance

Each invocation spawns a fresh CLI process with ~15-20s cold start (large dependency tree, sync auth checks). No daemon mode yet ([tracking](https://github.com/google-gemini/gemini-cli/issues/21259); [PR in progress](https://github.com/google-gemini/gemini-cli/pull/20700)).

| Scenario | Typical time |
|----------|-------------|
| Minimal query | 17-25s |
| File-context query (small repo) | 30-60s |
| Web search + synthesis | 35-60s |
| Structured output (small schema) | 25-45s |

Setting `GEMINI_DEFAULT_MODEL` avoids the CLI's internal model routing step (~1-2s savings per call).

## Bridge family

Three MCP servers, same architecture, different underlying CLIs. Each wraps a terminal agent as a subprocess and exposes it as MCP tools. Pick the one that matches your model provider, or run multiple for cross-model workflows.

| | [gemini-mcp-bridge](https://github.com/hampsterx/gemini-mcp-bridge) | [claude-mcp-bridge](https://github.com/hampsterx/claude-mcp-bridge) | [codex-mcp-bridge](https://github.com/hampsterx/codex-mcp-bridge) |
|---|---|---|---|
| **CLI** | Gemini CLI | Claude Code | Codex CLI |
| **Provider** | Google | Anthropic | OpenAI |
| **Tools** | query, structured, search, fetch-chunk, ping | query, structured, search, ping, listSessions | codex, query, structured, search, ping, listSessions |
| **Code review** | Use the gemini ecosystem: [code-review extension](https://github.com/gemini-cli-extensions/code-review), skills, subagents, Code Assist, or `gemini -p` | Use Claude Code built-ins (`/review`, `/security-review`, `/ultrareview`) or `claude -p` | Use `codex review --base <ref>` (native CLI subcommand) |
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
