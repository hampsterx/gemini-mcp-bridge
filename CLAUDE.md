# CLAUDE.md - gemini-mcp-bridge

## Project Overview

Open source MCP server that wraps Gemini CLI as a subprocess, exposing its best features as MCP tools. Works with any MCP-compatible client: Claude Code, Codex CLI, Cursor, Windsurf, VS Code.

- **npm package**: `gemini-mcp-bridge`
- **License**: MIT
- **Language**: TypeScript
- **Framework**: `@modelcontextprotocol/sdk`

## Architecture

```
MCP Client  --stdio-->  gemini-mcp-bridge  --spawn-->  gemini CLI subprocess
```

We assemble prompts in TypeScript and spawn the CLI. The `review` tool loads prompt templates from `prompts/*.md` and fills placeholders; the CLI then runs in agentic mode inside the target repo, using its built-in tools (read_file, grep_search, list_directory) to explore surrounding code for context.

## Tools

| Tool | Purpose | Default Timeout |
|------|---------|----------------|
| `query` | One-shot query with optional file attachment | 60s |
| `review` | Agentic repo-aware code review (computes diff, CLI explores repo for context) | 300s (agentic) / 120s (quick) |
| `ping` | Health check + CLI capability detection | 10s |

### Review Tool Details

The `review` tool has two modes:

- **Agentic (default)**: Sends a prompt to Gemini CLI running inside the repo. The CLI runs `git diff` itself, reads full files, follows imports, checks tests, and reads project instruction files (CLAUDE.md, GEMINI.md, AGENTS.md, etc.) before reviewing. Produces deeper, context-aware reviews.
- **Quick** (`quick: true`): Sends only the diff text. Single-pass, no repo exploration. Faster but shallow.

Optional `focus` parameter lets callers direct attention (e.g. "security", "performance", "error handling").

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm test             # Run tests
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

## Key Design Decisions

### Subprocess Environment (Security Critical)
- **Minimal env allowlist** - never spread `process.env`
- Allowed prefixes: `GOOGLE_*`, `GEMINI_*`, `CLOUDSDK_*`
- Allowed keys: `HOME`, `PATH`, `USER`, `SHELL`, `LANG`, `TERM`, `XDG_CONFIG_HOME`
- Always set: `NO_COLOR=1`, `FORCE_COLOR=0`, `NODE_OPTIONS=--max-old-space-size=8192`

### Subprocess Spawning
- Always `spawn` with `shell: false`, args as array (never `exec`)
- Pipe large prompts via stdin (avoids `ARG_MAX` limit)
- Use `-p` flag for short prompts only
- Kill process group on timeout: SIGTERM -> 5s grace -> SIGKILL
- Max 3 concurrent spawns, queue excess (FIFO, 30s queue timeout)

### Output Parsing
1. Try stdout as JSON (some CLI versions write here)
2. Try stderr as JSON (`--output-format json` writes here in newer versions)
3. Fall back to ANSI-stripped plain text from stdout
4. Tolerate malformed JSON, extract response text from partial output

### Path Security
- All paths resolved via `realpath`
- Verify within allowed root directory (no traversal)
- No symlink following outside root
- Max file size: 1MB per file

### Working Directory
- Accept `workingDirectory` param on all tools
- Resolve to git root for review operations
- Fall back to `process.cwd()`

## Testing

- `tests/tools/` - Tool-level tests (mock subprocess)
- `tests/utils/` - Utility unit tests
- `tests/integration/` - End-to-end with real gemini CLI (CI-only, gated by `GEMINI_INTEGRATION=1`)

## CI/CD

- **ci.yml**: lint + test + build on PRs
- **publish.yml**: npm publish on `v*` tags via OIDC trusted publishing (no npm token needed)
- Semantic versioning, CHANGELOG.md with Keep a Changelog format

### Release Workflow

1. Bump version in `package.json`
2. Update `CHANGELOG.md` with new version and date
3. Commit, tag (`v0.x.y`), push with `--tags`
4. GitHub Actions publishes to npm automatically via OIDC

First publish of a new package must be done manually (`npm publish --access public` with OTP) to register it on npmjs.com. OIDC can only update existing packages.

## Git Workflow

- Use feature branches with PRs for all changes (do not commit directly to master)
- Branch naming: `feat/`, `fix/`, `refactor/` prefix, kebab-case
- Squash merge PRs

## Conventions

- Prefer explicit over clever
- No default exports
- Error messages must be actionable ("gemini CLI not found - install with: npm i -g @google/gemini-cli")
- All public functions must have JSDoc
- Tests colocated with source where possible, integration tests separate
