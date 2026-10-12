import type { ApiErrorCode } from "@research/contracts";
import type { FetchLike } from "../src/api/http.ts";
import type { VisibilitySource } from "../src/lib/polling.ts";

export interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: unknown;
	readonly credentials: RequestCredentials | undefined;
}

type Handler = (request: RecordedRequest, match: RegExpExecArray) => Response | Promise<Response>;

export function jsonResponse(
	body: unknown,
	init: { readonly status?: number; readonly headers?: Record<string, string> } = {},
): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "Content-Type": "application/json", ...init.headers },
	});
}

export function errorResponse(
	status: number,
	code: ApiErrorCode,
	message: string,
	detail?: string,
): Response {
	return jsonResponse(
		{ error: detail === undefined ? { code, message } : { code, message, detail } },
		{ status },
	);
}

function readHeaders(init: RequestInit): Record<string, string> {
	const result: Record<string, string> = {};
	new Headers(init.headers).forEach((value, key) => {
		result[key.toLowerCase()] = value;
	});
	return result;
}

function parseBody(body: RequestInit["body"]): unknown {
	if (typeof body !== "string") return undefined;
	const parsed: unknown = JSON.parse(body);
	return parsed;
}

/** An in-memory stand-in for the Hono API: a routed `fetch` that records every request. */
export function createFakeBackend() {
	const requests: RecordedRequest[] = [];
	const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

	const fetch: FetchLike = async (input, init) => {
		const request: RecordedRequest = {
			method: init.method ?? "GET",
			path: input,
			headers: readHeaders(init),
			body: parseBody(init.body),
			credentials: init.credentials,
		};
		requests.push(request);
		// Later registrations win, so a test can override a default route.
		for (const route of [...routes].reverse()) {
			if (route.method !== request.method) continue;
			const match = route.pattern.exec(request.path);
			if (match !== null) return route.handler(request, match);
		}
		return errorResponse(404, "NOT_FOUND", `no fake route for ${request.method} ${request.path}`);
	};

	return {
		fetch,
		requests,
		on(method: string, pattern: RegExp, handler: Handler): void {
			routes.push({ method, pattern, handler });
		},
		requestsTo(method: string, pattern: RegExp): RecordedRequest[] {
			return requests.filter((request) => request.method === method && pattern.test(request.path));
		},
	};
}

export type FakeBackend = ReturnType<typeof createFakeBackend>;

export const ALWAYS_VISIBLE: VisibilitySource = {
	isVisible: () => true,
	subscribe: () => () => {},
};

/** A promise whose resolution the test controls, to observe the UI while a request is pending. */
export function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolvePromise: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}
