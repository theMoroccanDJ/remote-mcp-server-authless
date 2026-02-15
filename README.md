# GitHub OAuth + YNAB Remote MCP on Cloudflare Workers

This Worker is now configured as an **OAuth-protected remote MCP server** using the Cloudflare Workers OAuth provider pattern, with **read-only YNAB tools**.

Only the GitHub username configured in `ALLOWED_GITHUB_USERNAME` can load YNAB tools; all other users get a safe `whoami` response and no budget/account/transaction/category tools are registered.

## What this server exposes

- `ynab_list_budgets`
- `ynab_list_accounts`
- `ynab_list_transactions` (supports `since_date`)
- `ynab_get_month_categories`

Access is restricted by GitHub login allowlist (`ALLOWED_GITHUB_USERNAME`).

---

## 1) Configure Cloudflare resources

### Create KV namespace for OAuth state

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create OAUTH_KV --preview
```

Set `kv_namespaces[0].id` in `wrangler.jsonc` to your created namespace ID.

> For local `wrangler dev`, you can additionally set `preview_id` if you use a dedicated preview KV namespace.

### Set required secrets

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put YNAB_ACCESS_TOKEN
```

### Set required environment variable (allowlist)

Set this in Cloudflare Worker settings (or with Wrangler env vars):

- `ALLOWED_GITHUB_USERNAME=<your-github-username>`

Only this GitHub user can access YNAB tools.

---

## 2) GitHub OAuth app setup

Create/update a GitHub OAuth App and set:

- **Authorization callback URL**: `https://<your-worker-domain>/callback`
- Homepage URL: `https://<your-worker-domain>/`

Example Worker domain:

- `https://remote-mcp-server-authless.<account>.workers.dev`

---

## 3) Deploy

```bash
npm install
npm run deploy
```

---

## 4) MCP endpoint for ChatGPT

Use this MCP server URL in ChatGPT:

- `https://<your-worker-domain>/sse`

OAuth endpoints used by the provider:

- `/authorize`
- `/token`
- `/register`

---

## Local development

```bash
npm run dev
npm run type-check
```
