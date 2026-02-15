# GitHub OAuth + YNAB Remote MCP on Cloudflare Workers

This Worker is an **OAuth-protected remote MCP server** for YNAB on Cloudflare Workers.

## Deployment values (exact)

- Worker base URL: `https://remote-mcp-server-authless.dj8gbxbrpp.workers.dev`
- GitHub OAuth App Homepage URL: `https://remote-mcp-server-authless.dj8gbxbrpp.workers.dev/`
- GitHub OAuth Callback URL: `https://remote-mcp-server-authless.dj8gbxbrpp.workers.dev/callback`
- ChatGPT MCP Server URL: `https://remote-mcp-server-authless.dj8gbxbrpp.workers.dev/mcp`
- OAuth Protected Resource Metadata URL: `https://remote-mcp-server-authless.dj8gbxbrpp.workers.dev/.well-known/oauth-protected-resource`

## MCP transport URL

Use **`/mcp`** as the MCP endpoint (streamable HTTP). Do **not** use `/sse`.

## OAuth endpoints ChatGPT uses

- `https://remote-mcp-server-authless.dj8gbxbrpp.workers.dev/authorize`
- `https://remote-mcp-server-authless.dj8gbxbrpp.workers.dev/token`
- `https://remote-mcp-server-authless.dj8gbxbrpp.workers.dev/register`

OAuth flow:

1. ChatGPT starts on `/authorize`.
2. Worker redirects to GitHub.
3. GitHub redirects back to `/callback`.
4. Worker completes OAuth and ChatGPT uses `/mcp`.

> Do **not** paste your GitHub client secret into ChatGPT. Keep `GITHUB_CLIENT_SECRET` only in Cloudflare Worker secrets.

## Required Cloudflare secrets

Set all of the following secrets:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put YNAB_ACCESS_TOKEN
npx wrangler secret put ALLOWED_GITHUB_USERNAME
```

## KV binding

Keep this binding in `wrangler.jsonc`:

- `OAUTH_KV` id = `c1e3f3dc71a740beb172fac97ff7e982`

## Deploy

```bash
npm ci
npm run deploy
```

## Smoke test checklist

1. `GET /.well-known/oauth-protected-resource` returns the expected JSON metadata.
2. `GET /authorize` (and consent submit) redirects to GitHub.
3. OAuth completes and `/mcp` works in an authenticated client (e.g., `ynab_list_budgets`).
