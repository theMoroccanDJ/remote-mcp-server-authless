# GitHub OAuth + YNAB Remote MCP on Cloudflare Workers

This Worker is configured as an **OAuth-protected remote MCP server** using Cloudflare Workers OAuth provider endpoints.

## Deployed URLs

- Homepage URL: `https://remote-mcp-server-authless.dj8gbxbrpp.workers.dev/`
- GitHub OAuth callback URL: `https://remote-mcp-server-authless.dj8gbxbrpp.workers.dev/callback`
- ChatGPT MCP server URL: `https://remote-mcp-server-authless.dj8gbxbrpp.workers.dev/mcp`

## OAuth flow used by ChatGPT

ChatGPT connects to the MCP endpoint (`/mcp`) and performs OAuth against Worker-managed endpoints:

- `/authorize`
- `/token`
- `/register`

`/authorize` starts consent and redirects to GitHub, then GitHub returns to `/callback`, and the Worker completes OAuth through Cloudflare's OAuth provider.

> Do **not** paste your GitHub client secret into ChatGPT. Keep `GITHUB_CLIENT_SECRET` only in Worker secrets.

## Existing KV binding

Keep the configured binding in `wrangler.jsonc`:

- `OAUTH_KV` id: `c1e3f3dc71a740beb172fac97ff7e982`

## Setup reminders

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put YNAB_ACCESS_TOKEN
```

Set allowlist username:

- `ALLOWED_GITHUB_USERNAME=<your-github-username>`

## Deploy

```bash
npm install
npm run deploy
```

## Smoke test checklist

1. Visit `/authorize` with OAuth query parameters and verify consent page renders.
2. Click continue, authenticate on GitHub, and verify redirect to `/callback` completes authorization.
3. Connect ChatGPT to `/mcp`, finish OAuth, and confirm MCP tools are visible.
