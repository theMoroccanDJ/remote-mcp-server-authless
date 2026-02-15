declare module "@cloudflare/workers-oauth-provider" {
	export type AuthRequest = {
		responseType: string;
		clientId: string;
		redirectUri: string;
		scope: string[];
		state: string;
		codeChallenge?: string;
		codeChallengeMethod?: string;
		resource?: string | string[];
	};

	export type OAuthHelpers = {
		parseAuthRequest(request: Request): Promise<AuthRequest>;
		completeAuthorization(options: {
			request: AuthRequest;
			userId: string;
			metadata: unknown;
			scope: string[];
			props: unknown;
		}): Promise<{ redirectTo: string }>;
	};

	export const OAuthProvider: new (options: {
		apiHandler: unknown;
		apiRoute: string;
		authorizeEndpoint: string;
		clientRegistrationEndpoint: string;
		defaultHandler: unknown;
		tokenEndpoint: string;
	}) => ExportedHandler<Env>;
}
