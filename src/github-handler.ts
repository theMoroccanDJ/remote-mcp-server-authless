const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

const encoder = new TextEncoder();

type GitHubProfile = {
	id: number;
	login: string;
	name: string | null;
	email: string | null;
};

type AuthorizationState = {
	requestedState: string;
	requestedScope: string;
	redirectUri: string;
	clientId: string;
	codeChallenge?: string;
	codeChallengeMethod?: string;
	nonce?: string;
	createdAt: number;
};

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});

const randomString = (bytes = 16) => {
	const data = crypto.getRandomValues(new Uint8Array(bytes));
	return [...data].map((value) => value.toString(16).padStart(2, "0")).join("");
};

const sha256 = async (value: string) => {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const getBaseUrl = (request: Request) => {
	const url = new URL(request.url);
	return `${url.protocol}//${url.host}`;
};

const normalizeUsername = (value: string | undefined) => value?.trim().toLowerCase();

const readPrimaryEmail = async (accessToken: string): Promise<string | null> => {
	const response = await fetch(GITHUB_EMAILS_URL, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "remote-mcp-server-authless",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	if (!response.ok) {
		return null;
	}

	const emails = (await response.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
	const primary = emails.find((item) => item.primary && item.verified) ?? emails.find((item) => item.verified);
	return primary?.email ?? null;
};

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
		return json(500, { error: "server_misconfigured", error_description: "Missing GitHub OAuth secrets." });
	}

	const url = new URL(request.url);
	const requestedState = url.searchParams.get("state") ?? randomString(12);
	const requestedScope = url.searchParams.get("scope") ?? "";
	const redirectUri = url.searchParams.get("redirect_uri") ?? "";
	const clientId = url.searchParams.get("client_id") ?? "";
	const codeChallenge = url.searchParams.get("code_challenge") ?? undefined;
	const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? undefined;
	const nonce = url.searchParams.get("nonce") ?? undefined;

	const relayState = randomString(24);
	const statePayload: AuthorizationState = {
		requestedState,
		requestedScope,
		redirectUri,
		clientId,
		codeChallenge,
		codeChallengeMethod,
		nonce,
		createdAt: Date.now(),
	};

	await env.OAUTH_KV.put(`oauth:state:${relayState}`, JSON.stringify(statePayload), { expirationTtl: 600 });

	const githubState = `${relayState}.${await sha256(`${relayState}:${env.GITHUB_CLIENT_ID}`)}`;
	const githubAuthorize = new URL(GITHUB_AUTHORIZE_URL);
	githubAuthorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	githubAuthorize.searchParams.set("redirect_uri", `${getBaseUrl(request)}/callback`);
	githubAuthorize.searchParams.set("scope", "read:user user:email");
	githubAuthorize.searchParams.set("state", githubState);

	return Response.redirect(githubAuthorize.toString(), 302);
}

async function handleCallback(this: any, request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const githubError = url.searchParams.get("error");

	if (githubError) {
		return json(400, { error: "github_oauth_error", error_description: githubError });
	}

	if (!code || !state) {
		return json(400, { error: "invalid_request", error_description: "Missing GitHub code/state." });
	}

	const [relayState, stateSignature] = state.split(".");
	if (!relayState || !stateSignature) {
		return json(400, { error: "invalid_state" });
	}

	const expectedSignature = await sha256(`${relayState}:${env.GITHUB_CLIENT_ID}`);
	if (expectedSignature !== stateSignature) {
		return json(400, { error: "invalid_state_signature" });
	}

	const stateRecord = await env.OAUTH_KV.get(`oauth:state:${relayState}`, "json");
	if (!stateRecord) {
		return json(400, { error: "expired_state" });
	}
	await env.OAUTH_KV.delete(`oauth:state:${relayState}`);

	const authState = stateRecord as AuthorizationState;

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
			error_description: tokenPayload.error_description ?? tokenPayload.error ?? "GitHub did not return an access token.",
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
	if (!userResponse.ok) {
		return json(400, { error: "profile_fetch_failed", error_description: await userResponse.text() });
	}

	const profile = (await userResponse.json()) as GitHubProfile;
	const email = profile.email ?? (await readPrimaryEmail(accessToken));

	await env.OAUTH_KV.put(
		`oauth:user:${profile.id}`,
		JSON.stringify({
			id: profile.id,
			login: profile.login,
			name: profile.name,
			email,
			issuedAt: Date.now(),
		}),
		{ expirationTtl: 86400 },
	);

	if (typeof this?.completeAuthorization !== "function") {
		return json(500, {
			error: "oauth_provider_misconfigured",
			error_description: "OAuthProvider completion method is unavailable.",
		});
	}

	return this.completeAuthorization({
		request,
		userId: String(profile.id),
		scope: authState.requestedScope,
		clientId: authState.clientId,
		redirectUri: authState.redirectUri,
		state: authState.requestedState,
		codeChallenge: authState.codeChallenge,
		codeChallengeMethod: authState.codeChallengeMethod,
		nonce: authState.nonce,
		props: {
			login: profile.login,
			name: profile.name ?? undefined,
			email: email ?? undefined,
			accessToken,
		},
	});
}

export const GitHubHandler = {
	async fetch(this: any, request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === "/" || pathname === "/health") {
			return Response.json({
				ok: true,
				auth: "github-oauth",
				mcp_sse: "/sse",
				authorize: "/authorize",
				token: "/token",
				register: "/register",
			});
		}

		if (pathname === "/authorize") {
			return handleAuthorize(request, env);
		}

		if (pathname === "/callback") {
			return handleCallback.call(this, request, env);
		}

		return new Response("Not found", { status: 404 });
	},

	async authorize(this: any, request: Request, env: Env): Promise<Response> {
		return handleAuthorize(request, env);
	},

	async callback(this: any, request: Request, env: Env): Promise<Response> {
		return handleCallback.call(this, request, env);
	},

	isAuthorized(this: any, params: { props?: { login?: string } }, env: Env): boolean {
		const allowed = normalizeUsername(env.ALLOWED_GITHUB_USERNAME);
		const login = normalizeUsername(params.props?.login);
		return Boolean(allowed && login && allowed === login);
	},
};
