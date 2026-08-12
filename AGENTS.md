# RUZ MCP Agent Instructions

## Project

- **Purpose:** TypeScript MCP server for the Slovak Register of Financial Statements.
- **Jurisdiction:** Slovakia.
- **Primary data sources:** The official Register of Financial Statements public source documented in the repository.
- **Personal upstream:** `https://github.com/originalmagneto/RUZ-MCP`.
- **Team copy:** `https://github.com/Omni-Legal-Products/mcp-ruz`.

The personal repository is the source of truth. Offer functional changes from the team copy back to the personal upstream before synchronization.

## Before Editing

1. Read this file, `README.md` or `DEPLOYMENT.md`, `package.json`, affected tests, and relevant Docker files.
2. Confirm the branch and working tree.
3. Keep the diff focused and ask before unrelated refactoring.
4. Verify time-sensitive facts about external endpoints and source formats.
5. Preserve established TypeScript and npm conventions.

## Code and MCP Contracts

- Use the committed lockfile and strict TypeScript.
- Prefer small functional helpers and keep comments in English.
- Preserve public MCP tool names, input schemas, output schemas, defaults, pagination, and error behavior unless a breaking migration is explicitly approved.
- Add targeted tests for approved contract changes.
- Do not add dependencies or deployment changes without explaining the need.

## Required Offline Verification

Install with `npm ci`, then run:

- `npm run typecheck`
- `npm test`
- `npm run build`

Optional live or smoke check: `npm run test:live`

Live, HTTP, scraping, indexing, backfill, email, maintenance, and production commands are not part of default verification. Run them only with explicit user approval after checking credentials and external effects.

A passing test proves technical behavior only. Report source retrieval, parsing correctness, temporal validity, and legal or domain correctness separately. Record baseline failures accurately.

## Security

- Never commit secrets, API keys, tokens, OAuth credentials, private keys, production `.env` files, Dokploy values, client data, privileged material, or production logs with personal data.
- Use unmistakable placeholders in example configuration.
- Do not expose private repository content through public logs, issues, or artifacts.
- Do not weaken authentication, authorization, rate limits, or transport security without explicit approval.

## Deployment Boundary

- Do not deploy, redeploy, restart, stop, or reconfigure Dokploy without explicit approval for that exact action.
- Do not change production domains, environment variables, volumes, databases, or secrets during ordinary code work.
- Identify the personal upstream commit or tag before an approved deployment.
- The team copy is not automatically a production source.
- Never force push a production branch.

## Git and Collaboration

- Use short branches, conventional commits, and focused Pull Requests.
- Pull current changes before pushing.
- Do not overwrite another contributor's work or authorship.
- Resolve functional divergence in the personal upstream first.
- Keep `main` protected from force push and deletion.

## Mirror Rule

`AGENTS.md` is the single source of truth. Root `CLAUDE.md` must be byte-for-byte identical and updated in the same commit.

```bash
cmp -s AGENTS.md CLAUDE.md
shasum -a 256 AGENTS.md CLAUDE.md
```

## Completion Checklist

- [ ] The change matches the requested scope.
- [ ] No unrelated refactor, secret, client data, or production credential is included.
- [ ] MCP compatibility is preserved or an approved migration is documented.
- [ ] Required offline checks passed, or the exact blocker is reported.
- [ ] Legal or domain correctness is not inferred from technical tests.
- [ ] No production action occurred without explicit approval.
- [ ] `AGENTS.md` and `CLAUDE.md` are byte-for-byte identical.
