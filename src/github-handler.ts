import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { clearCookie, json, parseCookie, randomHex, setCookie } from "./utils";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";
const OAUTH_STATE_COOKIE = "oauth_request_state";
const OAUTH_PENDING_PREFIX = "oauth:pending:";

type PendingAuthorization = {
	authRequest: AuthRequest;
	createdAt: number;
};

type EnvWithOAuthProvider = Env & {
	OAUTH_PROVIDER?: OAuthHelpers;
};

type GitHubProfile = {
	id: number;
	login: string;
	name: string | null;
	email: string | null;
};

const consentPage = (requestId: string, scope?: string) => `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Authorize ChatGPT</title>
	<style>
		body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; }
		.card { border: 1px solid #ddd; border-radius: 12px; padding: 1rem 1.25rem; }
		button { margin-top: 1rem; background: #111; color: #fff; border: 0; border-radius: 8px; padding: .6rem .9rem; cursor: pointer; }
		code { background: #f4f4f5; padding: .15rem .35rem; border-radius: .35rem; }
	</style>
</head>
<body>
	<div class="card">
		<h1>Authorize ChatGPT</h1>
		<p>Continue with GitHub to authorize this MCP server.</p>
		<p>Requested scope: <code>${scope || "(none)"}</code></p>
		<form method="post" action="/authorize">
			<input type="hidden" name="request_id" value="${requestId}" />
			<button type="submit">Continue with GitHub</button>
		</form>
	</div>
</body>
</html>`;

const normalizeUsername = (value: string | undefined) => value?.trim().toLowerCase();

const getBaseUrl = (request: Request) => {
	const url = new URL(request.url);
	return `${url.protocol}//${url.host}`;
};

