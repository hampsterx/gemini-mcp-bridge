# CLAUDE.md - gemini-mcp-bridge

## Project Overview

Open source MCP server that wraps Gemini CLI as a subprocess, exposing its best features as MCP tools. Works with any MCP-compatible client: Claude Code, Codex CLI, Cursor, Windsurf, VS Code.

- **npm package**: `gemini-mcp-bridge`
- **License**: MIT
- **Language**: TypeScript
- **Framework**: `@modelcontextprotocol/sdk`

See README § Latency expectations before changing timeout defaults or adding new tools. The `review` tool auto-scales its default timeout from `git diff --numstat` file count via `scaleTimeoutForDepth` in `src/tools/review.ts` (per-depth formulas — see Review Tool Details); the hard cap is defined in `src/utils/limits.ts` and imported by both `spawn.ts` and `retry.ts`.

## Architecture

```
MCP Client  --stdio-->  gemini-mcp-bridge  --spawn-->  gemini CLI subprocess
```

We assemble prompts in TypeScript and spawn the CLI. The `review` and `search` tools load prompt templates from `prompts/*.md` via `src/utils/prompts.ts` and fill placeholders; the CLI then runs in agentic mode inside the target repo, using its built-in tools (read_file, grep_search, list_directory, google_web_search) to explore surrounding code or the web for context.

## Tools

| Tool | Purpose | Default Timeout |
|------|---------|----------------|
| `assess` | Zero-cost diff analysis pre-flight (no CLI spawn) | N/A (<2s) |
| `query` | Agentic query with read-only repo exploration | 120s |
| `search` | Google Search grounded query via `google_web_search` | 120s |
| `review` | Repo-aware code review at caller-chosen depth (scan/focused/deep) | Per depth: scan 180s, focused 120-300s, deep 240-1800s |
| `ping` | Health check + CLI capability detection | 10s |

### Assess Tool Details

Runs `git diff --numstat` and `--name-only` locally (no CLI spawn, no model call). Returns diff stats, changed file list, complexity classification (trivial/moderate/complex), change kind (`empty` / `code` / `mixed` / `non-code` / `generated`), guidance, and suggestions for which review depth to use with estimated wall-clock times. Use before `review` to set timeout expectations.

### Query Tool Details

Text queries run under `--approval-mode plan` (read-only agentic). Files are passed as `@{path}` hints, Gemini reads them with its own tools and can explore surrounding code. Image files (png, jpg, jpeg, gif, webp, bmp) trigger `--yolo` mode for native pixel access. Gitignored files cannot be read in plan mode.

### Search Tool Details

Spawns CLI in agentic mode with access to `google_web_search`. Uses a prompt template (`prompts/search.md`) that instructs Gemini to search, synthesize, and cite sources.

### Review Tool Details

The `review` tool has three depth tiers, selectable via the `depth` parameter:

- **scan**: Sends only the diff text. Single-pass, no repo exploration. Constant 180s timeout. Fastest, shallowest.
- **focused**: Pre-computes the diff and inlines it. CLI spawns in plan mode (no `--yolo`) so Gemini has `read_file` / `grep_search` / `list_directory` but no shell. Prompt instructs Gemini to read changed files for context but NOT trace imports, check tests, or explore the wider repo. Timeout: `120s + 15s * files`, capped at 300s; 240s fallback when diff stat unavailable. Containment is **prompt-driven, not CLI-enforced**: plan mode removes shell access but does not scope reads to changed files.
- **deep** (default): Full agentic exploration with `--yolo`. CLI runs `git diff` itself, reads full files, follows imports, checks tests, and reads project instruction files (CLAUDE.md, GEMINI.md, AGENTS.md, etc.). Timeout: `240s + 45s * files`, capped at 1800s (30 min); 600s fallback when diff stat is unavailable. Capacity failures such as 429/503 are returned as structured review metadata instead of triggering an internal fallback retry.

The legacy `quick` boolean is deprecated but still honoured: `quick: true` → `depth: "scan"`, `quick: false` → `depth: "deep"`. `depth` wins when both are set.

Use the `assess` tool first to classify diff complexity and get a depth recommendation.

Optional `focus` parameter lets callers direct attention (e.g. "security", "performance", "error handling") across any depth.

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm test             # Run tests
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

### Testing changes without restarting MCP client

MCP servers are long-lived processes. Claude Code (and other MCP clients) cannot hot-reload them mid-session. After rebuilding, use the smoke test to call compiled tool functions directly, bypassing the running server:

```bash
npm run smoke                          # query tool, cwd
npm run smoke -- query /path/to/repo   # query with specific workingDirectory
npm run smoke -- review ~/NUI/cream    # review tool against another repo
npm run smoke -- search                # search tool
npm run smoke -- ping                  # health check
```

From Claude Code, you can also import and call tool functions inline:

```bash
node --input-type=module -e "
import { executeQuery } from './dist/tools/query.js';
const r = await executeQuery({ prompt: 'pong', workingDirectory: '/tmp', timeout: 30000 });
console.log(r.resolvedCwd, r.response);
"
```

## Latency Budget

The gemini CLI has a ~16s cold start (584MB package, synchronous init). Every spawn pays this cost. Known upstream: [optimization epic #21259](https://github.com/google-gemini/gemini-cli/issues/21259), [daemon mode PR #20700](https://github.com/google-gemini/gemini-cli/pull/20700).

| Layer | Time | Notes |
|-------|------|-------|
| CLI startup | ~16s | Constant, unavoidable per-spawn |
| Utility router | ~1-2s | Skipped when `--model` is specified explicitly |
| Model inference | 1-27s | Scales with prompt size and model |

Implications:
- Timeouts under 20s are never useful for query/search/review/structured (ping is exempt, it only checks `--version`)
- `NODE_OPTIONS=--max-old-space-size=8192` (set in `env.ts`) is critical; without it, GC pressure nearly doubles wall time
- Setting `GEMINI_DEFAULT_MODEL` (or passing `model` per-call) skips the CLI's internal routing step

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
- Optional pacing via `GEMINI_MIN_INVOCATION_GAP_MS` and startup jitter via `GEMINI_SPAWN_JITTER_MAX_MS`

### Output Parsing
- Uses `--output-format stream-json` (NDJSON to stdout) for progressive capture
- On timeout, parses whatever NDJSON lines were captured and returns partial content
- Falls back to legacy JSON parsing (stdout then stderr) for older CLI versions
- Tolerates malformed JSON, extracts response text from partial output

### Path Security
- All paths resolved via `realpath`
- Verify within allowed root directory (no traversal)
- No symlink following outside root
- Max file size: 1MB per text file, 5MB per image file

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

See [RELEASING.md](RELEASING.md) for the full checklist including pre-release checks, publish steps (OIDC auto-publish), and post-release npm validation.

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
