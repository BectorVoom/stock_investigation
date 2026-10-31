/**
 * The examples in docs/external-apis/apis/finnhub.md, fed through the Finnhub
 * adapter the TypeScript runner uses (conventions §4): each documented body is
 * served by the scripted fetcher at the exact URL the adapter builds.
 */
import { describe, expect, it } from "vitest";
import { createFinnhubEarningsSource } from "../../src/finance/finnhubEarnings.ts";
import { docExampleText } from "../docExamples.ts";
import { createScriptedFetcher, type ScriptedPage } from "../tools/support.ts";

const API_KEY = "finnhub-doc-example-key";
const NEVER = new AbortController().signal;
const FROM = "2026-10-31";
const TO = "2027-05-04";

const profileUrl = (symbol: string) => `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}`;
const calendarUrl = (symbol: string) =>
	`https://finnhub.io/api/v1/calendar/earnings?from=${FROM}&to=${TO}&symbol=${symbol}`;

async function fetchOne(
	pages: { readonly [url: string]: ScriptedPage },
	symbol: string,
	needName: boolean,
) {
	const source = createFinnhubEarningsSource({
		apiKey: API_KEY,
		fetcher: createScriptedFetcher(pages),
	});
	const [result] = await source.fetchEarnings({
		stocks: [{ symbol, needName }],
		fromDate: FROM,
		toDate: TO,
		signal: NEVER,
		beforeRequest: () => Promise.resolve(true),
	});
	if (result === undefined) throw new Error("expected one result");
	return result;
}

describe("Finnhub document examples", () => {
	it("parses the AAPL profile and calendar into dated events, oldest first", async () => {
		const result = await fetchOne(
			{
				[profileUrl("AAPL")]: { text: docExampleText("finnhub", "finnhub-profile2-aapl") },
				[calendarUrl("AAPL")]: { text: docExampleText("finnhub", "finnhub-calendar-aapl") },
			},
			"AAPL",
			true,
		);
		if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
		expect(result.value.name).toBe("Apple Inc.");
		expect(result.value.events).toEqual([
			{
				periodKey: "2026-q4",
				announcementDate: "2026-11-02",
				fiscalPeriodLabel: "Q4 2026",
				fiscalPeriodEnd: null,
				timing: "after-close",
			},
			{
				periodKey: "2027-q1",
				announcementDate: "2027-01-27",
				fiscalPeriodLabel: "Q1 2027",
				fiscalPeriodEnd: null,
				timing: "unknown",
			},
			{
				periodKey: "2027-q2",
				announcementDate: "2027-04-28",
				fiscalPeriodLabel: "Q2 2027",
				fiscalPeriodEnd: null,
				timing: "unknown",
			},
		]);
	});

	it("reports the empty profile as SYMBOL_NOT_FOUND", async () => {
		const result = await fetchOne(
			{ [profileUrl("ZZZZQ")]: { text: docExampleText("finnhub", "finnhub-profile2-unknown") } },
			"ZZZZQ",
			true,
		);
		expect(result).toEqual({
			ok: false,
			error: { code: "SYMBOL_NOT_FOUND", upstreamStatus: null },
		});
	});

	it("reports the empty calendar as NO_SCHEDULED_DATE", async () => {
		const result = await fetchOne(
			{ [calendarUrl("ZZZZQ")]: { text: docExampleText("finnhub", "finnhub-calendar-empty") } },
			"ZZZZQ",
			false,
		);
		expect(result).toEqual({ ok: false, error: { code: "NO_SCHEDULED_DATE", name: null } });
	});

	it("maps the documented 401 to SOURCE_AUTH_FAILED, keeping the status", async () => {
		const result = await fetchOne(
			{
				[calendarUrl("AAPL")]: {
					error: { code: "HTTP_ERROR", detail: "HTTP 401", status: 401 },
				},
			},
			"AAPL",
			false,
		);
		expect(result).toEqual({
			ok: false,
			error: { code: "SOURCE_AUTH_FAILED", upstreamStatus: 401 },
		});
	});
});
