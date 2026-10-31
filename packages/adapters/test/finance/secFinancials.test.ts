import type { SafeFetcher } from "@research/application";
import { err, ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	NO_JP_MARGIN_BALANCE_SOURCE_REASON,
	NO_SHARE_PRICE_SOURCE_REASON,
	NO_US_SHORT_INTEREST_SOURCE_REASON,
	unconfiguredJpMarginBalanceSource,
	unconfiguredSharePriceSource,
	unconfiguredUsShortInterestSource,
} from "../../src/finance/marketData.ts";
import { createSecClient } from "../../src/finance/secClient.ts";
import {
	createSecFinancialsSource,
	createSecTickerDirectory,
	parseTickerDirectory,
	SEC_TICKER_DIRECTORY_URL,
	secCompanyFactsUrl,
	selectAnnualFinancials,
} from "../../src/finance/secFinancials.ts";
import {
	createScriptedFetcher,
	fixedClock,
	fixtureText,
	type ScriptedPage,
	SEC_USER_AGENT,
} from "../tools/support.ts";

const DIRECTORY = fixtureText("sec/company_tickers_exchange.synthetic.json");
const FACTS_ALPHA = fixtureText("sec/companyfacts-CIK0009999991.synthetic.json");
const FACTS_BETA = fixtureText("sec/companyfacts-CIK0009999992.synthetic.json");

const FACTS_ALPHA_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK0009999991.json";
const FACTS_BETA_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK0009999992.json";

function sourceWith(pages: Parameters<typeof createScriptedFetcher>[0], nowMs = () => 1_000) {
	const fetcher = createScriptedFetcher(pages);
	const client = createSecClient({
		fetcher,
		clock: fixedClock(),
		userAgent: SEC_USER_AGENT,
		sleep: async () => {},
	});
	return { fetcher, source: createSecFinancialsSource({ client, nowMs }) };
}

/** A minimal 10-K annual fact; the fiscal year runs 1 January to 31 December of `year`. */
function annual(year: number, val: number, extra: Record<string, unknown> = {}) {
	return {
		start: `${year}-01-01`,
		end: `${year}-12-31`,
		val,
		accn: `0009999999-${String(year + 1).slice(2)}-000001`,
		fy: year,
		fp: "FY",
		form: "10-K",
		filed: `${year + 1}-02-15`,
		...extra,
	};
}

function facts(usGaap: Record<string, unknown>) {
	return { cik: 1, entityName: "Synthetic", facts: { "us-gaap": usGaap } };
}

function usd(...entries: unknown[]) {
	return { label: "x", units: { USD: entries } };
}

