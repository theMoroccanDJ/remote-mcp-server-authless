import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
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

type RequestLogContext = {
	path: string;
	requestId: string;
};

const logInfo = (event: string, context: RequestLogContext, extra: Record<string, unknown> = {}) => {
	console.log(JSON.stringify({ event, ...context, ...extra }));
};

export class MyMCP extends McpAgent<EnvWithConfig, unknown, Props> {
	server = new McpServer({ name: "ynab-mcp", version: "1.0.0" });

	async setInitializeRequest(initializeRequest: JSONRPCMessage): Promise<void> {
		const startedAt = Date.now();
		await super.setInitializeRequest(initializeRequest);
		console.log(
			JSON.stringify({
				event: "mcp_initialize_request_set",
				session: this.name,
				duration_ms: Date.now() - startedAt,
			}),
		);
	}

	async getInitializeRequest(): Promise<JSONRPCMessage | undefined> {
		const startedAt = Date.now();
		const initializeRequest = await super.getInitializeRequest();
		console.log(
			JSON.stringify({
				event: "mcp_initialize_request_get",
				session: this.name,
				found: Boolean(initializeRequest),
				duration_ms: Date.now() - startedAt,
			}),
		);
		return initializeRequest;
	}

	async updateProps(props?: Props): Promise<void> {
		const startedAt = Date.now();
		await super.updateProps(props);
		console.log(
			JSON.stringify({
				event: "mcp_props_updated",
				session: this.name,
				login_present: Boolean(props?.login),
				duration_ms: Date.now() - startedAt,
			}),
		);
	}

	async init() {
		const allowedUsername = this.env.ALLOWED_GITHUB_USERNAME?.trim().toLowerCase();
		const login = this.props?.login?.trim().toLowerCase();
		const allowlistMatched = Boolean(allowedUsername && login && login === allowedUsername);

		this.server.tool(
			"debug_auth_status",
			"Debug authentication/session status without exposing secrets.",
			{},
			async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							props_login_exists: Boolean(login),
							allowlist_matched: allowlistMatched,
							ynab_token_env_exists: Boolean(this.env.YNAB_ACCESS_TOKEN),
						}),
					},
				],
			}),
		);

		if (!allowedUsername) {
			throw new Error("Missing ALLOWED_GITHUB_USERNAME Cloudflare secret.");
		}

		if (!allowlistMatched) {
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

const oauthProvider = new OAuthProvider({
	apiHandler: MyMCP.serve("/mcp") as never,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler,
	tokenEndpoint: "/token",
});

const getBaseUrl = (request: Request) => {
	const url = new URL(request.url);
	return `${url.protocol}//${url.host}`;
};

const getProtectedResourceMetadata = (request: Request) => {
	const resource = getBaseUrl(request);
	return {
		resource,
		authorization_servers: [resource],
		scopes_supported: ["ynab:read"],
		resource_documentation: "https://github.com/theMoroccanDJ/remote-mcp-server-authless",
	};
};

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
		const context: RequestLogContext = { path: url.pathname, requestId };
		const startedAt = Date.now();
		logInfo("request_start", context, { method: request.method });

		if (url.pathname === "/.well-known/oauth-protected-resource" && request.method === "GET") {
			return Response.json(getProtectedResourceMetadata(request));
		}

		if (!oauthProvider.fetch) {
			throw new Error("OAuth provider fetch handler is not configured.");
		}

		const response = await oauthProvider.fetch(request as any, env, ctx);
		logInfo("request_complete", context, {
			method: request.method,
			status: response.status,
			duration_ms: Date.now() - startedAt,
		});

		if (url.pathname === "/mcp" && response.status === 401) {
			const headers = new Headers(response.headers);
			headers.set(
				"WWW-Authenticate",
				`Bearer realm="mcp", resource_metadata="${getBaseUrl(request)}/.well-known/oauth-protected-resource"`,
			);
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}

		return response;
	},
};