const readPrimaryEmail = async (accessToken: string): Promise<string | null> => {
	const response = await fetch(GITHUB_EMAILS_URL, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "remote-mcp-server-authless",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	if (!response.ok) return null;

	const emails = (await response.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
	const primary = emails.find((item) => item.primary && item.verified) ?? emails.find((item) => item.verified);
	return primary?.email ?? null;
};

const handleAuthorizeGet = async (request: Request, env: EnvWithOAuthProvider): Promise<Response> => {
	if (!env.OAUTH_PROVIDER?.parseAuthRequest) {
		return json(500, { error: "server_misconfigured", error_description: "OAuth provider not configured." });
	}

	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	} catch {
		return json(400, {
			error: "invalid_request",
			error_description: "Client ID and Redirect URI are required in the authorization request.",
		});
	}

	const requestId = randomHex(24);
	const pending: PendingAuthorization = {
		authRequest: oauthReqInfo,
		createdAt: Date.now(),
	};

	await env.OAUTH_KV.put(`${OAUTH_PENDING_PREFIX}${requestId}`, JSON.stringify(pending), { expirationTtl: 600 });

	return new Response(consentPage(requestId, oauthReqInfo.scope.join(" ")), {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
};

const handleAuthorizePost = async (request: Request, env: EnvWithOAuthProvider): Promise<Response> => {
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
		return json(500, { error: "server_misconfigured", error_description: "Missing GitHub OAuth secrets." });
	}

	const formData = await request.formData();
	const requestId = String(formData.get("request_id") ?? "");
	if (!requestId) {
		return json(400, { error: "invalid_request", error_description: "Missing consent request id." });
	}

	const pendingRaw = await env.OAUTH_KV.get(`${OAUTH_PENDING_PREFIX}${requestId}`);
	if (!pendingRaw) {
		return json(400, { error: "expired_state", error_description: "Authorization request expired." });
	}

	const githubAuthorize = new URL(GITHUB_AUTHORIZE_URL);
	githubAuthorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	githubAuthorize.searchParams.set("redirect_uri", `${getBaseUrl(request)}/callback`);
	githubAuthorize.searchParams.set("scope", "read:user user:email");
	githubAuthorize.searchParams.set("state", requestId);

	return new Response(null, {
		status: 302,
		headers: {
			Location: githubAuthorize.toString(),
			"Set-Cookie": setCookie(OAUTH_STATE_COOKIE, requestId, 600),
			"Cache-Control": "no-store",
		},
	});
};

const handleCallback = async (request: Request, env: EnvWithOAuthProvider): Promise<Response> => {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const githubError = url.searchParams.get("error");
	const githubErrorDescription = url.searchParams.get("error_description");

	if (githubError) {
		return json(400, {
			error: "github_oauth_error",
			error_description: githubErrorDescription ?? githubError,
		});
	}
	if (!code || !state) return json(400, { error: "invalid_request", error_description: "Missing code/state." });

	try {
		if (!env.OAUTH_PROVIDER?.completeAuthorization) {
			return json(500, { error: "server_misconfigured", error_description: "OAuth provider not configured." });
		}

		const cookieState = parseCookie(request.headers.get("cookie"), OAUTH_STATE_COOKIE);
		if (!cookieState || cookieState !== state) {
			return json(400, { error: "invalid_state", error_description: "State cookie mismatch." });
		}

		const pendingKey = `${OAUTH_PENDING_PREFIX}${state}`;
		const pendingRaw = await env.OAUTH_KV.get(pendingKey);
		if (!pendingRaw) {
			return json(400, { error: "expired_state", error_description: "Authorization request expired." });
		}
		await env.OAUTH_KV.delete(pendingKey);
		const { authRequest } = JSON.parse(pendingRaw) as PendingAuthorization;

		const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"content-type": "application/json",
				"User-Agent": "remote-mcp-server-authless",
			},
			body: JSON.stringify({
				client_id: env.GITHUB_CLIENT_ID,
				client_secret: env.GITHUB_CLIENT_SECRET,
				code,
				redirect_uri: `${getBaseUrl(request)}/callback`,
			}),
		});

		const tokenPayload = (await tokenResponse.json()) as { access_token?: string; error?: string; error_description?: string };
		if (!tokenResponse.ok || !tokenPayload.access_token) {
			return json(400, {
				error: "token_exchange_failed",
				error_description: tokenPayload.error_description ?? tokenPayload.error ?? "No GitHub access token.",
			});
		}

		const accessToken = tokenPayload.access_token;
		const userResponse = await fetch(GITHUB_USER_URL, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${accessToken}`,
				"User-Agent": "remote-mcp-server-authless",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!userResponse.ok) return json(400, { error: "profile_fetch_failed", error_description: await userResponse.text() });

		const profile = (await userResponse.json()) as GitHubProfile;
		const email = profile.email ?? (await readPrimaryEmail(accessToken));

		const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
			request: authRequest,
			userId: profile.login || String(profile.id),
			scope: authRequest.scope,
			metadata: {},
			props: {
				login: profile.login,
				name: profile.name ?? undefined,
				email: email ?? undefined,
				accessToken,
			},
		});

		return new Response(null, {
			status: 302,
			headers: {
				Location: redirectTo,
				"Set-Cookie": clearCookie(OAUTH_STATE_COOKIE),
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		return json(400, {
			error: "callback_failed",
			error_description: error instanceof Error ? error.message : "Unknown callback error",
		});
	}
};

export const GitHubHandler = {
	async fetch(request: Request, env: EnvWithOAuthProvider, _ctx: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === "/" || pathname === "/health") {
			return Response.json({
				ok: true,
				auth: "github-oauth",
				mcp: "/mcp",
				authorize: "/authorize",
				token: "/token",
				register: "/register",
			});
		}

		if (pathname === "/authorize" && request.method === "GET") return handleAuthorizeGet(request, env);
		if (pathname === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env);
		if (pathname === "/callback" && request.method === "GET") return handleCallback(request, env);

		return new Response("Not found", { status: 404 });
	},

	isAuthorized(this: any, params: { props?: { login?: string } }, env: Env): boolean {
		const allowed = normalizeUsername(env.ALLOWED_GITHUB_USERNAME);
		const login = normalizeUsername(params.props?.login);
		return Boolean(allowed && login && allowed === login);
	},
};
