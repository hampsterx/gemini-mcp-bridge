# Releasing gemini-mcp-bridge

Generic release checklist. Replace `X.Y.Z` with the actual version.

## Pre-release checks

- [ ] All changes merged to `master`
- [ ] `npm test` passes
- [ ] `npm run lint` clean
- [ ] `npm run typecheck` clean
- [ ] `npm run build` succeeds
- [ ] Smoke test passes: `npm run smoke`

## Release

1. Bump `version` in `package.json`
2. Add entry to `CHANGELOG.md` with version, date, and changes
3. Commit: `git commit -m "release: vX.Y.Z"`
4. Tag: `git tag vX.Y.Z`
5. Push: `git push origin master --tags`
6. Create GitHub release:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "See CHANGELOG.md"
   ```
7. GitHub Actions publishes to npm automatically via OIDC trusted publishing (`.github/workflows/publish.yml`). Watch the run:
   ```bash
   gh run watch
   ```

> **OIDC notes:** The workflow upgrades npm to latest before publishing because OIDC trusted publishing requires npm ≥ 11.5.1 and Node 22 LTS ships with npm 10.x. The trusted publisher is configured on npmjs.com under gemini-mcp-bridge → Settings → Publishing access, pointing at `hampsterx/gemini-mcp-bridge` / `publish.yml`. If the workflow ever fails with `E404 Not Found`, the fallback is `npm publish --access public` locally with an OTP.

## Post-release validation

### 1. Confirm the version is on npm

```bash
npm view gemini-mcp-bridge version    # should show X.Y.Z
```

### 2. Confirm the package runs

```bash
npx -y gemini-mcp-bridge@X.Y.Z < /dev/null
```

The bin is an MCP stdio server with no `--help` flag, so this feeds it an empty stdin and lets it exit cleanly. Any import errors, missing bundled files (`prompts/*.md`, `policies/*.toml`), or bad bin entry will surface as a non-zero exit or stderr output. Silent exit = healthy tarball.

### 3. Verify tools via an MCP client

Point your MCP client (Claude Code, Codex CLI, Cursor, Windsurf, VS Code, etc.) at `npx -y gemini-mcp-bridge@X.Y.Z`, restart the client so it spawns a fresh server process, then exercise each tool:

| Tool | Test | Expected |
|------|------|----------|
| `ping` | Call ping tool | Returns healthy, correct version |
| `query` | "What is 2+2?" | Returns 4 |
| `review` | Run against a repo with uncommitted changes | Returns review feedback |
| `search` | "latest node.js LTS version" | Returns search results |

The exact switch commands depend on your MCP client. Consult its documentation for how to register an MCP server by command.

## Rollback

If the published package is broken:

1. `npm unpublish gemini-mcp-bridge@X.Y.Z` (within 72 hours)
2. Switch MCP back to previous version or local build
3. Fix, bump to `X.Y.Z+1`, re-release
