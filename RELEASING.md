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

The MCP server is a long-lived process. Testing the published package requires switching the MCP source and restarting the client.

### 1. Switch MCP to published npm

```bash
claude mcp remove gemini-bridge -s user && claude mcp add gemini-bridge -s user -- npx -y gemini-mcp-bridge
```

### 2. Start a fresh Claude Code session

Restart Claude Code so it picks up the new MCP server process.

### 3. Verify all tools

| Tool | Test | Expected |
|------|------|----------|
| `ping` | Call ping tool | Returns healthy, correct version |
| `query` | "What is 2+2?" | Returns 4 |
| `review` | Run against a repo with uncommitted changes | Returns review feedback |
| `search` | "latest node.js LTS version" | Returns search results |

### 4. Switch back to local build (if resuming development)

```bash
claude mcp remove gemini-bridge -s user && claude mcp add gemini-bridge -s user -- node /home/tim/NUI/gemini-mcp-bridge/dist/index.js
```

## Rollback

If the published package is broken:

1. `npm unpublish gemini-mcp-bridge@X.Y.Z` (within 72 hours)
2. Switch MCP back to previous version or local build
3. Fix, bump to `X.Y.Z+1`, re-release