describe("SEC financials: latest fiscal year from the synthetic issuer fixture", () => {
	it("resolves the ticker, requests exactly two SEC documents and returns same-period figures", async () => {
		const { fetcher, source } = sourceWith({
			[SEC_TICKER_DIRECTORY_URL]: { text: DIRECTORY },
			[FACTS_ALPHA_URL]: { text: FACTS_ALPHA },
		});
		const result = await source.latestAnnualFinancials("xtesta");
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(fetcher.urls()).toEqual([SEC_TICKER_DIRECTORY_URL, FACTS_ALPHA_URL]);
		expect(result.value.issuer).toEqual({
			cik: "0009999991",
			name: "Synthetic Alpha Devices Inc.",
			ticker: "XTESTA",
			secExchange: "Nasdaq",
		});
		expect(result.value.companyFactsUrl).toBe(FACTS_ALPHA_URL);

		// Expected values are read off the fixture by hand, not derived from the implementation.
		const fiscal2025 = {
			fiscalYear: 2025,
			fiscalPeriod: "FY",
			periodStart: "2024-07-01",
			periodEnd: "2025-06-30",
		};
		expect(result.value.revenue).toEqual({
			ok: true,
			value: {
				// `Revenues` (2,000,000,000) outranks the contract-revenue subset (1,900,000,000)
				// for the same period, and the stale 2017 `SalesRevenueNet` is ignored.
				concept: "us-gaap:Revenues",
				amount: 2_000_000_000,
				unit: "currency",
				currency: "USD",
				period: fiscal2025,
				filingFiscalYear: 2025,
				accountingStandard: "US-GAAP",
				form: "10-K",
				accessionNumber: "0009999991-25-000010",
				filedAt: "2025-08-20",
			},
		});
		expect(result.value.netIncome).toMatchObject({
			ok: true,
			value: { concept: "us-gaap:NetIncomeLoss", amount: 250_000_000, period: fiscal2025 },
		});
		expect(result.value.epsDiluted).toMatchObject({
			ok: true,
			value: {
				concept: "us-gaap:EarningsPerShareDiluted",
				amount: 2.5,
				unit: "currency-per-share",
				currency: "USD",
				period: fiscal2025,
			},
		});
		// 250,000,000 / 2,000,000,000 = 0.125 exactly.
		expect(result.value.netProfitMargin).toEqual({
			ok: true,
			value: {
				marginRatio: 0.125,
				formula: "net income / revenue",
				currency: "USD",
				period: fiscal2025,
				accountingStandard: "US-GAAP",
				continuingOperationsPolicy: "total",
			},
		});
	});

	it("returns both figures but no margin when their fiscal periods differ", async () => {
		const { source } = sourceWith({
			[SEC_TICKER_DIRECTORY_URL]: { text: DIRECTORY },
			[FACTS_BETA_URL]: { text: FACTS_BETA },
		});
		const result = await source.latestAnnualFinancials("XTESTB");
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(result.value.revenue).toMatchObject({
			ok: true,
			value: {
				concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
				amount: 500_000_000,
				period: { fiscalYear: 2025, periodStart: "2025-01-01", periodEnd: "2025-12-31" },
			},
		});
		expect(result.value.netIncome).toMatchObject({
			ok: true,
			value: {
				amount: 40_000_000,
				period: { fiscalYear: 2024, periodStart: "2024-01-01", periodEnd: "2024-12-31" },
			},
		});
		expect(result.value.netProfitMargin.ok).toBe(false);
		if (!result.value.netProfitMargin.ok) {
			const { reason } = result.value.netProfitMargin.error;
			expect(reason).toContain("not reported for the same fiscal period");
			expect(reason).toContain("FY2025 2025-01-01 to 2025-12-31");
			expect(reason).toContain("FY2024 2024-01-01 to 2024-12-31");
		}
		// 40/500 = 0.08 and 40/450 ≈ 0.0889 are the two ratios a period-mixing bug would produce.
		expect(JSON.stringify(result.value.netProfitMargin)).not.toMatch(/0\.08/);
		expect(result.value.epsDiluted).toMatchObject({ ok: false });
	});

	it("reports an unknown ticker without requesting company facts", async () => {
		const { fetcher, source } = sourceWith({ [SEC_TICKER_DIRECTORY_URL]: { text: DIRECTORY } });
		const result = await source.latestAnnualFinancials("NOSUCH");
		expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
		expect(fetcher.urls()).toEqual([SEC_TICKER_DIRECTORY_URL]);
	});

	it("accepts the dotted spelling of a share class", async () => {
		const { fetcher, source } = sourceWith({ [SEC_TICKER_DIRECTORY_URL]: { text: DIRECTORY } });
		await source.latestAnnualFinancials("xtst.b");
		expect(fetcher.urls()[1]).toBe(secCompanyFactsUrl("0009999997"));
	});

	it("caches the ticker directory, and refreshes it after its lifetime", async () => {
		let nowMs = 0;
		const { fetcher, source } = sourceWith(
			{ [SEC_TICKER_DIRECTORY_URL]: { text: DIRECTORY }, [FACTS_ALPHA_URL]: { text: FACTS_ALPHA } },
			() => nowMs,
		);
		await source.latestAnnualFinancials("XTESTA");
		nowMs += 60 * 60 * 1000;
		await source.latestAnnualFinancials("XTESTA");
		const directoryFetches = () =>
			fetcher.urls().filter((url) => url === SEC_TICKER_DIRECTORY_URL).length;
		expect(directoryFetches()).toBe(1);
		nowMs += 12 * 60 * 60 * 1000;
		await source.latestAnnualFinancials("XTESTA");
		expect(directoryFetches()).toBe(2);
	});

	it("downloads the ticker directory once for concurrent misses", async () => {
		const { fetcher, source } = sourceWith({
			[SEC_TICKER_DIRECTORY_URL]: { text: DIRECTORY },
			[FACTS_ALPHA_URL]: { text: FACTS_ALPHA },
			[FACTS_BETA_URL]: { text: FACTS_BETA },
		});
		const results = await Promise.all([
			source.latestAnnualFinancials("XTESTA"),
			source.latestAnnualFinancials("XTESTB"),
			source.latestAnnualFinancials("XTESTA"),
		]);
		expect(results.map((result) => result.ok)).toEqual([true, true, true]);
		expect(fetcher.urls().filter((url) => url === SEC_TICKER_DIRECTORY_URL)).toHaveLength(1);
	});

	/**
	 * A source whose directory requests stay pending until `answer` settles
	 * the oldest one; company facts answer at once.
	 */
	function heldDirectorySource() {
		const scripted = createScriptedFetcher({ [FACTS_ALPHA_URL]: { text: FACTS_ALPHA } });
		const held: {
			readonly signal: AbortSignal | undefined;
			readonly settle: (page: ScriptedPage) => void;
		}[] = [];
		const fetcher: SafeFetcher = {
			fetchText(url, options) {
				if (url !== SEC_TICKER_DIRECTORY_URL) return scripted.fetchText(url, options);
				return new Promise((resolve) => {
					held.push({
						signal: options.signal,
						settle: (page) =>
							resolve(
								"error" in page
									? err(page.error)
									: ok({ finalUrl: url, contentType: null, text: page.text }),
							),
					});
				});
			},
		};
		const source = createSecFinancialsSource({
			client: createSecClient({
				fetcher,
				clock: fixedClock(),
				userAgent: SEC_USER_AGENT,
				sleep: async () => {},
			}),
			nowMs: () => 1_000,
		});
		/** Lets the pending callers reach the fetcher. */
		const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
		return { source, held, settled };
	}

	it("shares one failed download with every concurrent caller; a later call downloads again", async () => {
		const { source, held, settled } = heldDirectorySource();
		const burst = Promise.all([
			source.latestAnnualFinancials("XTESTA"),
			source.latestAnnualFinancials("XTESTA"),
			source.latestAnnualFinancials("XTESTA"),
		]);
		await settled();
		expect(held).toHaveLength(1);
		held[0]?.settle({ error: { code: "HTTP_ERROR", detail: "HTTP 503", status: 503 } });
		for (const result of await burst) {
			expect(result).toMatchObject({ ok: false, error: { upstreamStatus: 503 } });
		}
		expect(held).toHaveLength(1);
		// The failure is not kept: an independent later call asks SEC again.
		const later = source.latestAnnualFinancials("XTESTA");
		await settled();
		expect(held).toHaveLength(2);
		held[1]?.settle({ text: DIRECTORY });
		expect((await later).ok).toBe(true);
	});

	it("lets an aborted waiter leave at once without cancelling the download the others need", async () => {
		const { source, held, settled } = heldDirectorySource();
		const stop = new AbortController();
		const staying = source.latestAnnualFinancials("XTESTA");
		const leaving = source.latestAnnualFinancials("XTESTA", stop.signal);
		await settled();
		expect(held).toHaveLength(1);
		stop.abort();
		// Answered while the download is still pending, like a cancelled SEC fetch.
		expect(await leaving).toMatchObject({ ok: false, error: { code: "FETCH_FAILED" } });
		expect(held[0]?.signal?.aborted).toBe(false);
		held[0]?.settle({ text: DIRECTORY });
		expect((await staying).ok).toBe(true);
		expect(held).toHaveLength(1);
	});

	it("cancels the download once its last waiter has left", async () => {
		const { source, held, settled } = heldDirectorySource();
		const stop = new AbortController();
		const only = source.latestAnnualFinancials("XTESTA", stop.signal);
		await settled();
		stop.abort();
		expect((await only).ok).toBe(false);
		expect(held[0]?.signal?.aborted).toBe(true);
		// A new caller does not join the abandoned download.
		const next = source.latestAnnualFinancials("XTESTA");
		await settled();
		expect(held).toHaveLength(2);
		held[1]?.settle({ text: DIRECTORY });
		expect((await next).ok).toBe(true);
	});

	it("propagates SEC failures as typed errors", async () => {
		const missingFacts = sourceWith({ [SEC_TICKER_DIRECTORY_URL]: { text: DIRECTORY } });
		expect(await missingFacts.source.latestAnnualFinancials("XTESTA")).toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND" },
		});
		const notJson = sourceWith({ [SEC_TICKER_DIRECTORY_URL]: { text: "<html>blocked</html>" } });
		expect(await notJson.source.latestAnnualFinancials("XTESTA")).toMatchObject({
			ok: false,
			error: { code: "UNEXPECTED_RESPONSE" },
		});
	});
});

