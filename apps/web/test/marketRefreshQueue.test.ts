import type { RefreshScope, ResearchRun } from "@research/contracts";
import { describe, expect, it } from "vitest";
import type { ApiFailure } from "../src/api/http.ts";
import { createMarketRefreshQueue } from "../src/home/marketData.ts";
import { makeRun } from "./fixtures.ts";

type RefreshResult =
	| { readonly ok: true; readonly value: ResearchRun }
	| { readonly ok: false; readonly error: ApiFailure };

const NETWORK_FAILURE: ApiFailure = {
	kind: "network",
	code: "TIMEOUT",
	status: null,
	message: "the runner did not answer",
	detail: null,
	issues: [],
};

/** The shared market queue (Home and the Notebook) carries the scope to the API (ADR-0039). */
describe("createMarketRefreshQueue scope", () => {
	it("sends the scope, and never reuses a kept key for the other scope", async () => {
		let keys = 0;
		const sent: { readonly key: string; readonly scope: RefreshScope }[] = [];
		let answer: RefreshResult = { ok: false, error: NETWORK_FAILURE };
		const queue = createMarketRefreshQueue({
			newIdempotencyKey: () => {
				keys += 1;
				return `idem-${keys}`;
			},
			refreshMarket: async (key, scope) => {
				sent.push({ key, scope });
				return answer;
			},
		});
		expect((await queue.queue("unrefreshed")).kind).toBe("failed");
		// The same write again after a network failure keeps its key.
		expect((await queue.queue("unrefreshed")).kind).toBe("failed");
		answer = {
			ok: true,
			value: makeRun({ runId: "run_market_1", kind: "market-refresh", state: "pending" }),
		};
		expect((await queue.queue("all")).kind).toBe("queued");
		expect(sent).toEqual([
			{ key: "idem-1", scope: "unrefreshed" },
			{ key: "idem-1", scope: "unrefreshed" },
			{ key: "idem-2", scope: "all" },
		]);
	});
});
