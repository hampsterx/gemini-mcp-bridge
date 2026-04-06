# gemini-mcp-bridge

[![npm version](https://img.shields.io/npm/v/gemini-mcp-bridge)](https://www.npmjs.com/package/gemini-mcp-bridge)
[![npm downloads](https://img.shields.io/npm/dm/gemini-mcp-bridge)](https://www.npmjs.com/package/gemini-mcp-bridge)
[![CI](https://github.com/hampsterx/gemini-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/hampsterx/gemini-mcp-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/node/v/gemini-mcp-bridge)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2)](https://modelcontextprotocol.io/)

MCP server that wraps [Gemini CLI](https://github.com/google-gemini/gemini-cli) as a subprocess, exposing its best features as [Model Context Protocol](https://modelcontextprotocol.io/) tools.

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
- You need structured output with JSON Schema validation (Gemini CLI has [no custom schema support](https://github.com/google-gemini/gemini-cli/issues/13388))
- You need concurrency management (max 3 parallel spawns, queuing)
- You need partial response capture on timeout (NDJSON streaming)
- You want response length controls (`maxResponseLength` parameter)

## How does this compare to other Gemini MCP servers?

There are several Gemini MCP servers available. They split into two camps: **CLI wrappers** that spawn the Gemini CLI as a subprocess, and **API servers** that call the Gemini API directly. CLI wrappers get agentic capabilities (repo exploration, web search) for free; API servers avoid the CLI dependency.

### CLI-based (wraps Gemini CLI)

| | gemini-mcp-bridge | [@tuannvm/gemini-mcp-server](https://github.com/tuannvm/gemini-mcp-server) | [gemini-mcp-tool](https://github.com/jamubc/gemini-mcp-tool) |
|---|---|---|---|
| **CLI mode** | Agentic (CLI explores repo, runs tools) | One-shot (prompt in, response out) | One-shot |
| **Tools** | 5 (query, search, review, structured, ping) | 5 (gemini, web-search, analyze-media, shell, brainstorm) | 4 (ask-gemini, sandbox-test, ping, help) |
| **Agentic code review** | Yes (CLI diffs, reads files, follows imports) | No | No |
| **Web search** | Yes (via CLI's `google_web_search`) | Yes (via CLI) | Yes (via CLI) |
| **Structured output** | Yes (JSON Schema validated) | No | No |
| **Image support** | Yes (query attachments) | Yes (analyze-media tool) | No |
| **Shell command gen** | No | Yes (generate + execute) | No |
| **Google Workspace** | No | Yes (via CLI extensions) | No |
| **Security model** | Env allowlist, path sandboxing, shell:false | Basic | Basic |

**When to pick gemini-mcp-bridge**: You want agentic code review where Gemini explores the repo itself, web search via the CLI, or structured output with schema validation.

**When to pick @tuannvm/gemini-mcp-server**: You want one-shot Gemini queries, shell command generation, brainstorming, or Google Workspace integration via CLI extensions.

**When to pick gemini-mcp-tool**: You want a lightweight CLI wrapper focused on large-context codebase analysis.

### API-based (calls Gemini API directly)

| | [@rlabs-inc/gemini-mcp](https://github.com/RLabs-Inc/gemini-mcp) | [mcp-server-gemini](https://github.com/aliargun/mcp-server-gemini) |
|---|---|---|
| **Tools** | 37 (query, search, research, code exec, media gen, TTS, ...) | 6 (generate, analyze image, count tokens, embed, ...) |
| **Web search** | Yes (API-level) | Yes (API-level) |
| **Structured output** | Yes | JSON mode |
| **Image support** | Yes (analysis + generation) | Yes (analysis) |
| **Code execution** | Yes (Python sandbox) | No |
| **Media generation** | Yes (image, video, TTS) | No |
| **Requires Gemini CLI** | No (API key only) | No (API key only) |

**When to pick RLabs**: You want the broadest feature set (media generation, deep research, code execution, caching) and prefer API-key-only setup with no CLI dependency.

**When to pick mcp-server-gemini**: You want a simple API wrapper with good docs and broad MCP client support.

## Tools

| Tool | Description |
|------|-------------|
| **query** | Send a prompt to Gemini with optional file context (text and images). The CLI reads your GEMINI.md for project context automatically. |
| **search** | Google Search grounded query. Gemini searches the web and synthesizes an answer with source URLs. |
| **review** | Agentic code review. Gemini CLI runs inside the repo, diffs the code, reads files, follows imports, and checks tests before reviewing. Supports focused reviews (security, performance, etc.) and quick diff-only mode. |
| **structured** | Generate JSON conforming to a provided JSON Schema. Data extraction, classification, or any task needing machine-parseable output. |
| **ping** | Health check. Verifies CLI is installed and authenticated, reports versions and capabilities. |

## Prerequisites

```bash
npm i -g @google/gemini-cli
gemini auth login
```

## Installation

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

## Tool Reference

### query

Send a prompt to Gemini, optionally including file contents and images.

Text files are read and inlined in the prompt. Image files (png, jpg, jpeg, gif, webp, bmp) trigger agentic mode so the CLI can read them natively via its `read_file` tool.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | *required* | The prompt to send |
| `files` | string[] | `[]` | File paths (text or images) relative to workingDirectory |
| `model` | string | CLI default | Model to use (e.g. `gemini-2.5-flash`) |
| `workingDirectory` | string | cwd | Working directory (CLI reads GEMINI.md from here) |
| `timeout` | number | 60000 (text) / 120000 (images) | Timeout in ms (max 600000) |

### search

Google Search grounded query. Spawns Gemini CLI in agentic mode with access to `google_web_search`, then synthesizes an answer with source URLs.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | *required* | Search query or question to research |
| `model` | string | CLI default | Model to use (e.g. `gemini-2.5-flash`) |
| `workingDirectory` | string | cwd | Working directory for the CLI |
| `timeout` | number | 120000 | Timeout in ms (max 600000) |

### review

Agentic code review. Spawns Gemini CLI inside the repository where it runs `git diff`, reads full files, follows imports, checks for tests, and reads project instruction files (CLAUDE.md, GEMINI.md, AGENTS.md, etc.) for context-aware reviews.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `uncommitted` | boolean | `true` | Review uncommitted changes (staged + unstaged) |
| `base` | string | — | Base branch to diff against (e.g. `main`) |
| `focus` | string | — | Focus area for the review (e.g. `security`, `performance`) |
| `quick` | boolean | `false` | Skip repo exploration, just review the diff text (faster but less context) |
| `workingDirectory` | string | cwd | Repository directory (auto-resolves to git root) |
| `timeout` | number | 300000 (agentic) / 120000 (quick) | Timeout in ms (max 600000) |

The Gemini CLI has no native code review feature. Google offers a [separate extension](https://github.com/gemini-cli-extensions/code-review) that requires the GitHub MCP server and CI environment variables (`REPOSITORY`, `PULL_REQUEST_NUMBER`). This tool takes a different approach: it computes the diff locally via `git diff`, loads a prompt template (`prompts/review-agentic.md`), and spawns the CLI in agentic mode so it can read files, follow imports, and check tests itself.

### structured

Generate a JSON response conforming to a provided JSON Schema. The schema is embedded in the prompt, and the response is validated with [Ajv](https://ajv.js.org/). Returns `isError: true` with validation details if the response doesn't match.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | *required* | What to generate or extract |
| `schema` | string | *required* | JSON Schema as a JSON string |
| `files` | string[] | `[]` | Text file paths to include as context (no images) |
| `model` | string | CLI default | Model to use (e.g. `gemini-2.5-flash`) |
| `workingDirectory` | string | cwd | Working directory for file paths |
| `timeout` | number | 60000 | Timeout in ms |

**Example:**
```json
{
  "prompt": "Extract the person's name and age from: 'John is 30 years old'",
  "schema": "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"},\"age\":{\"type\":\"number\"}},\"required\":[\"name\",\"age\"]}"
}
```

### ping

Health check with no parameters. Returns CLI version, auth status, and server info.

## Latency

Each tool invocation spawns a fresh `gemini` CLI process. The CLI has a ~15-20 second cold start due to its large dependency tree (~560MB), synchronous auth checks, and extension loading. This is a [known upstream issue](https://github.com/google-gemini/gemini-cli/issues/21259) with an optimization epic in progress.

**What this means in practice:**

| Scenario | Typical wall time |
|----------|-------------------|
| Minimal query ("say pong") | 17-25s |
| Quick code review (13KB diff) | 35-50s |
| Agentic code review (explores repo) | 60-120s |
| Web search + synthesis | 35-60s |

The default timeouts (60-300s) account for this. Setting timeouts below 20s will always fail. If latency is critical, set `GEMINI_DEFAULT_MODEL` to skip the CLI's internal model routing step (saves 1-2s per call).

A [daemon mode PR](https://github.com/google-gemini/gemini-cli/pull/20700) is in progress upstream that would eliminate cold starts by keeping a long-running process. Once merged and released, we plan to support it as an alternative to per-invocation spawning.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_DEFAULT_MODEL` | *(CLI default)* | Default model for all tools (e.g. `gemini-2.5-flash`). Overridden by explicit `model` parameter on individual tool calls. |
| `GEMINI_FALLBACK_MODEL` | `gemini-2.5-flash` | Fallback model used when the primary model returns a quota/rate-limit error. Set to `none` to disable automatic fallback. |
| `GEMINI_CLI_PATH` | `gemini` | Path to gemini CLI binary |
| `GEMINI_MAX_CONCURRENT` | `3` | Max concurrent subprocess spawns |

### Prompt Templates

The `review`, `search`, and `structured` tools use prompt templates from the `prompts/` directory:

```text
prompts/
├── review-agentic.md   # Full agentic review (default)
├── review-quick.md     # Quick diff-only review
├── search.md           # Web search synthesis
└── structured.md       # JSON Schema output
```

If you're running from a local clone, you can edit these to adjust review style, search instructions, or output formatting. When running via `npx`, the bundled templates are used.

## Security

> **Note on agentic mode**: The `review` (default mode), `search`, and `query` (with images) tools use `--yolo` to give Gemini CLI shell access. This means the model can execute arbitrary shell commands within the repository. A bundled policy file (`policies/review.toml`) restricts shell to read-only git commands, but the upstream CLI has a bug that prevents policy enforcement in headless mode ([google-gemini/gemini-cli#20469](https://github.com/google-gemini/gemini-cli/issues/20469)). Once the fix ships, we'll switch to policy-based filtering. The `query` tool (text-only) and `review` with `quick: true` do not use agentic mode.

- **Environment isolation**: Subprocess receives a minimal env allowlist (HOME, PATH, GOOGLE_*, GEMINI_*). Your API keys, tokens, and credentials are not leaked.
- **Path sandboxing**: All file paths are resolved via `realpath` and verified within the working directory. No path traversal via `..` or symlinks.
- **No shell injection**: Subprocess spawned with `shell: false` and args as an array. No command injection from the bridge itself. (The CLI may execute shell commands internally in agentic mode — see note above.)
- **Resource limits**: Max 3 concurrent spawns (configurable), 600s hard timeout cap, 1MB per text file / 5MB per image file, 20 files max.

## License

MIT
