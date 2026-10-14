import { DEFAULT_HOME_DASHBOARD } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { createHomeDashboardStore, type HomeStoreFetch } from "../src/homeStore.ts";

const API_ORIGIN = "http://127.0.0.1:8787";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function dashboardBody(
	version: number,
	widgets: readonly unknown[] = DEFAULT_HOME_DASHBOARD.widgets,
) {
	return { dashboard: { schemaVersion: 1, widgets }, version, updatedAt: null, origin: "saved" };
}

/** A fetch that records its calls and answers from `handler`. */
function recordingFetch(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: HomeStoreFetch; calls: { readonly url: string; readonly init: RequestInit }[] } {
	const calls: { url: string; init: RequestInit }[] = [];
	return {
		calls,
		fetch: (input, init) => {
			calls.push({ url: input, init });
			return Promise.resolve(handler(input, init));
		},
	};
}

describe("createHomeDashboardStore", () => {
	it("reads the dashboard with the version as the revision", async () => {
		const backend = recordingFetch(() => jsonResponse(dashboardBody(4)));
		const store = createHomeDashboardStore({ apiOrigin: API_ORIGIN, fetch: backend.fetch });
		const read = await store.read();
		if (!read.ok) throw new Error(JSON.stringify(read.error));
		expect(read.value.revision).toBe(4);
		expect(read.value.widgets).toHaveLength(7);
		expect(backend.calls).toHaveLength(1);
		expect(backend.calls[0]?.url).toBe(`${API_ORIGIN}/api/v1/home/dashboard`);
		expect(backend.calls[0]?.init.method).toBe("GET");
	});

	it("reports an unreadable body as unavailable", async () => {
		for (const response of [
			new Response("<html>not json</html>", { status: 404 }),
			jsonResponse({ nope: true }),
			new Response("", { status: 200 }),
		]) {
			const backend = recordingFetch(() => response);
			const store = createHomeDashboardStore({ apiOrigin: API_ORIGIN, fetch: backend.fetch });
			const read = await store.read();
			if (read.ok) throw new Error("an unreadable body was accepted");
			expect(read.error.code).toBe("STORE_UNAVAILABLE");
			expect(read.error.message).toContain(API_ORIGIN);
		}
	});

	it("writes with Origin, the CSRF header and the expected version", async () => {
		const backend = recordingFetch((_url, init) => {
			const headers = new Headers(init.headers);
			expect(init.method).toBe("PUT");
			expect(headers.get("Origin")).toBe(API_ORIGIN);
			expect(headers.get("X-Research-Csrf")).toBe("1");
			expect(headers.get("Content-Type")).toContain("application/json");
			const body: unknown = JSON.parse(String(init.body));
			expect(body).toMatchObject({ expectedVersion: 4 });
			if (typeof body !== "object" || body === null || !("dashboard" in body)) {
				throw new Error("the PUT has no dashboard");
			}
			const dashboard: unknown = (body as { dashboard: unknown }).dashboard;
			expect(dashboard).toMatchObject({ schemaVersion: 1 });
			return jsonResponse(dashboardBody(5, (dashboard as { widgets: unknown[] }).widgets));
		});
		const store = createHomeDashboardStore({ apiOrigin: API_ORIGIN, fetch: backend.fetch });
		const widgets = [...DEFAULT_HOME_DASHBOARD.widgets];
		const written = await store.write(widgets, 4);
		if (!written.ok) throw new Error(JSON.stringify(written.error));
		expect(written.value.revision).toBe(5);
		expect(written.value.widgets).toHaveLength(7);
	});

	it("maps a version conflict to CONFLICT", async () => {
		const backend = recordingFetch(() =>
			jsonResponse(
				{
					error: {
						code: "VERSION_CONFLICT",
						message: "The dashboard changed; reload and try again.",
					},
				},
				409,
			),
		);
		const store = createHomeDashboardStore({ apiOrigin: API_ORIGIN, fetch: backend.fetch });
		const written = await store.write([...DEFAULT_HOME_DASHBOARD.widgets], 3);
		if (written.ok) throw new Error("a conflict was accepted");
		expect(written.error.code).toBe("CONFLICT");
	});

	it("maps a validation refusal to INVALID_WIDGET with the server message", async () => {
		const backend = recordingFetch(() =>
			jsonResponse(
				{ error: { code: "VALIDATION_FAILED", message: "widgets.0.title: Too short" } },
				400,
			),
		);
		const store = createHomeDashboardStore({ apiOrigin: API_ORIGIN, fetch: backend.fetch });
		const written = await store.write([...DEFAULT_HOME_DASHBOARD.widgets], 3);
		if (written.ok) throw new Error("a refusal was accepted");
		expect(written.error.code).toBe("INVALID_WIDGET");
		expect(written.error.message).toContain("widgets.0.title: Too short");
	});

	it("maps other statuses to STORE_UNAVAILABLE", async () => {
		const backend = recordingFetch(() =>
			jsonResponse({ error: { code: "INTERNAL", message: "Internal error." } }, 500),
		);
		const store = createHomeDashboardStore({ apiOrigin: API_ORIGIN, fetch: backend.fetch });
		const written = await store.write([...DEFAULT_HOME_DASHBOARD.widgets], 3);
		if (written.ok) throw new Error("a server error was accepted");
		expect(written.error.code).toBe("STORE_UNAVAILABLE");
		expect(written.error.message).toContain("500");
	});

	it("maps a network failure to STORE_UNAVAILABLE saying the workspace seems not to be running", async () => {
		const backend = recordingFetch(() => {
			throw new Error("connection refused (test fixture)");
		});
		const store = createHomeDashboardStore({ apiOrigin: API_ORIGIN, fetch: backend.fetch });
		const read = await store.read();
		if (read.ok) throw new Error("a network failure was accepted");
		expect(read.error.code).toBe("STORE_UNAVAILABLE");
		expect(read.error.message).toContain("seems not to be running");
	});

	it("maps a timeout to STORE_UNAVAILABLE", async () => {
		const hanging: HomeStoreFetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation timed out.", "TimeoutError"));
				});
			});
		const store = createHomeDashboardStore({
			apiOrigin: API_ORIGIN,
			fetch: hanging,
			timeoutMs: 20,
		});
		const read = await store.read();
		if (read.ok) throw new Error("a timeout was accepted");
		expect(read.error.code).toBe("STORE_UNAVAILABLE");
		expect(read.error.message).toContain("seems not to be running");
	});
});
