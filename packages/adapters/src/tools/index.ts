/**
 * The research tool catalogue (`@research/adapters/tools`). Tools are plain
 * `ToolDefinition`s: the orchestrator authorizes calls against its own
 * allowlist and budget before any of this code runs (AGT-006), and each tool
 * additionally pins the hosts it may reach when it calls the fetcher.
 */
import type { ToolDefinition } from "@research/agent-core";
import type { Clock, FeedParser, Hasher, PageArchive, SafeFetcher } from "@research/application";
import {
	unconfiguredJpMarginBalanceSource,
	unconfiguredSharePriceSource,
	unconfiguredUsShortInterestSource,
} from "../finance/marketData.ts";
import { createSec13FSource } from "../finance/sec13f.ts";
import { createSecClient } from "../finance/secClient.ts";
import { createSecFinancialsSource } from "../finance/secFinancials.ts";
import { createNewsTools } from "./newsTools.ts";
import { createPositionTools } from "./positionTools.ts";
import { createSecTools } from "./secTools.ts";
import { createWebTools } from "./webTools.ts";

export interface ResearchToolDeps {
	fetcher: SafeFetcher;
	feedParser: FeedParser;
	hasher: Hasher;
	clock: Clock;
	/** SEC requires a descriptive User-Agent with contact info; null → SEC tools report NOT_CONFIGURED. */
	secUserAgent: string | null;
	/**
	 * Where retrieved public pages are archived. Null → the web tool is not
	 * registered at all: without an archive there is nowhere to keep the page
	 * (DATA-010), so the tool must not run.
	 */
	pageArchive: PageArchive | null;
	/** Wait that ends early when the run is aborted (politeness between page requests). */
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function createResearchTools(deps: ResearchToolDeps): readonly ToolDefinition[] {
	// One client for both SEC tools, so they share a single request-rate budget.
	const secClient = createSecClient({
		fetcher: deps.fetcher,
		clock: deps.clock,
		userAgent: deps.secUserAgent,
	});
	return [
		...createNewsTools(deps),
		...createSecTools({
			financials: createSecFinancialsSource({
				client: secClient,
				nowMs: () => deps.clock.nowMs(),
			}),
			filings: createSec13FSource({ client: secClient }),
			// No licensed market-data source exists in V1; these report "unavailable" with a reason.
			sharePrice: unconfiguredSharePriceSource,
			hasher: deps.hasher,
		}),
		...createPositionTools({
			usShortInterest: unconfiguredUsShortInterestSource,
			jpMarginBalance: unconfiguredJpMarginBalanceSource,
			hasher: deps.hasher,
		}),
		...(deps.pageArchive === null
			? []
			: createWebTools({
					fetcher: deps.fetcher,
					hasher: deps.hasher,
					clock: deps.clock,
					pageArchive: deps.pageArchive,
					sleep: deps.sleep,
				})),
	];
}
