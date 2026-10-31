import { describe, expect, it } from "vitest";
import type { ApiFailure, ApiResult, Conditional } from "../src/api/http.ts";
import { createReadEntry } from "../src/lib/readCache.ts";
import { ALWAYS_VISIBLE } from "./fakeBackend.ts";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const FAILURE: ApiFailure = {
	kind: "network",
	code: "NETWORK_ERROR",
	status: null,
	message: "offline",
	detail: null,
	issues: [],
};

/** A reader that answers from a script and records the ETag each read sent. */
function scriptedReader(answers: ApiResult<Conditional<string>>[]) {
	const sent: (string | null)[] = [];
	return {
		sent,
		read: async (etag: string | null): Promise<ApiResult<Conditional<string>>> => {
			sent.push(etag);
			const next = answers.shift();
			if (next === undefined) throw new Error("no scripted answer left");
			return next;
		},
	};
}

describe("createReadEntry freshness (ADR-0049 §3 rule 3)", () => {
	it("shows a kept answer without a request inside the window, re-checks after it", async () => {
		let now = 1_000_000;
		const reader = scriptedReader([
			{ ok: true, value: { changed: true, value: "v1", etag: '"e1"' } },
			{ ok: true, value: { changed: false } },
		]);
		const entry = createReadEntry(reader.read, {
			recheckMs: 300_000,
			freshMs: 60_000,
			now: () => now,
		});
		entry.attach(ALWAYS_VISIBLE)();
		await settle();
		now += 59_999;
		entry.attach(ALWAYS_VISIBLE)();
		await settle();
		expect(reader.sent).toEqual([null]);
		now += 1;
		const release = entry.attach(ALWAYS_VISIBLE);
		await settle();
		expect(reader.sent).toEqual([null, '"e1"']);
		expect(entry.value()).toBe("v1");
		release();
	});

	it("never treats a failed read as fresh: the next showing retries", async () => {
		const now = 1_000_000;
		const reader = scriptedReader([
			{ ok: true, value: { changed: true, value: "v1", etag: '"e1"' } },
			{ ok: false, error: FAILURE },
			{ ok: true, value: { changed: false } },
		]);
		const entry = createReadEntry(reader.read, {
			recheckMs: 300_000,
			freshMs: 60_000,
			now: () => now,
		});
		entry.attach(ALWAYS_VISIBLE)();
		await settle();
		entry.refresh();
		await settle();
		expect(entry.failure()).toEqual(FAILURE);
		const release = entry.attach(ALWAYS_VISIBLE);
		await settle();
		expect(reader.sent).toHaveLength(3);
		expect(entry.failure()).toBeNull();
		expect(entry.value()).toBe("v1");
		release();
	});

	it("re-checks at once after invalidate, inside the window", async () => {
		const now = 1_000_000;
		const reader = scriptedReader([
			{ ok: true, value: { changed: true, value: "v1", etag: '"e1"' } },
			{ ok: true, value: { changed: true, value: "v2", etag: '"e2"' } },
		]);
		const entry = createReadEntry(reader.read, {
			recheckMs: 300_000,
			freshMs: 60_000,
			now: () => now,
		});
		entry.attach(ALWAYS_VISIBLE)();
		await settle();
		entry.invalidate();
		expect(reader.sent).toHaveLength(1);
		const release = entry.attach(ALWAYS_VISIBLE);
		await settle();
		expect(entry.value()).toBe("v2");
		release();
	});
});
