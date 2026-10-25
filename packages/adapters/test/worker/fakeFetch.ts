/**
 * A scripted `fetch` for SafeFetcher tests. Web-standard APIs only, so it runs
 * unchanged in the Workers runtime and in Node. It never touches the network:
 * an unscripted URL throws, and every call is recorded so tests can assert
 * that a rejected destination was never requested.
 */
export interface FakeFetchCall {
	readonly url: string;
	readonly method: string | undefined;
	readonly redirect: string | undefined;
	readonly headers: { readonly [name: string]: string };
	readonly signal: AbortSignal | null;
	/** The request body as UTF-8 text (a POST's JSON), or null when none was sent. */
	readonly body: string | null;
}

function bodyText(body: RequestInit["body"]): string | null {
	if (body === undefined || body === null) return null;
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder("utf-8").decode(body);
	throw new TypeError("the fake fetch records string and byte bodies only");
}

export type FakeRoute = (call: FakeFetchCall) => Response | Promise<Response>;

export interface FakeFetch {
	readonly fetch: typeof fetch;
	readonly calls: FakeFetchCall[];
	readonly urls: () => readonly string[];
}

export function createFakeFetch(routes: { readonly [url: string]: FakeRoute }): FakeFetch {
	const calls: FakeFetchCall[] = [];
	const fakeFetch: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headers: { [name: string]: string } = {};
		new Headers(init?.headers).forEach((value, name) => {
			headers[name] = value;
		});
		const call: FakeFetchCall = {
			url,
			method: init?.method,
			redirect: init?.redirect,
			headers,
			signal: init?.signal ?? null,
			body: bodyText(init?.body),
		};
		calls.push(call);
		const route = Object.hasOwn(routes, url) ? routes[url] : undefined;
		if (route === undefined) throw new TypeError(`unscripted fetch to ${url}`);
		return route(call);
	};
	return { fetch: fakeFetch, calls, urls: () => calls.map((call) => call.url) };
}

export function text(body: string, headers: { readonly [name: string]: string } = {}): FakeRoute {
	return () =>
		new Response(body, { status: 200, headers: { "content-type": "text/plain", ...headers } });
}

export function redirectTo(location: string, status = 302): FakeRoute {
	return () => new Response(null, { status, headers: { location } });
}

export function status(code: number): FakeRoute {
	return () => new Response("error page", { status: code });
}

/** A body delivered in the given chunks, counting how many were actually pulled. */
export function chunkedBody(chunks: readonly Uint8Array[]): {
	readonly stream: ReadableStream<Uint8Array>;
	readonly pulled: () => number;
	readonly cancelled: () => boolean;
} {
	let index = 0;
	let wasCancelled = false;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const chunk = chunks[index];
				if (chunk === undefined) {
					controller.close();
					return;
				}
				index += 1;
				controller.enqueue(chunk);
			},
			cancel() {
				wasCancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	return { stream, pulled: () => index, cancelled: () => wasCancelled };
}

/** A body that sends one chunk and then stalls until the request's signal aborts. */
export function stallingBody(signal: AbortSignal | null): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("partial"));
			signal?.addEventListener(
				"abort",
				() => controller.error(new DOMException("aborted", "AbortError")),
				{
					once: true,
				},
			);
		},
	});
}

export const FETCH_LIMITS = { maxBytes: 10_000, timeoutMs: 2_000, accept: "text/plain" } as const;
