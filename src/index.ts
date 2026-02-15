import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";

type Props = {
	login: string;
	name?: string;
	email?: string;
	accessToken?: string;
};

type YnabResponse<T> = {
	data?: T;
};

type EnvWithConfig = Env & {
	ALLOWED_GITHUB_USERNAME: string;
	YNAB_ACCESS_TOKEN: string;
};

const YNAB_BASE = "https://api.ynab.com/v1";

export class MyMCP extends McpAgent<EnvWithConfig, Props> {
	server = new McpServer({ name: "ynab-mcp", version: "1.0.0" });

	async init() {
		const allowedUsername = this.env.ALLOWED_GITHUB_USERNAME?.trim().toLowerCase();
		const login = this.props?.login?.trim().toLowerCase();

		if (!login || !allowedUsername || login !== allowedUsername) {
			this.server.tool(
				"whoami",
				"Shows the authenticated GitHub username and current allowlist status.",
				{},
				async () => ({
					content: [
						{
							type: "text",
							text: JSON.stringify({
								allowed: false,
								configured_allowlist_username: allowedUsername,
								authenticated_username: login ?? null,
							}),
						},
					],
				}),
			);
			return;
		}

		const token = this.env.YNAB_ACCESS_TOKEN;
		if (!token) {
			throw new Error("Missing YNAB_ACCESS_TOKEN Cloudflare secret.");
		}

		const ynabGet = async <T>(path: string, query?: Record<string, string>) => {
			const url = new URL(`${YNAB_BASE}${path}`);
			for (const [key, value] of Object.entries(query ?? {})) {
				url.searchParams.set(key, value);
			}

			const response = await fetch(url.toString(), {
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			if (!response.ok) {
				throw new Error(`YNAB API error ${response.status}: ${await response.text()}`);
			}

			return (await response.json()) as YnabResponse<T>;
		};

		this.server.tool("ynab_list_budgets", "List all YNAB budgets.", {}, async () => {
			const payload = await ynabGet<{ budgets?: Array<{ id: string; name: string }> }>("/budgets");
			const budgets = payload.data?.budgets?.map(({ id, name }) => ({ id, name })) ?? [];
			return { content: [{ type: "text", text: JSON.stringify({ budgets }) }] };
		});

		this.server.tool(
			"ynab_list_accounts",
			"List accounts for a YNAB budget.",
			{ budget_id: z.string() },
			async ({ budget_id }) => {
				const payload = await ynabGet<{
					accounts?: Array<{
						id: string;
						name: string;
						type: string;
						on_budget: boolean;
						closed: boolean;
						balance: number;
					}>;
				}>(`/budgets/${budget_id}/accounts`);
				const accounts =
					payload.data?.accounts?.map((account) => ({
						...account,
						balance: account.balance / 1000,
					})) ?? [];

				return { content: [{ type: "text", text: JSON.stringify({ accounts }) }] };
			},
		);

		this.server.tool(
			"ynab_list_transactions",
			"List YNAB transactions (optionally filtered by since_date/account_id).",
			{
				budget_id: z.string(),
				since_date: z.string().optional(),
				account_id: z.string().optional(),
				limit: z.number().int().min(1).max(500).default(200),
			},
			async ({ budget_id, since_date, account_id, limit }) => {
				const query: Record<string, string> = {};
				if (since_date) query.since_date = since_date;
				if (account_id) query.account_id = account_id;

				const payload = await ynabGet<{
					transactions?: Array<{
						id: string;
						date: string;
						amount: number;
						payee_name: string | null;
						category_name: string | null;
						memo: string | null;
						cleared: string;
					}>;
				}>(`/budgets/${budget_id}/transactions`, query);

				const transactions =
					payload.data?.transactions
						?.slice(0, limit)
						.map((transaction) => ({ ...transaction, amount: transaction.amount / 1000 })) ?? [];

				return { content: [{ type: "text", text: JSON.stringify({ count: transactions.length, transactions }) }] };
			},
		);

		this.server.tool(
			"ynab_get_month_categories",
			"Get category balances for a YNAB month (e.g. current or 2026-02-01).",
			{ budget_id: z.string(), month: z.string().default("current") },
			async ({ budget_id, month }) => {
				const payload = await ynabGet<{
					month?: {
						categories?: Array<{ id: string; name: string; budgeted: number; activity: number; balance: number }>;
					};
				}>(`/budgets/${budget_id}/months/${month}`);
				const categories =
					payload.data?.month?.categories?.map((category) => ({
						...category,
						budgeted: category.budgeted / 1000,
						activity: category.activity / 1000,
						balance: category.balance / 1000,
					})) ?? [];

				return { content: [{ type: "text", text: JSON.stringify({ month, categories }) }] };
			},
		);
	}
}

export default new OAuthProvider({
	apiHandler: MyMCP.mount("/sse") as never,
	apiRoute: "/sse",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler,
	tokenEndpoint: "/token",
});
