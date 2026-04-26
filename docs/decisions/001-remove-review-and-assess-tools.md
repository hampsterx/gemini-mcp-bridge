# ADR-001: Remove `review` and `assess` tools

**Status**: Accepted
**Date**: 2026-04-26

## Context

This bridge registers `query`, `structured`, `search`, `fetch-chunk`, `ping`, plus `review` (bundled reviewer prompts, depth selector) and `assess` (depth recommender for `review`).

CLI-wrapping tools should accept caller-supplied prompts rather than bundle them: prompts iterate fast, bridges publish slowly. `review` crosses that boundary.

The gemini ecosystem ships multiple off-the-shelf review paths today:

- **Official `gemini-cli-extensions/code-review` extension** registers `/code-review` and `/pr-code-review` slash commands. Maintained in the `gemini-cli-extensions` GitHub org.
- **Official `.gemini/skills/code-reviewer/SKILL.md`** in the `google-gemini/gemini-cli` repo as a shipped skill template. The skills feature itself went GA on 28 January 2026 (`/skills` slash command, `~/.gemini/skills`, `.gemini/skills`, extension-bundled skills).
- **Subagents** went GA on 15 April 2026: built-ins (`codebase_investigator`, `cli_help`, `generalist`) plus custom agents in `.gemini/agents` / `~/.gemini/agents`. This is the architectural surface where richer review patterns (parallel reviewers, review-loop subagents per gemini-cli issue #22600) converge.
- **Gemini Code Assist** GitHub app for PR-comment-based review (separate Google product; `/gemini review`, `/gemini summary` in PR comments).
- **Third-party MCP servers** specifically for gemini code review: `nicobailon/gemini-code-review-mcp`, `gemini-reviews-mcp`, `gemini-code-review-mcp`.

The gemini ecosystem already ships several review paths; this bridge is not the right layer to add another.

## Decision

Drop `review` and `assess`.

Code review with gemini uses the ecosystem's existing surfaces. In rough priority order for new users:

- **Official Code Review extension** (`gemini-cli-extensions/code-review`) for slash-command-driven review inside gemini-cli. Recommended path for users who want a maintained, gemini-team-blessed implementation.
- **Skills** (`/skills`, `.gemini/skills/code-reviewer/SKILL.md` as a starting template) for users wanting a customisable, locally-defined review.
- **Subagents** for richer patterns (parallel reviewers, multi-pass review loops). The architectural direction the gemini team is investing in.
- **Gemini Code Assist** GitHub app for PR-comment-based review.
- **Direct `gemini -p`** with hardened flags (`--approval-mode plan`, `-e ""`, `--allowed-mcp-server-names ""`, default text output) for shell-equipped consumers who want full control.
- **Third-party MCP servers** if a remote MCP client needs an MCP-callable review surface and can install a different bridge.

The bridge's job is to wrap gemini CLI invocation generically (via `query`/`structured`/`search`/`fetch-chunk`), not to compete with the ecosystem's review surfaces. The README's "Code review with this CLI" section links to the ecosystem paths in priority order.

`assess`'s public surface is calibrated to `review`'s depth grammar. Without `review`, the recommendations have no consumer.

## Why drop rather than reshape

The reshape pattern (a `review` tool that accepts caller-supplied prompts and applies hardened CLI defaults) is rejected because:

1. **The ecosystem already ships multiple review surfaces.** Adding bridge surface to sit alongside the official Code Review extension and the official skill template is duplication, not protocol translation.
2. **Gemini's review architecture centres on skills + subagents, not CLI verbs.** A reshaped `review` tool inside this bridge would be an MCP wrapper around a CLI invocation, defending a layer the upstream architecture isn't investing in. Bridges age badly when they invent surface that upstream sidesteps.

If a concrete audience emerges that none of the ecosystem paths serve (e.g. a remote MCP client that can't install extensions, can't reach Code Assist, and can't use a third-party MCP server), reconsider. Until then, this bridge stays scoped to its stateful tools.

## Alternatives considered

**Reshape `review` to accept caller-supplied prompts (protocol-translator pattern).** See § Why drop rather than reshape.

**Add a generic `gemini` raw-passthrough tool.** The official Code Review extension and the skills surface already cover callers wanting an opinionated review; `query` already covers callers wanting opinion-free invocation. A new raw-passthrough tool would land between two surfaces that already exist.

**Keep bundled prompts.** Trades against the speed-mismatch principle; every prompt iteration pays the publish cost.

**Move depths to a tool parameter; pick prompts at runtime.** Re-introduces opinions about review shape into the bridge.

## Consequences

- **Removed**: `src/tools/review.ts`, `src/tools/assess.ts`, prompt files, the `stripReviewPreamble()` helper and its anchor-pattern sets (after confirming no other tool imports them), related tests, tool registrations.
- **Documentation updated**: `DESIGN.md` review-tool sections, docstrings in shared utilities that mention review, root-level handover and plan documents tracking the stripper iteration work archived.
- **Bridge surface**: 5 tools (`query`, `structured`, `search`, `fetch-chunk`, `ping`).
- **Loss is small**: every consumer category (shell-equipped, gemini-cli-equipped, GitHub-PR-equipped, MCP-equipped) has at least one ecosystem path.
- **Version bump**: minor.

## Cross-references

- README § Code review with this CLI (links to ecosystem paths in priority order)
- CHANGELOG entry for this version
- Ecosystem references:
  - Code Review extension: `github.com/gemini-cli-extensions/code-review`
  - Skills feature: announced 28 Jan 2026; docs in `google-gemini/gemini-cli/docs/extensions/reference.md`
  - Subagents: announced 15 Apr 2026; docs in `google-gemini/gemini-cli/docs/core/subagents.md`
  - Code Assist GitHub app: `developers.google.com/gemini-code-assist/docs/review-github-code`
  - Third-party MCP servers: `nicobailon/gemini-code-review-mcp`, `pypi.org/project/gemini-reviews-mcp/`, `pypi.org/project/gemini-code-review-mcp/`
