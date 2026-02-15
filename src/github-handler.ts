/**
 * Basic handler for non-MCP routes.
 *
 * OAuth routes are handled by @cloudflare/workers-oauth-provider in src/index.ts.
 * This handler keeps root and health routes explicit and avoids 404 ambiguity.
 */
export const GitHubHandler = {
	async fetch(request: Request): Promise<Response> {
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

		return new Response("Not found", { status: 404 });
	},
};
