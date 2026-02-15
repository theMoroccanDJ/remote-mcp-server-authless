export const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});

export const randomHex = (bytes = 16): string => {
	const data = crypto.getRandomValues(new Uint8Array(bytes));
	return [...data].map((value) => value.toString(16).padStart(2, "0")).join("");
};

export const parseCookie = (header: string | null, name: string): string | null => {
	if (!header) return null;
	for (const cookie of header.split(";")) {
		const [key, ...rest] = cookie.trim().split("=");
		if (key === name) {
			return decodeURIComponent(rest.join("="));
		}
	}
	return null;
};

export const setCookie = (name: string, value: string, maxAgeSeconds: number): string =>
	`${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; Secure`;

export const clearCookie = (name: string): string => `${name}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`;
