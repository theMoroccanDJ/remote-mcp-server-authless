import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";

type Props = {
  login: string;
  name: string;
  email: string;
  accessToken: string;
};

// ✅ Only you can use the YNAB tools
const ALLOWED_USERNAMES = new Set([
  "PUT_YOUR_GITHUB_USERNAME_HERE",
]);

const YNAB_BASE = "https://api.ynab.com/v1";

export class MyMCP extends McpAgent<Env, Props> {
  server = new McpServer({ name: "YNAB MCP (read-only)", version: "1.0.0" });

  async init() {
    if (!ALLOWED_USERNAMES.has(this.props.login)) {
      this.server.tool(
        "whoami",
        "Shows the authenticated GitHub username (access is restricted).",
        {},
        async () => ({
          content: [{ type: "text", text: JSON.stringify({ login: this.props.login }) }],
        }),
      );
      return;
    }

    const token = (this.env as any).YNAB_ACCESS_TOKEN as string | undefined;
    if (!token) throw new Error("Missing YNAB_ACCESS_TOKEN secret in Cloudflare.");

    const ynabGet = async (path: string, query?: Record<string, string>) => {
      const url = new URL(YNAB_BASE + path);
      if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
      const r = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`YNAB ${r.status}: ${await r.text()}`);
      return r.json();
    };

    // 1) List budgets
    this.server.tool("ynab_list_budgets", "List all budgets", {}, async () => {
      const data = await ynabGet("/budgets");
      const budgets = (data?.data?.budgets ?? []).map((b: any) => ({ id: b.id, name: b.name }));
      return { content: [{ type: "text", text: JSON.stringify({ budgets }) }] };
    });

    // 2) List accounts
    this.server.tool(
      "ynab_list_accounts",
      "List accounts in a budget",
      { budget_id: z.string() },
      async ({ budget_id }) => {
        const data = await ynabGet(`/budgets/${budget_id}/accounts`);
        const accounts = (data?.data?.accounts ?? []).map((a: any) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          on_budget: a.on_budget,
          closed: a.closed,
          balance: a.balance / 1000,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ accounts }) }] };
      },
    );

    // 3) Month snapshot (categories)
    this.server.tool(
      "ynab_get_month_categories",
      "Get category snapshot for a month (e.g., 'current' or '2026-02-01')",
      { budget_id: z.string(), month: z.string().default("current") },
      async ({ budget_id, month }) => {
        const data = await ynabGet(`/budgets/${budget_id}/months/${month}`);
        const cats = (data?.data?.month?.categories ?? []).map((c: any) => ({
          id: c.id,
          name: c.name,
          budgeted: c.budgeted / 1000,
          activity: c.activity / 1000,
          balance: c.balance / 1000,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ month, categories: cats }) }] };
      },
    );

    // 4) Transactions (paged by limit)
    this.server.tool(
      "ynab_list_transactions",
      "List transactions (use since_date + limit; call multiple times if needed)",
      {
        budget_id: z.string(),
        since_date: z.string().optional(), // YYYY-MM-DD
        account_id: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(200),
      },
      async ({ budget_id, since_date, account_id, limit }) => {
        const query: Record<string, string> = {};
        if (since_date) query.since_date = since_date;
        if (account_id) query.account_id = account_id;

        const data = await ynabGet(`/budgets/${budget_id}/transactions`, query);
        const tx = (data?.data?.transactions ?? []).slice(0, limit).map((t: any) => ({
          id: t.id,
          date: t.date,
          amount: t.amount / 1000,
          payee_name: t.payee_name,
          category_name: t.category_name,
          memo: t.memo,
          cleared: t.cleared,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ count: tx.length, transactions: tx }) }] };
      },
    );
  }
}

// Keep the template’s OAuth wiring as-is (SSE transport endpoint)
export default new OAuthProvider({
  apiHandler: MyMCP.mount("/sse") as any,
  apiRoute: "/sse",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubHandler as any,
  tokenEndpoint: "/token",
});
