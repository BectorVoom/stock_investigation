/**
 * The shared EDINET index (ADR-0058 §4): the day-row mapping and the
 * `edinet-index` source over the synthetic lists in examples/fixtures/equity-sync/.
 */
import { EDINET_INDEX_LIMITS, edinetIndexDocumentSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { type EdinetAnnualRow, edinetDocumentListUrl } from "../../src/finance/edinetDocuments.ts";
import {
	createEdinetIndexSource,
	EDINET_LIST_MAX_BYTES,
	edinetIndexDay,
	edinetIndexDocument,
} from "../../src/finance/edinetIndex.ts";
import { equityFixtureText, type FakeAnswer, fakeFetcher, httpError } from "./equitySyncSupport.ts";
import { expectErr, expectOk } from "./support.ts";

const KEY = "test-edinet-key-0001";
const DATES = ["2025-07-01", "2025-06-20", "2024-09-10", "2020-06-26"];

const row = (fields: Partial<EdinetAnnualRow> = {}): EdinetAnnualRow => ({
	docId: "S100AAAA",
	edinetCode: "E99991",
	secCode: "99990",
	filerName: "名",
	docTypeCode: "120",
	periodStart: "2024-04-01",
	periodEnd: "2025-03-31",
	submitDateTime: "2025-06-20 15:00",
	parentDocId: null,
	csvAvailable: true,
	...fields,
});

const listOf = (rows: readonly unknown[]): unknown => ({
	metadata: { status: "200" },
	results: rows,
});

describe("edinetIndexDocument", () => {
	it("maps a row to the contract's document, submitDateTime as a +09:00 instant", () => {
		const document = edinetIndexDocument(row());
		expect(document).toEqual({
			docId: "S100AAAA",
			secCode: "99990",
			edinetCode: "E99991",
			filerName: "名",
			docTypeCode: "120",
			periodStart: "2024-04-01",
			periodEnd: "2025-03-31",
			submittedAt: "2025-06-20T15:00:00+09:00",
			parentDocId: null,
		});
		expect(edinetIndexDocumentSchema.safeParse(document).success).toBe(true);
	});

	it("keeps a period-less amendment and drops what the index cannot carry", () => {
		const amendment = row({
			docTypeCode: "130",
			periodStart: null,
			periodEnd: null,
			parentDocId: "S100BBBB",
		});
		expect(edinetIndexDocument(amendment)).toMatchObject({
			docTypeCode: "130",
			periodEnd: null,
			parentDocId: "S100BBBB",
		});
		// Not listed, a code of another form, no name, an annual report without a period end.
		expect(edinetIndexDocument(row({ secCode: null }))).toBeNull();
		expect(edinetIndexDocument(row({ secCode: "9999" }))).toBeNull();
		expect(edinetIndexDocument(row({ secCode: "99991" }))).toBeNull();
		expect(edinetIndexDocument(row({ filerName: null }))).toBeNull();
		// No XBRL-to-CSV: no facts and no 事業の内容 a sync could read (csvFlag not "1").
		expect(edinetIndexDocument(row({ csvAvailable: false }))).toBeNull();
		expect(edinetIndexDocument(row({ periodEnd: null }))).toBeNull();
	});

	it("cuts an over-long filer name at a character boundary", () => {
		const name = `${"a".repeat(EDINET_INDEX_LIMITS.maxFilerNameChars - 1)}𠮷b`;
		const document = edinetIndexDocument(row({ filerName: name }));
		expect(document?.filerName).toBe("a".repeat(EDINET_INDEX_LIMITS.maxFilerNameChars - 1));
		expect(edinetIndexDocumentSchema.safeParse(document).success).toBe(true);
	});
});

describe("edinetIndexDay", () => {
	it("keeps the listed annual reports of every filer, each document once", () => {
		const day = expectOk(
			edinetIndexDay(JSON.parse(equityFixtureText("edinet-documents-2025-06-20.synthetic.json"))),
		);
		// The withdrawn S100SYW5, the fund's 030 and the internal control report 235 are not annual rows.
		expect(day.documents.map((document) => [document.docId, document.secCode])).toEqual([
			["S10620OT", "88880"],
			["S100SY25", "99990"],
		]);
		expect(day.dropped).toBe(0);
		const twice = expectOk(
			edinetIndexDay(
				listOf([
					{
						docID: "S100AAAA",
						edinetCode: "E99991",
						secCode: "99990",
						filerName: "名",
						docTypeCode: "120",
						periodEnd: "2025-03-31",
						submitDateTime: "2025-06-20 15:00",
						withdrawalStatus: "0",
						csvFlag: "1",
					},
					{
						docID: "S100AAAA",
						edinetCode: "E99991",
						secCode: "99990",
						filerName: "名",
						docTypeCode: "120",
						periodEnd: "2025-03-31",
						submitDateTime: "2025-06-20 15:00",
						withdrawalStatus: "0",
						csvFlag: "1",
					},
					{
						docID: "S100AAAB",
						edinetCode: "E99992",
						secCode: null,
						filerName: "名",
						docTypeCode: "120",
						periodEnd: "2025-03-31",
						submitDateTime: "2025-06-20 15:00",
						withdrawalStatus: "0",
						csvFlag: "1",
					},
				]),
			),
		);
		expect(twice).toEqual({
			documents: [expect.objectContaining({ docId: "S100AAAA" })],
			dropped: 1,
		});
	});

	it("carries the list's problem, and refuses a day over the per-day limit", () => {
		expect(expectErr(edinetIndexDay({ metadata: { status: "401" } }))).toEqual({
			kind: "status",
			status: 401,
		});
		expect(expectErr(edinetIndexDay("x"))).toEqual({ kind: "parse" });
		const many = Array.from({ length: EDINET_INDEX_LIMITS.maxDocumentsPerDay + 1 }, (_, index) => ({
			docID: `S${String(index).padStart(7, "0")}`,
			edinetCode: "E99991",
			secCode: "99990",
			filerName: "名",
			docTypeCode: "130",
			submitDateTime: "2025-06-20 15:00",
			withdrawalStatus: "0",
			csvFlag: "1",
		}));
		expect(expectErr(edinetIndexDay(listOf(many)))).toEqual({ kind: "too-many" });
		expect(expectOk(edinetIndexDay(listOf(many.slice(1)))).documents).toHaveLength(
			EDINET_INDEX_LIMITS.maxDocumentsPerDay,
		);
	});
});

describe("createEdinetIndexSource", () => {
	const listUrl = (date: string) => edinetDocumentListUrl(date, KEY);
	const answers = (overrides: [string, FakeAnswer][] = []) =>
		new Map<string, FakeAnswer>([
			...DATES.map((date): [string, FakeAnswer] => [
				listUrl(date),
				{ text: equityFixtureText(`edinet-documents-${date}.synthetic.json`) },
			]),
			...overrides,
		]);
	const run = async (
		map: Map<string, FakeAnswer>,
		days: readonly string[] = DATES,
		apiKey: string | null = KEY,
		gate: readonly boolean[] = [],
	) => {
		const fake = fakeFetcher(map);
		let grants = 0;
		const result = await createEdinetIndexSource({ fetcher: fake.fetcher, apiKey }).list({
			days,
			signal: new AbortController().signal,
			beforeRequest: async () => {
				const answer = gate[grants] ?? true;
				grants += 1;
				return answer;
			},
		});
		return { result, requests: fake.requests, grants };
	};

	it("fails unconfigured without a request", async () => {
		const { result, requests, grants } = await run(answers(), DATES, null);
		expect(expectErr(result)).toEqual({
			code: "FINANCIAL_SOURCE_NOT_CONFIGURED",
			upstreamStatus: null,
			requests: 0,
		});
		expect(requests).toEqual([]);
		expect(grants).toBe(0);
	});

	it("lists each claimed date once, in claim order, with every filer's annual reports", async () => {
		const { result, requests, grants } = await run(answers(), [...DATES, DATES[0] ?? ""]);
		const data = expectOk(result);
		expect(
			data.days.map((day) => [day.date, day.documents.map((document) => document.docId)]),
		).toEqual([
			// S100SYB5 has no XBRL-to-CSV (csvFlag "0"): not indexed, counted as dropped.
			["2025-07-01", ["S10701OT"]],
			["2025-06-20", ["S10620OT", "S100SY25"]],
			["2024-09-10", ["S10910OT", "S100SYA4"]],
			["2020-06-26", ["S10626OT", "S100SY20"]],
		]);
		expect(data).toMatchObject({ failedDays: [], skippedDays: 0, droppedRows: 1, requests: 4 });
		expect(grants).toBe(4);
		expect(requests[0]).toEqual({
			url: listUrl("2025-07-01"),
			kind: "text",
			maxBytes: EDINET_LIST_MAX_BYTES,
			accept: "application/json",
			allowedHosts: ["api.edinet-fsa.go.jp"],
			userAgent: null,
		});
		// The amendment's row states no period (spec §3-1-2-2 *3): the index keeps it without one.
		const amendment = data.days[2]?.documents[1];
		expect(amendment).toEqual({
			docId: "S100SYA4",
			secCode: "99990",
			edinetCode: "E99991",
			filerName: "シンセティック工業株式会社",
			docTypeCode: "130",
			periodStart: null,
			periodEnd: null,
			submittedAt: "2024-09-10T10:30:00+09:00",
			parentDocId: "S100SY24",
		});
	});

	it("leaves out a date that failed and goes on with the others", async () => {
		for (const answer of [
			httpError(500),
			httpError(404),
			{ text: "<html>" },
			{ text: '{"metadata":{"status":"500","message":"Internal Server Error"}}' },
			{ error: { code: "TIMEOUT" as const, detail: "timed out" } },
		]) {
			const { result, requests } = await run(answers([[listUrl("2025-06-20"), answer]]));
			const data = expectOk(result);
			expect(data.days.map((day) => day.date)).toEqual(["2025-07-01", "2024-09-10", "2020-06-26"]);
			expect(data.failedDays).toHaveLength(1);
			expect(data.failedDays[0]?.date).toBe("2025-06-20");
			expect(requests).toHaveLength(4);
		}
		const { result } = await run(answers([[listUrl("2025-06-20"), { text: "<html>" }]]));
		expect(expectOk(result).failedDays).toEqual([
			{ date: "2025-06-20", code: "FINANCIAL_PARSE_FAILED", upstreamStatus: null },
		]);
	});

	it.each([
		[httpError(401), "FINANCIAL_ACCESS_DENIED", 401],
		[httpError(403), "FINANCIAL_ACCESS_DENIED", 403],
		[httpError(429), "FINANCIAL_RATE_LIMITED", 429],
		[{ text: '{"StatusCode":401,"message":"Access denied"}' }, "FINANCIAL_ACCESS_DENIED", 401],
		[{ text: '{"StatusCode":429,"message":"Too Many Requests"}' }, "FINANCIAL_RATE_LIMITED", 429],
	] as const)("stops listing after a refused key or a rate limit (%j)", async (answer, code, status) => {
		const { result, requests } = await run(answers([[listUrl("2025-06-20"), answer]]));
		const data = expectOk(result);
		expect(data.days.map((day) => day.date)).toEqual(["2025-07-01"]);
		expect(data.failedDays).toEqual([{ date: "2025-06-20", code, upstreamStatus: status }]);
		expect(data.skippedDays).toBe(2);
		expect(requests).toHaveLength(2);
	});

	it("fails the job with the first date's failure when no date could be listed", async () => {
		const first = await run(answers([[listUrl("2025-07-01"), httpError(401)]]));
		expect(expectErr(first.result)).toEqual({
			code: "FINANCIAL_ACCESS_DENIED",
			upstreamStatus: 401,
			requests: 1,
		});
		const all = await run(
			new Map(DATES.map((date): [string, FakeAnswer] => [listUrl(date), httpError(503)])),
		);
		expect(expectErr(all.result)).toEqual({
			code: "FINANCIAL_SOURCE_FAILED",
			upstreamStatus: 503,
			requests: 4,
		});
	});

	it("stops sending when the pacing gate says stop", async () => {
		const { result, requests } = await run(answers(), DATES, KEY, [true, false]);
		expect(expectErr(result)).toEqual({
			code: "FINANCIAL_SOURCE_FAILED",
			upstreamStatus: null,
			requests: 1,
		});
		expect(requests).toHaveLength(1);
	});
});
