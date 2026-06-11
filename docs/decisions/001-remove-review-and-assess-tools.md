# ADR-001: Remove `review` and `assess` tools

**Status**: Accepted
**Date**: 2026-04-26

## Context

This bridge registers `query`, `structured`, `search`, `fetch-chunk`, `ping`, plus `review` (bundled reviewer prompts, depth selector) and `assess` (depth recommender for `review`).

CLI-wrapping tools should accept caller-supplied prompts rather than bundle them: prompts iterate fast, bridges publish slowly. `review` crosses that boundary. The gemini ecosystem already ships several review surfaces (extension, skills, subagents, Code Assist, third-party MCP servers); this bridge is not the right layer to add another.

## Decision

Drop `review` and `assess`.

Code review with gemini uses the ecosystem's existing surfaces, in rough priority order:

- **Official Code Review extension** (`gemini-cli-extensions/code-review`): `/code-review` and `/pr-code-review` slash commands. Maintained, gemini-team-blessed.
- **Skills** (`/skills`, `.gemini/skills/code-reviewer/SKILL.md` as a starting template) for customisable, locally-defined review.
- **Subagents** (`.gemini/agents/`) for richer patterns: parallel reviewers, multi-pass review loops. The architectural direction the gemini team is investing in.
- **Gemini Code Assist** GitHub app for PR-comment-based review (`/gemini review`, `/gemini summary`).
- **Direct `gemini -p`** with hardened flags (`--approval-mode plan`, `-e ""`, `--allowed-mcp-server-names ""`, default text output) for shell-equipped consumers.
- **Third-party MCP servers** (e.g. `nicobailon/gemini-code-review-mcp`) for remote MCP clients that need an MCP-callable review surface.

The README's "Code review with this CLI" section carries this list for end users.

`assess`'s public surface is calibrated to `review`'s depth grammar; without `review`, the recommendations have no consumer.

## Alternatives considered

- **Reshape `review` to accept caller-supplied prompts.** Adds bridge surface alongside the official Code Review extension and skill template. Duplication, not protocol translation. Gemini's review architecture centres on skills + subagents, not CLI verbs.
- **Add a generic `gemini` raw-passthrough tool.** `query` already covers opinion-free invocation; the extension and skills cover opinionated review. A new tool would land between two existing surfaces.
- **Keep bundled prompts.** Trades against the speed-mismatch principle; every prompt iteration pays the publish cost.
- **Move depths to a runtime parameter.** Re-introduces opinions about review shape into the bridge.

## Consequences

- **Removed**: `src/tools/{review,assess}.ts`, prompt files, `stripReviewPreamble()` and anchor sets, `src/utils/git.ts` (review/assess were sole consumers), related tests, tool registrations.
- **Bridge surface**: 5 tools (`query`, `structured`, `search`, `fetch-chunk`, `ping`).
- **Loss is small**: every consumer category (shell-equipped, gemini-cli-equipped, GitHub-PR-equipped, MCP-equipped) has at least one ecosystem path.
- **Version bump**: minor (0.6.0 → 0.7.0). Pre-1.0; breaking changes ride on minor bumps. See CHANGELOG for the BREAKING marker.

## Cross-references

- [README § Code review with this CLI](../../README.md#code-review-with-this-cli)
- [CHANGELOG v0.7.0](../../CHANGELOG.md)
