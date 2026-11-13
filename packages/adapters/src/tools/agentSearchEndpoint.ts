/** Operator configuration only: literal loopback HTTP, no DNS or redirects. */
export const DEFAULT_AGENT_WEB_SEARCH_URL = "http://127.0.0.1:8090";
export function agentSearchEndpoint(base: string): string | null {
	try {
		const url = new URL(base);
		const loopback = url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
		if (
			url.protocol !== "http:" ||
			!loopback ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			url.hash !== "" ||
			url.href.includes("?") ||
			url.href.includes("#") ||
			url.pathname !== "/" ||
			url.port === "0"
		)
			return null;
		url.pathname = "/search";
		return url.href;
	} catch {
		return null;
	}
}
