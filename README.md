# gemini-mcp-bridge

MCP server that wraps [Gemini CLI](https://github.com/google-gemini/gemini-cli) as a subprocess, exposing its best features as [Model Context Protocol](https://modelcontextprotocol.io/) tools.

Works with any MCP client: Claude Code, Codex CLI, Cursor, Windsurf, VS Code, or any tool that speaks MCP.

## Tools

| Tool | Description |
|------|-------------|
| **query** | Send a prompt to Gemini with optional file context. The CLI reads your GEMINI.md for project context automatically. |
| **review** | Agentic code review. Computes the diff locally, then Gemini explores the repo (reads files, follows imports, checks tests) before reviewing. |
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

Send a prompt to Gemini, optionally including file contents.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | *required* | The prompt to send |
| `files` | string[] | `[]` | File paths (relative to workingDirectory) to include |
| `model` | string | CLI default | Model to use (e.g. `gemini-2.5-flash`) |
| `workingDirectory` | string | cwd | Working directory (CLI reads GEMINI.md from here) |
| `timeout` | number | 60000 | Timeout in ms (max 600000) |

### review

Agentic code review. Computes the diff locally, then spawns Gemini CLI inside the repository where it uses its built-in tools (read_file, grep_search, list_directory) to explore surrounding code before reviewing. This means Gemini reads full files, follows imports, checks for tests, and reads project instruction files (CLAUDE.md, GEMINI.md, AGENTS.md, etc.) for context.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `uncommitted` | boolean | `true` | Review uncommitted changes (staged + unstaged) |
| `base` | string | — | Base branch to diff against (e.g. `main`) |
| `focus` | string | — | Focus area for the review (e.g. `security`, `performance`) |
| `quick` | boolean | `false` | Skip repo exploration, just review the diff text (faster but less context) |
| `workingDirectory` | string | cwd | Repository directory (auto-resolves to git root) |
| `timeout` | number | 300000 (agentic) / 120000 (quick) | Timeout in ms (max 600000) |

### ping

Health check with no parameters. Returns CLI version, auth status, and server info.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_CLI_PATH` | `gemini` | Path to gemini CLI binary |
| `GEMINI_MAX_CONCURRENT` | `3` | Max concurrent subprocess spawns |

## Security

> **Note on agentic review**: The default agentic mode currently uses `--yolo` to give Gemini CLI shell access for running `git diff` and reading files. This means the model can execute arbitrary shell commands within the repository. A bundled policy file (`policies/review.toml`) restricts shell to read-only git commands, but the upstream CLI has a bug that prevents policy enforcement in headless mode ([google-gemini/gemini-cli#20469](https://github.com/google-gemini/gemini-cli/issues/20469)). Once the fix ships, we'll switch to policy-based filtering. Use `quick: true` if you want no shell access.

- **Environment isolation**: Subprocess receives a minimal env allowlist (HOME, PATH, GOOGLE_*, GEMINI_*). Your API keys, tokens, and credentials are not leaked.
- **Path sandboxing**: All file paths are resolved via `realpath` and verified within the working directory. No path traversal via `..` or symlinks.
- **No shell injection**: Subprocess spawned with `shell: false` and args as an array. No command injection from the bridge itself. (The CLI may execute shell commands internally in agentic mode — see note above.)
- **Resource limits**: Max 3 concurrent spawns (configurable), 600s hard timeout cap, 1MB per-file size limit, 20 files max.

## License

MIT
