/**
 * Web (happy-dom) test environment guard, loaded via the vitest `web`
 * project's `setupFiles` before any test file.
 *
 * The API client in these tests always goes through the injected fake backend,
 * so the global `fetch` must only ever see Shoelace's same-origin icon
 * requests (`/icons/*.svg`, registered by `ensureHomeIconLibraries` and
 * fetched by `sl-icon` at render time). In happy-dom those resolve against
 * the default origin (localhost:3000 — the owner's development server port),
 * so without this stub every Home test makes real network requests that fail
 * with ECONNREFUSED noise. The stub serves a local SVG for icon paths and
 * records every call; `assertOnlyIconFetches` (called from the Home tests'
 * `afterEach`) fails the test when anything else left the fake backend.
 */

const LOCAL_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor"/></svg>';

const calls: string[] = [];

function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function isIconPath(url: string): boolean {
	let path: string;
	try {
		path = new URL(url, "http://test.invalid").pathname;
	} catch {
		return false;
	}
	return path.startsWith("/icons/") && path.endsWith(".svg");
}

const stubFetch: typeof fetch = async (input) => {
	const url = urlOf(input as string | URL | Request);
	calls.push(url);
	if (isIconPath(url)) {
		return new Response(LOCAL_ICON_SVG, {
			status: 200,
			headers: { "Content-Type": "image/svg+xml" },
		});
	}
	// Never serve it: the afterEach guard below turns any such call into an
	// explicit test failure instead of silent network traffic.
	return new Response(`web tests must not touch the network: ${url}`, {
		status: 404,
		headers: { "Content-Type": "text/plain" },
	});
};

globalThis.fetch = stubFetch;

/** Every URL the global fetch saw since the last reset, in call order. */
export function globalFetchCalls(): readonly string[] {
	return calls;
}

export function resetGlobalFetchCalls(): void {
	calls.length = 0;
}

/** Fails the test when any global fetch was not a local icon request. */
export function assertOnlyIconFetches(): void {
	const outsiders = calls.filter((url) => !isIconPath(url));
	if (outsiders.length > 0) {
		throw new Error(
			`web tests must not touch the network (route it through the fake backend); saw global fetch of: ${outsiders.join(", ")}`,
		);
	}
}
