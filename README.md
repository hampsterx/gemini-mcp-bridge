# gemini-mcp-bridge

MCP server that wraps [Gemini CLI](https://github.com/google-gemini/gemini-cli) as a subprocess, exposing its best features as [Model Context Protocol](https://modelcontextprotocol.io/) tools.

Works with any MCP client: Claude Code, Codex CLI, Cursor, Windsurf, VS Code, or any tool that speaks MCP.

## Tools

| Tool | Description |
|------|-------------|
| **query** | Send a prompt to Gemini with optional file context. The CLI reads your GEMINI.md for project context automatically. |
| **review** | Code review via git diff. Computes the diff locally and asks Gemini for structured findings (severity, file, line, suggestion). |
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

Code review via git diff sent to Gemini.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `uncommitted` | boolean | `true` | Review uncommitted changes (staged + unstaged) |
| `base` | string | — | Base branch to diff against (e.g. `main`) |
| `workingDirectory` | string | cwd | Repository directory (auto-resolves to git root) |
| `timeout` | number | 120000 | Timeout in ms (max 600000) |

### ping

Health check with no parameters. Returns CLI version, auth status, and server info.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_CLI_PATH` | `gemini` | Path to gemini CLI binary |
| `GEMINI_MAX_CONCURRENT` | `3` | Max concurrent subprocess spawns |

## Security

- **Environment isolation**: Subprocess receives a minimal env allowlist (HOME, PATH, GOOGLE_*, GEMINI_*). Your API keys, tokens, and credentials are not leaked.
- **Path sandboxing**: All file paths are resolved via `realpath` and verified within the working directory. No path traversal via `..` or symlinks.
- **No shell execution**: Subprocess spawned with `shell: false` and args as an array. No command injection.
- **Resource limits**: Max 3 concurrent spawns (configurable), 600s hard timeout cap, 1MB per-file size limit, 20 files max.

## License

MIT
