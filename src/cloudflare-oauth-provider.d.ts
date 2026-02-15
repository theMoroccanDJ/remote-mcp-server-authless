declare module "@cloudflare/workers-oauth-provider" {
	export const OAuthProvider: new (options: {
		apiHandler: unknown;
		apiRoute: string;
		authorizeEndpoint: string;
		clientRegistrationEndpoint: string;
		defaultHandler: unknown;
		tokenEndpoint: string;
	}) => ExportedHandler<Env>;
}
