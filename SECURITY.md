# Security

Security model and hardening measures for gemini-mcp-bridge.

## Environment Isolation

Only an explicit allowlist of environment variables is forwarded to the subprocess. All non-allowlisted env vars are stripped, preventing unintended credential leakage. The allowlist includes Gemini/Google auth keys required by the CLI.

**Allowed prefixes**: `GOOGLE_*`, `GEMINI_*`, `CLOUDSDK_*`

**Allowed keys**: `HOME`, `PATH`, `USER`, `SHELL`, `LANG`, `TERM`, `XDG_CONFIG_HOME`

**Always set**: `NO_COLOR=1`, `FORCE_COLOR=0`, `NODE_OPTIONS=--max-old-space-size=8192`

Everything else from `process.env` is stripped. The allowlist is defined in `src/utils/env.ts`.

## Path Sandboxing

All file paths are resolved to absolute paths via `realpath()` and verified to stay within the working directory:

- No path traversal via `..` components
- No symlink following outside the root directory
- Paths outside the sandbox are rejected before reaching the CLI

## Subprocess Safety

- Subprocess spawned with `shell: false` and args as an array. No command injection from the bridge itself.
- Large prompts are piped via stdin rather than passed as command-line arguments, avoiding `ARG_MAX` injection vectors.
- Process groups are killed on timeout (SIGTERM then SIGKILL after 5s grace period).

## Agentic Mode

The `search` and `query` (with images) tools use `--yolo` to give Gemini CLI shell access. This means the model can execute arbitrary shell commands within the repository.

The `query` tool (text-only) and `structured` tool run under `--approval-mode plan` (read-only agentic): Gemini has read-side tools (read_file, grep_search, list_directory) but no shell.

When invoking Gemini CLI directly outside this bridge for code review, use the hardened flag set: `--approval-mode plan -e "" --allowed-mcp-server-names ""`. See README § Code review with this CLI.

## Resource Limits

| Limit | Value |
|-------|-------|
| Max file size (text) | 1 MB |
| Max file size (image) | 5 MB |
| Max files per request | 20 |
| Max concurrent spawns | 3 (configurable) |
| Queue timeout | 30s |
| Hard timeout cap | 1800s (30 min) |

## Output Handling

CLI output is captured and parsed. The bridge does not currently perform output redaction (unlike the codex and claude bridges), because the Gemini CLI does not echo API keys or tokens in its output. If this changes in future CLI versions, redaction will be added.