describe("SEC financials: revenue concept precedence and annual-fact selection", () => {
	function revenueOf(usGaap: Record<string, unknown>) {
		const selected = selectAnnualFinancials(facts(usGaap));
		if (!selected.ok) throw new Error("unexpected shape failure");
		return selected.value.revenue;
	}

	it("uses the contract-revenue concept when it is the only one", () => {
		expect(
			revenueOf({ RevenueFromContractWithCustomerExcludingAssessedTax: usd(annual(2025, 700)) }),
		).toMatchObject({
			ok: true,
			value: {
				concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
				amount: 700,
			},
		});
	});

	it("prefers the concept with the latest period over an earlier-ranked stale one", () => {
		expect(
			revenueOf({
				Revenues: usd(annual(2017, 111)),
				SalesRevenueNet: usd(annual(2016, 99)),
				RevenueFromContractWithCustomerExcludingAssessedTax: usd(
					annual(2024, 600),
					annual(2025, 700),
				),
			}),
		).toMatchObject({
			ok: true,
			value: {
				concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
				amount: 700,
				period: { fiscalYear: 2025 },
			},
		});
	});

	it("breaks a same-period tie by the documented order", () => {
		const order = [
			"Revenues",
			"RevenueFromContractWithCustomerExcludingAssessedTax",
			"RevenueFromContractWithCustomerIncludingAssessedTax",
			"SalesRevenueNet",
		];
		for (let first = 0; first < order.length; first += 1) {
			const usGaap: Record<string, unknown> = {};
			// Insert in reverse so the result cannot depend on object key order.
			for (let index = order.length - 1; index >= first; index -= 1) {
				usGaap[order[index] ?? ""] = usd(annual(2025, 1000 + index));
			}
			expect(revenueOf(usGaap)).toMatchObject({
				ok: true,
				value: { concept: `us-gaap:${order[first]}`, amount: 1000 + first },
			});
		}
	});

	it("ignores quarterly, interim and non-10-K facts, even when tagged FY", () => {
		expect(
			revenueOf({
				Revenues: usd(
					annual(2024, 400),
					// A fourth quarter published inside the 10-K.
					annual(2025, 130, { start: "2025-10-01" }),
					annual(2025, 310, { fp: "Q3", form: "10-Q", end: "2025-09-30" }),
					annual(2025, 999, { form: "8-K" }),
					annual(2025, 998, { form: "20-F" }),
					annual(2025, 997, { fp: "Q4" }),
					// Eighteen months: a transition period, not a fiscal year.
					annual(2025, 996, { start: "2024-07-01" }),
					{
						end: "2025-12-31",
						val: 995,
						accn: "a",
						fy: 2025,
						fp: "FY",
						form: "10-K",
						filed: "2026-02-15",
					},
				),
			}),
		).toMatchObject({ ok: true, value: { amount: 400, period: { fiscalYear: 2024 } } });
	});

	it("accepts 52/53-week fiscal years", () => {
		const week52 = annual(2025, 52, { start: "2024-09-29", end: "2025-09-27" });
		const week53 = annual(2025, 53, { start: "2024-12-29", end: "2026-01-03", fy: 2025 });
		expect(revenueOf({ Revenues: usd(week52) })).toMatchObject({ ok: true, value: { amount: 52 } });
		expect(revenueOf({ Revenues: usd(week53) })).toMatchObject({ ok: true, value: { amount: 53 } });
	});

	it("uses the most recently filed statement of a period that was reported twice", () => {
		expect(
			revenueOf({
				Revenues: usd(
					annual(2025, 500),
					annual(2025, 480, { form: "10-K/A", filed: "2026-06-01", accn: "0009999999-26-000009" }),
				),
			}),
		).toMatchObject({
			ok: true,
			value: { amount: 480, form: "10-K/A", accessionNumber: "0009999999-26-000009" },
		});
	});

	it("takes the currency from the unit that holds the latest period", () => {
		expect(revenueOf({ Revenues: { units: { CAD: [annual(2025, 10)] } } })).toMatchObject({
			ok: true,
			value: { currency: "CAD" },
		});
		// USD is not preferred over a more recent period reported in another currency.
		expect(
			revenueOf({ Revenues: { units: { USD: [annual(2024, 7)], EUR: [annual(2025, 9)] } } }),
		).toMatchObject({
			ok: true,
			value: { currency: "EUR", amount: 9, period: { fiscalYear: 2025 } },
		});
		expect(
			revenueOf({ Revenues: { units: { EUR: [annual(2023, 9)], USD: [annual(2025, 7)] } } }),
		).toMatchObject({ ok: true, value: { currency: "USD", amount: 7 } });
		expect(revenueOf({ Revenues: { units: { shares: [annual(2025, 10)] } } })).toMatchObject({
			ok: false,
		});
	});

	it("does not choose between two currencies reported for the same latest period", () => {
		for (const units of [
			{ CAD: [annual(2025, 10)], USD: [annual(2025, 7)] },
			{ USD: [annual(2025, 7)], EUR: [annual(2025, 9)], JPY: [annual(2024, 1000)] },
		]) {
			const revenue = revenueOf({ Revenues: { units } });
			expect(revenue.ok).toBe(false);
			if (!revenue.ok) {
				expect(revenue.error.reason).toContain("more than one currency");
				expect(revenue.error.reason).toContain("2025-12-31");
			}
		}
		// An ambiguous top-ranked concept is not silently replaced by a lower-ranked one.
		const selected = selectAnnualFinancials(
			facts({
				Revenues: { units: { CAD: [annual(2025, 10)], USD: [annual(2025, 7)] } },
				SalesRevenueNet: usd(annual(2025, 5)),
				NetIncomeLoss: usd(annual(2025, 1)),
			}),
		);
		expect(selected).toMatchObject({
			ok: true,
			value: { revenue: { ok: false }, netProfitMargin: { ok: false } },
		});
	});

	it("uses the current reporting currency for an issuer that changed currency (finding 15)", () => {
		const selected = selectAnnualFinancials(
			facts({
				Revenues: { units: { USD: [annual(2024, 900)], EUR: [annual(2025, 1000)] } },
				NetIncomeLoss: { units: { USD: [annual(2024, 90)], EUR: [annual(2025, 150)] } },
			}),
		);
		// 150 / 1000, both EUR, both calendar 2025.
		expect(selected).toMatchObject({
			ok: true,
			value: {
				revenue: { ok: true, value: { amount: 1000, currency: "EUR" } },
				netIncome: { ok: true, value: { amount: 150, currency: "EUR" } },
				netProfitMargin: { ok: true, value: { marginRatio: 0.15, currency: "EUR" } },
			},
		});
	});

	it("matches figures by their own period, not by the fiscal year of the filing (finding 14)", () => {
		const selected = selectAnnualFinancials(
			facts({
				// Calendar-2024 revenue as restated in the comparative column of the FY2025 10-K:
				// SEC tags it with that filing's fiscal year, 2025.
				Revenues: usd(
					annual(2024, 100, { fy: 2025, filed: "2026-02-15", accn: "0009999999-26-000001" }),
				),
				// Calendar-2024 net income from the FY2024 10-K (fy 2024).
				NetIncomeLoss: usd(annual(2024, 20)),
			}),
		);
		const calendar2024 = {
			fiscalYear: 2024,
			fiscalPeriod: "FY",
			periodStart: "2024-01-01",
			periodEnd: "2024-12-31",
		};
		// 20 / 100 for the identical period.
		expect(selected).toMatchObject({
			ok: true,
			value: {
				revenue: { ok: true, value: { period: calendar2024, filingFiscalYear: 2025 } },
				netIncome: { ok: true, value: { period: calendar2024, filingFiscalYear: 2024 } },
				netProfitMargin: { ok: true, value: { marginRatio: 0.2, period: calendar2024 } },
			},
		});
	});

	it("labels the fiscal year by the year the period ends, and still selects a fact without `fy`", () => {
		const revenue = revenueOf({
			Revenues: usd(
				annual(2025, 53, { start: "2025-02-02", end: "2026-01-31", fy: 2025 }),
				annual(2023, 40, { fy: null }),
			),
		});
		expect(revenue).toMatchObject({
			ok: true,
			value: {
				amount: 53,
				period: { fiscalYear: 2026, periodStart: "2025-02-02", periodEnd: "2026-01-31" },
				filingFiscalYear: 2025,
			},
		});
		expect(revenueOf({ Revenues: usd(annual(2023, 40, { fy: null })) })).toMatchObject({
			ok: true,
			value: { amount: 40, period: { fiscalYear: 2023 }, filingFiscalYear: null },
		});
	});

	it("refuses a margin across currencies or with non-positive revenue", () => {
		const mixed = selectAnnualFinancials(
			facts({
				Revenues: { units: { CAD: [annual(2025, 1000)] } },
				NetIncomeLoss: usd(annual(2025, 100)),
			}),
		);
		expect(mixed).toMatchObject({ ok: true, value: { netProfitMargin: { ok: false } } });
		const zeroRevenue = selectAnnualFinancials(
			facts({ Revenues: usd(annual(2025, 0)), NetIncomeLoss: usd(annual(2025, -5)) }),
		);
		expect(zeroRevenue).toMatchObject({ ok: true, value: { netProfitMargin: { ok: false } } });
	});

	it("reports a net loss as a negative margin, computed for the matching period", () => {
		const selected = selectAnnualFinancials(
			facts({ Revenues: usd(annual(2025, 800)), NetIncomeLoss: usd(annual(2025, -200)) }),
		);
		// -200 / 800 = -0.25
		expect(selected).toMatchObject({
			ok: true,
			value: { netProfitMargin: { ok: true, value: { marginRatio: -0.25 } } },
		});
	});

	it("marks everything unavailable for an issuer without us-gaap facts", () => {
		const selected = selectAnnualFinancials({
			facts: { "ifrs-full": { Revenue: usd(annual(2025, 1)) } },
		});
		expect(selected).toMatchObject({
			ok: true,
			value: {
				revenue: { ok: false },
				netIncome: { ok: false },
				epsDiluted: { ok: false },
				netProfitMargin: { ok: false },
			},
		});
	});

	it("rejects a document that is not company facts at all", () => {
		for (const value of [null, [], "text", { facts: "nope" }, { entityName: "x" }]) {
			expect(selectAnnualFinancials(value)).toMatchObject({
				ok: false,
				error: { code: "UNEXPECTED_RESPONSE" },
			});
		}
	});
});

