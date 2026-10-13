import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createFreeModelCatalog,
	FREE_MODEL_MAX_BODY_BYTES,
	OPENROUTER_MODELS_URL,
	parseFreeModelIds,
} from "../../src/providers/openRouterModels.ts";
import { BASE_ENV, makeEnvironment } from "./helpers.ts";

function fixtureJson(): unknown {
	const text = readFileSync(new URL("./fixtures/openrouter/models.json", import.meta.url), "utf8");
	const parsed: unknown = JSON.parse(text);
	return parsed;
}

const EXPECTED_FIXTURE_IDS = [
	"google/gemma-4-26b-a4b-it:free",
	"google/gemma-4-31b-it:free",
	"nvidia/nemotron-3-super-120b-a12b:free",
	"openrouter/free",
	"thinkingmachines/inkling:free",
];

interface RecordedCall {
	readonly url: string;
	readonly init: RequestInit;
	readonly headers: Headers;
}

function recordingFetch(respond: () => Response | Promise<Response>): {
	fetch: typeof fetch;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const fake: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init: init ?? {}, headers: new Headers(init?.headers) });
		return respond();
	};
	return { fetch: fake, calls };
}

function jsonResponse(json: unknown, status = 200): Response {
	return new Response(JSON.stringify(json), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("parseFreeModelIds", () => {
	it("returns exactly the free text ids from the live-captured fixture", () => {
		expect(parseFreeModelIds(fixtureJson())).toEqual(EXPECTED_FIXTURE_IDS);
	});

	it("returns [] for a wrong envelope", () => {
		expect(parseFreeModelIds(null)).toEqual([]);
		expect(parseFreeModelIds({})).toEqual([]);
		expect(parseFreeModelIds({ data: "nope" })).toEqual([]);
		expect(parseFreeModelIds({ data: null })).toEqual([]);
	});

	it("skips entries with a missing, non-zero or unparseable price", () => {
		const json = {
			data: [
				{ id: "a/missing:free", architecture: { output_modalities: ["text"] } },
				{
					id: "a/nonzero:free",
					pricing: { prompt: "0", completion: "0.001" },
					architecture: { output_modalities: ["text"] },
				},
				{
					id: "a/unparseable:free",
					pricing: { prompt: "free", completion: "0" },
					architecture: { output_modalities: ["text"] },
				},
				{
					id: "a/ok:free",
					pricing: { prompt: "0", completion: "0.00" },
					architecture: { output_modalities: ["text"] },
				},
				{
					id: "a/numeric:free",
					pricing: { prompt: 0, completion: 0 },
					architecture: { output_modalities: ["text"] },
				},
			],
		};
		expect(parseFreeModelIds(json)).toEqual(["a/numeric:free", "a/ok:free"]);
	});

	it("excludes a zero-priced id without a :free suffix and non-text output", () => {
		const json = {
			data: [
				{ id: "plain/model", pricing: { prompt: "0", completion: "0" } },
				{
					id: "audio/only:free",
					pricing: { prompt: "0", completion: "0" },
					architecture: { output_modalities: ["audio"] },
				},
				{
					id: "kept/model:free",
					pricing: { prompt: "0", completion: "0" },
					architecture: { output_modalities: ["text", "audio"] },
				},
				{
					id: "noarch/model:free",
					pricing: { prompt: "0", completion: "0" },
				},
			],
		};
		expect(parseFreeModelIds(json)).toEqual(["kept/model:free", "noarch/model:free"]);
	});

	it("ignores one odd entry without hiding the rest", () => {
		const json = {
			data: [
				"not-an-object",
				{ id: 42 },
				{
					id: "good/model:free",
					pricing: { prompt: "0", completion: "0" },
				},
			],
		};
		expect(parseFreeModelIds(json)).toEqual(["good/model:free"]);
	});

	it("de-duplicates, sorts ascending and caps at 300 ids", () => {
		const ids = Array.from({ length: 350 }, (_, index) => `z/model-${index}:free`);
		const json = {
			data: [
				...ids.map((id) => ({ id, pricing: { prompt: "0", completion: "0" } })),
				{ id: "a/first:free", pricing: { prompt: "0", completion: "0" } },
				{ id: "a/first:free", pricing: { prompt: "0", completion: "0" } },
			],
		};
		const result = parseFreeModelIds(json);
		expect(result).toHaveLength(300);
		expect(result).toEqual([...result].sort());
		expect(new Set(result).size).toBe(result.length);
	});
});

describe("free model catalog", () => {
	it("fetches once within the TTL and refetches after it", async () => {
		let now = 1_000;
		const fake = recordingFetch(() =>
			jsonResponse({
				data: [{ id: "a/model:free", pricing: { prompt: "0", completion: "0" } }],
			}),
		);
		const catalog = createFreeModelCatalog(makeEnvironment({ fetch: fake.fetch, env: BASE_ENV }), {
			nowMs: () => now,
		});

		expect(await catalog.list()).toEqual(["a/model:free"]);
		expect(await catalog.list()).toEqual(["a/model:free"]);
		expect(fake.calls).toHaveLength(1);

		now += 10 * 60 * 1_000 + 1;
		expect(await catalog.list()).toEqual(["a/model:free"]);
		expect(fake.calls).toHaveLength(2);
	});

	it("shares one in-flight request between concurrent calls", async () => {
		let resolveFetch: (response: Response) => void = () => undefined;
		const pending = new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		const fake = recordingFetch(() => pending);
		const catalog = createFreeModelCatalog(makeEnvironment({ fetch: fake.fetch, env: BASE_ENV }));

		const first = catalog.list();
		const second = catalog.list();
		resolveFetch(
			jsonResponse({
				data: [{ id: "a/model:free", pricing: { prompt: "0", completion: "0" } }],
			}),
		);
		expect(await first).toEqual(["a/model:free"]);
		expect(await second).toEqual(["a/model:free"]);
		expect(fake.calls).toHaveLength(1);
	});

	it("returns null on the first failure and the stale list afterwards, without retrying for 60 s", async () => {
		let now = 5_000;
		let mode: "ok" | "fail" = "fail";
		const fake = recordingFetch(() =>
			mode === "ok"
				? jsonResponse({
						data: [{ id: "a/model:free", pricing: { prompt: "0", completion: "0" } }],
					})
				: new Response("{}", { status: 500 }),
		);
		const catalog = createFreeModelCatalog(makeEnvironment({ fetch: fake.fetch, env: BASE_ENV }), {
			nowMs: () => now,
		});

		expect(await catalog.list()).toBeNull();
		expect(fake.calls).toHaveLength(1);

		// Inside the retry window the failure is not retried.
		expect(await catalog.list()).toBeNull();
		expect(fake.calls).toHaveLength(1);

		now += 60_001;
		mode = "ok";
		expect(await catalog.list()).toEqual(["a/model:free"]);
		expect(fake.calls).toHaveLength(2);

		// A later failure returns the stale list and suppresses retries.
		mode = "fail";
		now += 10 * 60 * 1_000 + 1;
		expect(await catalog.list()).toEqual(["a/model:free"]);
		expect(fake.calls).toHaveLength(3);
		now += 1_000;
		expect(await catalog.list()).toEqual(["a/model:free"]);
		expect(fake.calls).toHaveLength(3);
	});

	it("treats invalid JSON and an empty parsed list as failures", async () => {
		const invalid = recordingFetch(() => new Response("not json", { status: 200 }));
		expect(
			await createFreeModelCatalog(makeEnvironment({ fetch: invalid.fetch, env: BASE_ENV })).list(),
		).toBeNull();

		const empty = recordingFetch(() => jsonResponse({ data: [] }));
		expect(
			await createFreeModelCatalog(makeEnvironment({ fetch: empty.fetch, env: BASE_ENV })).list(),
		).toBeNull();
	});

	it("treats a missing body and an oversized body as failures", async () => {
		const missing = recordingFetch(() => new Response(null, { status: 200 }));
		expect(
			await createFreeModelCatalog(makeEnvironment({ fetch: missing.fetch, env: BASE_ENV })).list(),
		).toBeNull();

		const big = `${"x".repeat(FREE_MODEL_MAX_BODY_BYTES + 1)}`;
		const oversized = recordingFetch(() => new Response(big, { status: 200 }));
		expect(
			await createFreeModelCatalog(
				makeEnvironment({ fetch: oversized.fetch, env: BASE_ENV }),
			).list(),
		).toBeNull();
	});

	it("sends no Authorization header and refuses redirects", async () => {
		const fake = recordingFetch(() =>
			jsonResponse({
				data: [{ id: "a/model:free", pricing: { prompt: "0", completion: "0" } }],
			}),
		);
		const catalog = createFreeModelCatalog(makeEnvironment({ fetch: fake.fetch, env: BASE_ENV }));

		expect(await catalog.list()).toEqual(["a/model:free"]);
		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call?.url).toBe(OPENROUTER_MODELS_URL);
		expect(call?.init.method).toBe("GET");
		expect(call?.init.redirect).toBe("error");
		expect(call?.headers.get("Authorization")).toBeNull();
		expect(call?.headers.get("Accept")).toBe("application/json");
	});

	it("never rejects, even when fetch throws", async () => {
		const throwing: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
		const catalog = createFreeModelCatalog(makeEnvironment({ fetch: throwing, env: BASE_ENV }));
		await expect(catalog.list()).resolves.toBeNull();
	});
});