describe("SEC ticker directory", () => {
	it("locates columns by name, so a reordered file cannot swap fields", () => {
		const parsed = parseTickerDirectory({
			fields: ["exchange", "ticker", "cik", "name"],
			data: [["NYSE", "xtestb", 9999992, " Synthetic Beta Logistics Corp "]],
		});
		expect(parsed.ok && parsed.value.get("XTESTB")).toEqual({
			cik: "0009999992",
			name: "Synthetic Beta Logistics Corp",
			ticker: "XTESTB",
			secExchange: "NYSE",
		});
	});

	it("keeps a missing exchange as null and skips unusable rows", () => {
		const parsed = parseTickerDirectory(JSON.parse(DIRECTORY));
		expect(parsed.ok && parsed.value.get("XTESTD")?.secExchange).toBeNull();
		const messy = parseTickerDirectory({
			fields: ["cik", "name", "ticker", "exchange"],
			data: [
				["not-a-number", "A", "AAA", "NYSE"],
				[5, "B", "", "NYSE"],
				[-1, "C", "CCC", "NYSE"],
				[7, "D", "DDD", ""],
			],
		});
		expect(messy.ok && [...messy.value.keys()]).toEqual(["DDD"]);
		expect(messy.ok && messy.value.get("DDD")?.secExchange).toBeNull();
	});

	it("rejects a file without the expected columns", () => {
		for (const value of [
			{},
			{ fields: ["cik", "ticker"], data: [] },
			{ fields: ["cik", "name", "ticker", "exchange"], data: [] },
		]) {
			expect(parseTickerDirectory(value)).toMatchObject({
				ok: false,
				error: { code: "UNEXPECTED_RESPONSE" },
			});
		}
	});

	/** A directory whose downloads stay pending until settled, oldest first. */
	function heldDirectory() {
		const held: { readonly settle: (text: string) => void }[] = [];
		const fetcher: SafeFetcher = {
			fetchText(url) {
				return new Promise((resolve) => {
					held.push({
						settle: (text) => resolve(ok({ finalUrl: url, contentType: null, text })),
					});
				});
			},
		};
		const directory = createSecTickerDirectory({
			client: createSecClient({
				fetcher,
				clock: fixedClock(),
				userAgent: SEC_USER_AGENT,
				sleep: async () => {},
			}),
			nowMs: () => 1_000,
		});
		const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
		return { directory, held, settled };
	}

	/** A pacing gate that answers `answer` and counts how often it was asked. */
	function gate(answer: () => Promise<boolean>) {
		const asked = { count: 0 };
		return {
			asked,
			beforeRequest: async () => {
				asked.count += 1;
				return answer();
			},
		};
	}

	it("asks only the pacing gate of the caller that starts the download", async () => {
		const { directory, held, settled } = heldDirectory();
		const first = gate(async () => true);
		const joiner = gate(async () => true);
		const a = directory.lookup("XTESTA", { beforeRequest: first.beforeRequest });
		const b = directory.lookup("XTESTB", { beforeRequest: joiner.beforeRequest });
		await settled();
		expect(held).toHaveLength(1);
		held[0]?.settle(DIRECTORY);
		expect((await a).ok && (await b).ok).toBe(true);
		expect([first.asked.count, joiner.asked.count]).toEqual([1, 0]);
		// A cached answer asks no gate at all.
		const cachedGate = gate(async () => true);
		expect((await directory.lookup("XTESTA", cachedGate)).ok).toBe(true);
		expect(cachedGate.asked.count).toBe(0);
	});

	it("keeps a starter's refusal its own: a joiner downloads through its own gate", async () => {
		const { directory, held, settled } = heldDirectory();
		let refuse = (_: boolean): void => {};
		const refusing = gate(() => new Promise<boolean>((resolve) => (refuse = resolve)));
		const joiner = gate(async () => true);
		const stopped = directory.lookup("XTESTA", { beforeRequest: refusing.beforeRequest });
		const staying = directory.lookup("XTESTA", { beforeRequest: joiner.beforeRequest });
		await settled();
		expect(held).toHaveLength(0);
		refuse(false);
		expect(await stopped).toMatchObject({ ok: false, error: { code: "FETCH_FAILED" } });
		await settled();
		expect(held).toHaveLength(1);
		expect(joiner.asked.count).toBe(1);
		held[0]?.settle(DIRECTORY);
		const found = await staying;
		expect(found.ok && found.value.issuer?.cik).toBe("0009999991");
	});

	it("sends nothing when the only caller leaves while its gate is deciding", async () => {
		const { directory, held, settled } = heldDirectory();
		let admit = (_: boolean): void => {};
		const slow = gate(() => new Promise<boolean>((resolve) => (admit = resolve)));
		const stop = new AbortController();
		const leaving = directory.lookup("XTESTA", {
			signal: stop.signal,
			beforeRequest: slow.beforeRequest,
		});
		await settled();
		stop.abort();
		expect((await leaving).ok).toBe(false);
		admit(true);
		await settled();
		expect(held).toHaveLength(0);
	});
});

describe("market data without a configured source", () => {
	it("reports share prices, US short interest and JP margin balances as unavailable with a reason", async () => {
		const results = [
			[
				await unconfiguredSharePriceSource.latestQuote({
					securityId: "sec_1",
					ticker: "XTESTA",
					exchange: "NASDAQ",
				}),
				NO_SHARE_PRICE_SOURCE_REASON,
			],
			[
				await unconfiguredUsShortInterestSource.latestShortInterest({ ticker: "XTESTA" }),
				NO_US_SHORT_INTEREST_SOURCE_REASON,
			],
			[
				await unconfiguredJpMarginBalanceSource.latestMarginBalance({ code: "7203" }),
				NO_JP_MARGIN_BALANCE_SOURCE_REASON,
			],
		] as const;
		for (const [result, reason] of results) {
			expect(result).toEqual({ ok: false, error: { code: "SOURCE_NOT_CONFIGURED", reason } });
			// Must fit the contract's `unavailableReason` field unshortened.
			expect(reason.length).toBeGreaterThan(20);
			expect(reason.length).toBeLessThanOrEqual(300);
		}
	});
});
