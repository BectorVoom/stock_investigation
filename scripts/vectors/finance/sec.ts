/**
 * SEC EDGAR (crate `research-finance`): the fair-access client, the 13F-HR
 * source (filing selection, information-table XML, aggregation, comparison)
 * and the company-financials source (`secClient.ts`, `sec13f.ts`,
 * `secFinancials.ts`).
 *
 * The information-table XML is compared at two levels: the fast-xml-parser
 * object tree (an `XMLParser` built with the options of `sec13f.ts`, and the
 * `XMLValidator` verdict) over a corpus of well-formed and hostile documents,
 * and `parseInformationTable` itself over generated tables. Source cases are
 * transcripts: the real client runs over a scripted fetcher, a ticking clock
 * and a recording sleep, so pacing, the User-Agent rules, caching and the
 * order of requests are all part of the record.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	XMLParser,
	XMLValidator,
} from "../../../packages/adapters/node_modules/fast-xml-parser/src/fxp.js";
import {
	compareReportedPositions,
	createSec13FSource,
	extractInformationTableXml,
	parseInformationTable,
	type Reported13FHolding,
	secFilingTextUrl,
	secSubmissionsUrl,
	selectRecent13FFilings,
} from "../../../packages/adapters/src/finance/sec13f.ts";
import {
	createSecClient,
	isoDateToInstant,
	isUsableSecUserAgent,
	normalizeCik,
	parseSecJson,
} from "../../../packages/adapters/src/finance/secClient.ts";
import {
	createSecFinancialsSource,
	normalizeTickerKey,
	parseTickerDirectory,
	secCompanyFactsUrl,
	selectAnnualFinancials,
} from "../../../packages/adapters/src/finance/secFinancials.ts";
import {
	type FetchEvent,
	fetchError,
	plain,
	Rng,
	type ScriptEntry,
	scriptedFetcher,
	tickingClock,
} from "./support.ts";

const here = dirname(fileURLToPath(import.meta.url));
const secFixtureDir = join(here, "..", "..", "..", "examples", "fixtures", "sec");

function secFixture(name: string): string {
	return readFileSync(join(secFixtureDir, name), "utf8");
}

const SUBMISSIONS = secFixture("submissions-CIK0009999993.synthetic.json");
const FILING_Q1 = secFixture("13f-0009999993-26-000001.synthetic.txt");
const FILING_Q2 = secFixture("13f-0009999993-26-000004.synthetic.txt");
const TICKERS = secFixture("company_tickers_exchange.synthetic.json");
export const FACTS_ONE = secFixture("companyfacts-CIK0009999991.synthetic.json");
export const FACTS_TWO = secFixture("companyfacts-CIK0009999992.synthetic.json");

const UA = "Synthetic Research Workspace owner@synthetic-wire.org";

/* ---------- client primitives ---------- */

const USER_AGENTS: readonly (string | null)[] = [
	null,
	"",
	UA,
	"Short a@b.c",
	"a@b.c d",
	"x@y.z....",
	"Name a@b.c",
	"Name a@b",
	"Name @b.c",
	"Name a@.c",
	"Name a@b.",
	"Name a@b.c.",
	"Name a@@b.c",
	"Name a@b@c.d",
	"Name  a@b.c",
	"a @b.c",
	"Jane Doe research jane@example.com",
	"Jane Doe research jane@example",
	"Jane Doe research jane example.com",
	"Jane\tDoe jane@example.com",
	"Jane Doe jane@example.com é",
	"x".repeat(200),
	`${"x".repeat(180)} a@b.cc`,
	`${"x".repeat(190)} a@b.ccc`,
	`${"x".repeat(191)} a@b.ccc`,
	`${"x".repeat(192)} a@b.ccc`,
	"a@b.c@d.e",
	"mail:a@b.c",
	"a.b@c.d.e",
	"@a.b c@d.e",
	"\u007f a@b.c more",
	"~ a@b.cx text",
];

const CIK_INPUTS: readonly string[] = [
	"0009999993",
	"9999993",
	"CIK9999993",
	"cik9999993",
	" CIK 9999993",
	" CIK9999993 ",
	"CIKCIK123",
	"0",
	"0000000000",
	"00000000000",
	"12345678901",
	"1234567890",
	"",
	" ",
	"abc",
	"１２３",
	"12 3",
	"-5",
	"+5",
	"1e3",
	" 123 ",
	"﻿123",
	"CIK",
	"cIk0000000001",
];

function clientPrimitiveCases(): unknown {
	return {
		userAgents: USER_AGENTS.map((input) => ({ input, output: isUsableSecUserAgent(input) })),
		ciks: CIK_INPUTS.map((input) => ({ input, output: normalizeCik(input) })),
		instants: ["2024-11-01", "0001-01-01", "x"].map((input) => ({
			input,
			output: isoDateToInstant(input),
		})),
		json: ["{}", "[1]", "{oops", "", '{"a":1,"a":2}', "1e400", '"x"', "null"].map((text) => ({
			text,
			output: plain(parseSecJson({ url: "https://www.sec.gov/x", text })),
		})),
	};
}

/* ---------- source harness ---------- */

interface SecStep {
	readonly advanceMs: number;
	readonly arg: string;
	readonly cancel: boolean;
}

interface SecCase {
	readonly kind: "13f" | "financials";
	readonly userAgent: string | null;
	readonly startMs: number;
	readonly steps: readonly SecStep[];
	readonly script: readonly ScriptEntry[];
	readonly events: unknown;
	readonly outputs: unknown;
}

async function runSec(
	kind: "13f" | "financials",
	userAgent: string | null,
	steps: readonly SecStep[],
	script: readonly ScriptEntry[],
): Promise<SecCase> {
	const startMs = Date.UTC(2026, 9, 17, 3, 0, 0);
	const clock = tickingClock(startMs);
	const events: FetchEvent[] = [];
	const fetcher = scriptedFetcher(script, events);
	const client = createSecClient({
		fetcher,
		clock,
		userAgent,
		sleep: async (ms) => {
			events.push({ sleep: ms });
		},
	});
	const outputs: unknown[] = [];
	if (kind === "13f") {
		const source = createSec13FSource({ client });
		for (const step of steps) {
			clock.advance(step.advanceMs);
			const controller = new AbortController();
			if (step.cancel) controller.abort();
			outputs.push(plain(await source.latestHoldings(step.arg, controller.signal)));
		}
	} else {
		const source = createSecFinancialsSource({ client, nowMs: () => clock.nowMs() });
		for (const step of steps) {
			clock.advance(step.advanceMs);
			const controller = new AbortController();
			if (step.cancel) controller.abort();
			outputs.push(plain(await source.latestAnnualFinancials(step.arg, controller.signal)));
		}
	}
	return { kind, userAgent, startMs, steps, script, events: plain(events), outputs };
}

/** Direct client cases: URL, caps and accept, with concurrent and sequential batches. */
interface ClientCase {
	readonly userAgent: string | null;
	readonly startMs: number;
	readonly concurrent: boolean;
	readonly calls: readonly {
		readonly url: string;
		readonly maxBytes: number;
		readonly accept: string;
		readonly advanceMs: number;
		readonly cancel: boolean;
	}[];
	readonly script: readonly ScriptEntry[];
	readonly events: unknown;
	readonly outputs: unknown;
}

async function runClient(
	userAgent: string | null,
	concurrent: boolean,
	calls: ClientCase["calls"],
	script: readonly ScriptEntry[],
): Promise<ClientCase> {
	const startMs = Date.UTC(2026, 9, 17, 3, 0, 0);
	const clock = tickingClock(startMs);
	const events: FetchEvent[] = [];
	const client = createSecClient({
		fetcher: scriptedFetcher(script, events),
		clock,
		userAgent,
		sleep: async (ms) => {
			events.push({ sleep: ms });
		},
	});
	const one = (call: ClientCase["calls"][number]) => {
		const controller = new AbortController();
		if (call.cancel) controller.abort();
		return client.fetchDocument(call.url, {
			maxBytes: call.maxBytes,
			accept: call.accept,
			signal: controller.signal,
		});
	};
	let results: unknown[];
	if (concurrent) {
		for (const call of calls) clock.advance(call.advanceMs);
		results = (await Promise.all(calls.map(one))).map((result) => plain(result));
	} else {
		results = [];
		for (const call of calls) {
			clock.advance(call.advanceMs);
			results.push(plain(await one(call)));
		}
	}
	// Sleeps and fetches interleave differently when calls overlap, so the
	// record keeps them apart; each list is ordered.
	return {
		userAgent,
		startMs,
		concurrent,
		calls,
		script,
		events: {
			fetches: plain(events.filter((event) => "fetch" in event)),
			sleeps: plain(events.filter((event) => "sleep" in event)),
		},
		outputs: results,
	};
}

async function clientCases(): Promise<ClientCase[]> {
	const rng = new Rng(0x5ec1);
	const cases: ClientCase[] = [];
	const errors: ScriptEntry[] = [
		fetchError("HTTP_ERROR", "HTTP 404"),
		fetchError("HTTP_ERROR", "HTTP 403"),
		fetchError("HTTP_ERROR", "HTTP 429"),
		fetchError("HTTP_ERROR", "HTTP 500"),
		fetchError("HTTP_ERROR", "HTTP 503"),
		fetchError("HTTP_ERROR", "HTTP 400"),
		fetchError("HTTP_ERROR", "HTTP 301 without a Location header"),
		fetchError("RESPONSE_TOO_LARGE", "body exceeds 10 bytes"),
		fetchError("TIMEOUT", "no complete response"),
		fetchError("NETWORK_ERROR", "ECONNRESET"),
		fetchError("HOST_NOT_ALLOWED", "host is not on the allowlist"),
		fetchError("UNSAFE_URL", "x"),
	];
	const urls = [
		"https://data.sec.gov/submissions/CIK0009999993.json",
		"https://www.sec.gov/files/company_tickers_exchange.json",
		"https://www.sec.gov/Archives/edgar/data/1/2/3.txt",
		"https://example.com/x",
		"https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json",
	];
	for (let index = 0; index < 160; index += 1) {
		const count = rng.int(1, 5);
		const calls = Array.from({ length: count }, () => ({
			url: rng.pick(urls),
			maxBytes: rng.pick([100, 8_000_000, 48_000_000]),
			accept: rng.pick(["application/json", "text/plain"]),
			advanceMs: rng.pick([0, 0, 50, 125, 126, 1000, 100_000]),
			cancel: rng.chance(0.1),
		}));
		const script: ScriptEntry[] = calls.map(() =>
			rng.chance(0.55)
				? {
						text: rng.pick(["{}", "body"]),
						finalUrl: rng.pick([undefined, "https://www.sec.gov/final"]),
					}
				: rng.pick(errors),
		);
		const userAgent = rng.chance(0.8) ? UA : rng.pick(USER_AGENTS);
		cases.push(await runClient(userAgent, rng.chance(0.4), calls, script));
	}
	return cases;
}

/* ---------- 13F: submissions, extraction, comparison ---------- */

const FORMS = ["13F-HR", "13F-HR", "13F-HR", "13F-HR/A", "13F-NT", "SC 13G", "", "13f-hr"];
const ACCESSIONS = [
	"0009999993-26-000004",
	"0009999993-26-000003",
	"0000000001-25-000009",
	"0000000001-25-000008",
	"0000000001-25-000005",
	"0000000001-26-000002",
	"0009999993-26-00000",
	"bad-accession",
	"0009999993-26-0000011",
	"000999999326000004",
	"９９９９９９９９９９-26-000004",
	"",
];
const DATES = [
	"2026-08-14",
	"2026-05-15",
	"2026-03-31",
	"2026-06-30",
	"2025-12-31",
	"2025-09-30",
	"2024-02-29",
	"2026-02-29",
	"2023-01-03",
	"2023-01-02",
	"0000-01-01",
	"9999-12-31",
	"not-a-date",
	"",
	"2026-13-01",
	"2026-1-1",
];

function randomSubmissions(rng: Rng): string {
	const count = rng.int(0, 12);
	const column = <T>(make: () => T): T[] => Array.from({ length: count }, make);
	const recent: { [key: string]: unknown } = {
		accessionNumber: column(() => rng.pick(ACCESSIONS)),
		filingDate: column(() => rng.pick(DATES)),
		reportDate: column(() => rng.pick(DATES)),
		form: column(() => rng.pick(FORMS)),
	};
	// Often well formed, so that real selections happen.
	if (rng.chance(0.6)) {
		recent.accessionNumber = column(() => rng.pick(ACCESSIONS.slice(0, 6)));
		recent.filingDate = column(() => rng.pick(DATES.slice(0, 6)));
		recent.reportDate = column(() => rng.pick(DATES.slice(0, 6)));
		recent.form = column(() => rng.pick(FORMS.slice(0, 5)));
	}
	if (rng.chance(0.08)) recent.reportDate = (recent.reportDate as unknown[]).slice(1);
	if (rng.chance(0.05))
		delete recent[rng.pick(["accessionNumber", "filingDate", "reportDate", "form"])];
	if (rng.chance(0.04)) recent.form = [1, 2, 3];
	const doc: { [key: string]: unknown } = {
		name: rng.pick(["Synthetic Capital Management LP", "  Padded Mgr  ", "", " ", "名前", "﻿BOM﻿"]),
		filings: { recent },
	};
	if (rng.chance(0.04)) doc.name = rng.pick([null, 5, undefined]);
	if (rng.chance(0.03)) doc.filings = rng.pick([null, {}, { recent: null }, []]);
	return JSON.stringify(doc);
}

const INFO_ROW = (
	prefix: string,
	name: string,
	cusip: string,
	value: string,
	shares: string,
	type: string | null,
	extra = "",
): string =>
	`<${prefix}infoTable><${prefix}nameOfIssuer>${name}</${prefix}nameOfIssuer><${prefix}cusip>${cusip}</${prefix}cusip><${prefix}value>${value}</${prefix}value><${prefix}shrsOrPrnAmt><${prefix}sshPrnamt>${shares}</${prefix}sshPrnamt>${type === null ? "" : `<${prefix}sshPrnamtType>${type}</${prefix}sshPrnamtType>`}</${prefix}shrsOrPrnAmt>${extra}</${prefix}infoTable>`;

const CUSIPS = [
	"037833100",
	"594918104",
	"02079K305",
	"11111111a",
	"ABCDEFGHI",
	"12345678",
	"1234567890",
	"  037833100  ",
	"037 33100",
	"0378331é0",
	"",
	"037833100 ",
];
const ISSUERS = [
	"APPLE INC",
	"MICROSOFT CORP",
	"A &amp; B &lt;CO&gt;",
	"<![CDATA[ Cdata Co &amp; ]]>",
	"  Spaced  ",
	"",
	" ",
	"N".repeat(300),
	"N".repeat(301),
	"経".repeat(300),
	"経".repeat(301),
	"😀".repeat(150),
	"😀".repeat(151),
	"X &#x41; &#66; &#0; &lol;",
	"Two<b>parts</b>tail",
];
const AMOUNTS = [
	"1000",
	"250.5",
	"0",
	"00012",
	"1e3",
	"-5",
	"1,000",
	"",
	" 42 ",
	".5",
	"5.",
	"12345678901234567890",
	"99999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999",
];

function randomRow(rng: Rng, prefix: string, noise: number): string {
	const cusip = rng.chance(1 - 0.15 * noise)
		? rng.pick(CUSIPS.slice(0, 3).concat(["AAAAAAAA1", "BBBBBBBB2"]))
		: rng.pick(CUSIPS);
	const value = rng.chance(1 - 0.15 * noise) ? rng.pick(AMOUNTS.slice(0, 3)) : rng.pick(AMOUNTS);
	const shares = rng.chance(1 - 0.15 * noise) ? rng.pick(AMOUNTS.slice(0, 3)) : rng.pick(AMOUNTS);
	const type = rng.chance(1 - 0.15 * noise)
		? "SH"
		: rng.pick(["PRN", "sh", "prn", "", " SH ", null, "XX"]);
	const name = rng.chance(1 - 0.15 * noise) ? rng.pick(ISSUERS.slice(0, 3)) : rng.pick(ISSUERS);
	let extra = "";
	if (rng.chance(0.1 * noise))
		extra += `<${prefix}putCall>${rng.pick(["Put", "Call", "", " "])}</${prefix}putCall>`;
	if (rng.chance(0.2)) extra += `<${prefix}titleOfClass>COM</${prefix}titleOfClass>`;
	if (rng.chance(0.1))
		extra += `<${prefix}votingAuthority><${prefix}Sole>1</${prefix}Sole></${prefix}votingAuthority>`;
	if (rng.chance(0.05 * noise)) extra += `<${prefix}cusip>DUPLICATE9</${prefix}cusip>`;
	const row = INFO_ROW(prefix, name, cusip, value, shares, type, extra);
	if (rng.chance(0.05 * noise))
		return row.replace(`<${prefix}infoTable>`, `<${prefix}infoTable x="1" y='2'>`);
	if (rng.chance(0.03 * noise))
		return row.replace(/<\/[^>]*cusip>/, `</${prefix}cusip ><!-- c -->`);
	return row;
}

function randomInfoTable(rng: Rng, noise = 1): string {
	const prefix = rng.pick(["", "", "ns1:", "n:", "a:b:", "xmlns:"]);
	const rootName = rng.chance(1 - 0.07 * noise)
		? "informationTable"
		: rng.pick(["informationtable", "table", "root", "InformationTable"]);
	const count = rng.int(0, 10);
	let rows = "";
	for (let index = 0; index < count; index += 1) {
		rows += rng.pick(["", "\n  ", "\r\n", "\t", " "]) + randomRow(rng, prefix, noise);
		if (rng.chance(0.05 * noise)) rows += "<!-- comment -->";
		if (rng.chance(0.03 * noise)) rows += "<?pi data?>";
		if (rng.chance(0.03 * noise)) rows += "stray text";
	}
	if (rng.chance(0.04 * noise)) rows += `<${prefix}infoTable>just text</${prefix}infoTable>`;
	if (rng.chance(0.03 * noise)) rows += `<${prefix}infoTable/>`;
	const decl = rng.chance(0.6) ? '<?xml version="1.0" encoding="UTF-8"?>\n' : "";
	const ns = rng.chance(0.5)
		? ` xmlns${prefix === "" ? "" : `:${prefix.slice(0, -1)}`}="http://www.sec.gov/edgar/document/thirteenf/informationtable"`
		: "";
	let xml = `${decl}<${prefix}${rootName}${ns}>${rows}</${prefix}${rootName}>`;
	if (rng.chance(0.04 * noise)) xml = xml.slice(0, rng.int(1, xml.length - 1));
	if (rng.chance(0.03 * noise)) xml = `<!DOCTYPE x [<!ENTITY e "v">]>${xml}`;
	if (rng.chance(0.02 * noise)) xml = `${xml}<extra/>`;
	if (rng.chance(0.02)) xml = `﻿${xml}`;
	return xml;
}

function submissionText(rng: Rng, infoXml: string | null, clean = false): string {
	const head = rng.chance(0.8) ? "<SEC-DOCUMENT>\n" : "";
	let documents =
		"<DOCUMENT>\n<TYPE>13F-HR\n<TEXT>\n<XML>\n<edgarSubmission/>\n</XML>\n</TEXT>\n</DOCUMENT>\n";
	if (infoXml !== null) {
		const type = clean
			? "INFORMATION TABLE"
			: rng.pick([
					"INFORMATION TABLE",
					"INFORMATION TABLE",
					"information table",
					" Information Table ",
					"INFORMATION TABLE\r",
					"INFORMATION TABLE<x>",
					"INFO TABLE",
				]);
		const open = clean ? "<XML>" : rng.pick(["<XML>", "<XML>", "<XML>\n"]);
		const close = clean ? "</XML>" : rng.pick(["</XML>", "</XML>", "</XML>\n", ""]);
		documents += `<DOCUMENT>\n<TYPE>${type}\n<TEXT>\n${open}${rng.chance(0.2) ? "\n  " : ""}${infoXml}${rng.chance(0.2) ? "  \n" : ""}${close}\n</TEXT>\n</DOCUMENT>\n`;
		if (rng.chance(0.1)) {
			documents += `<DOCUMENT>\n<TYPE>INFORMATION TABLE\n<TEXT>\n<XML>\n<informationTable/>\n</XML>\n</TEXT>\n</DOCUMENT>\n`;
		}
	}
	return `${head}${documents}${rng.chance(0.8) ? "</SEC-DOCUMENT>" : ""}`;
}

function extractionCases(rng: Rng): unknown[] {
	const cases: unknown[] = [];
	const texts: string[] = [
		FILING_Q1,
		FILING_Q2,
		"",
		"<DOCUMENT>",
		"<DOCUMENT><TYPE>INFORMATION TABLE<XML></XML>",
		"<DOCUMENT><TYPE>INFORMATION TABLE<XML>x</XML>",
		"<DOCUMENT><TYPE>INFORMATION TABLE\n<XML>  x  </XML>",
		"<DOCUMENT><TYPE>INFORMATION TABLE\n</XML>x<XML>",
		"<DOCUMENT><TYPE>INFORMATION TABLE\n<XML>x",
		"<document><TYPE>INFORMATION TABLE\n<XML>x</XML>",
		"<DOCUMENT><type>INFORMATION TABLE\n<XML>x</XML>",
		"<DOCUMENT>\n<TYPE>\nINFORMATION TABLE\n<XML>x</XML>",
		"<DOCUMENT>\n<TYPE>\r\nINFORMATION TABLE\n<XML>x</XML>",
		"<DOCUMENT>\n<TYPE>INFORMATION TABLE<TEXT><XML>a</XML><XML>b</XML>",
		"<DOCUMENT>\n<TYPE>OTHER\n<XML>a</XML><DOCUMENT><TYPE>INFORMATION TABLE\n<XML>b</XML>",
		"<DOCUMENT>\n<TYPE>OTHER<TYPE>INFORMATION TABLE\n<XML>b</XML>",
		"<DOCUMENT>\n<TYPE>INFORMATION TABLE\n<XML> ﻿x </XML>",
		"<DOCUMENT>\n<TYPE>ınformation table\n<XML>x</XML>",
		"<DOCUMENT>\n<TYPE>ſ\n<XML>x</XML>",
	];
	for (const input of texts) cases.push({ input, output: extractInformationTableXml(input) });
	for (let index = 0; index < 250; index += 1) {
		const info = rng.chance(0.9) ? randomInfoTable(rng) : null;
		const input = submissionText(rng, info);
		cases.push({ input, output: extractInformationTableXml(input) });
	}
	return cases;
}

function selectionCases(rng: Rng): unknown[] {
	const cases: unknown[] = [];
	const inputs: unknown[] = [
		JSON.parse(SUBMISSIONS),
		null,
		{},
		{ name: "x", filings: {} },
		{ name: "", filings: { recent: {} } },
		[],
		"x",
		{
			name: "x",
			filings: { recent: { accessionNumber: [], filingDate: [], reportDate: [], form: [] } },
		},
	];
	for (const input of inputs) cases.push({ input, output: plain(selectRecent13FFilings(input)) });
	for (let index = 0; index < 500; index += 1) {
		const input: unknown = JSON.parse(randomSubmissions(rng));
		cases.push({ input, output: plain(selectRecent13FFilings(input)) });
	}
	return cases;
}

/** Fast-xml-parser exactly as `sec13f.ts` configures it. */
const informationTableParser = new XMLParser({
	ignoreAttributes: true,
	removeNSPrefix: true,
	processEntities: false,
	htmlEntities: false,
	parseTagValue: false,
	trimValues: true,
	ignoreDeclaration: true,
	ignorePiTags: true,
	maxNestedTags: 16,
});

interface TreeCase {
	readonly input: string;
	readonly valid: boolean;
	readonly tree: unknown;
}

/** The tree as an ordered encoding (JSON objects are unordered for the replay). */
function encodeTree(value: unknown): unknown {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return { a: value.map(encodeTree) };
	if (typeof value === "object" && value !== null) {
		return { o: Object.entries(value).map(([key, item]) => [key, encodeTree(item)]) };
	}
	return { other: String(value) };
}

function treeCase(input: string): TreeCase {
	let valid = false;
	let tree: unknown = { throws: true };
	try {
		valid = XMLValidator.validate(input) === true;
		if (valid) tree = encodeTree(informationTableParser.parse(input));
	} catch {
		tree = { throws: true };
	}
	return { input, valid, tree };
}

const SOUP: readonly string[] = [
	"<a>",
	"</a>",
	"<b>",
	"</b>",
	"<ns:c>",
	"</ns:c>",
	"<x:y:z>",
	"</x:y:z>",
	"<a/>",
	"<a:b/>",
	"<a />",
	"<a:b />",
	"<a x='1'>",
	"<a:b x=\"1\" y='2'/>",
	"text",
	"  spaced  ",
	"\n",
	"\r\n",
	"\t",
	"&amp;",
	"&lt;",
	"&#65;",
	"&unknown;",
	"<![CDATA[cd]]>",
	"<![CDATA[  &amp;  ]]>",
	"<![CDATA[]]>",
	"<!-- comment -->",
	"<!---->",
	"<?xml version='1.0'?>",
	"<?pi x?>",
	"<!DOCTYPE d>",
	'<!DOCTYPE d [<!ENTITY e "v">]>',
	"<!DOCTYPE d [<!ENTITY % e SYSTEM 'x'>]>",
	"<__proto__>",
	"</__proto__>",
	"<constructor/>",
	"<ns:prototype>",
	"<toString>",
	"</toString>",
	"<hasOwnProperty/>",
	"<#text>",
	"<>",
	"</>",
	"<",
	">",
	"<a",
	"<1a>",
	"<a b>",
	"<a b=c>",
	"﻿",
	" ",
	"\u0085",
	"日本",
];

function treeCorpus(rng: Rng): TreeCase[] {
	const cases: TreeCase[] = [];
	for (const input of [
		secFixture("13f-0009999993-26-000001.synthetic.txt"),
		"",
		"<a/>",
		"<a></a>",
		"<ns1:informationTable><ns1:infoTable><ns1:cusip>X</ns1:cusip></ns1:infoTable></ns1:informationTable>",
		`${"<a>".repeat(16)}x${"</a>".repeat(16)}`,
		`${"<a>".repeat(17)}x${"</a>".repeat(17)}`,
		`${"<a>".repeat(18)}x${"</a>".repeat(18)}`,
		`${"<a:b>".repeat(17)}x${"</a:b>".repeat(17)}`,
		"<a>one<b/>two<c/>three</a>",
		"<a><![CDATA[ x ]]> y </a>",
		"<a> x <![CDATA[ y ]]> z </a>",
		"<a><![CDATA[x]]><![CDATA[y]]></a>",
		"<a>&amp;<![CDATA[&amp;]]></a>",
		"<a:b:c>x</a:b:c>",
		"<a:b>x</b>",
		"<a b='1'>x</a>",
		"<a b = '1' >x</a>",
		"<a\tb='1'>x</a>",
		"<a><b>1</b><b>2</b><c>3</c><b>4</b></a>",
	]) {
		cases.push(treeCase(input));
	}
	for (let index = 0; index < 900; index += 1) {
		cases.push(treeCase(randomInfoTable(rng)));
	}
	for (let index = 0; index < 900; index += 1) {
		cases.push(treeCase(rng.picks(SOUP, rng.int(1, 14)).join(rng.pick(["", "", " ", "\n"]))));
	}
	return cases;
}

function parseCases(rng: Rng): unknown[] {
	const cases: unknown[] = [];
	for (let index = 0; index < 700; index += 1) {
		const input = randomInfoTable(rng, index % 2 === 0 ? 0.3 : 1);
		cases.push({ input, output: plain(parseInformationTable(input)) });
	}
	for (const input of [
		extractInformationTableXml(FILING_Q1) ?? "",
		extractInformationTableXml(FILING_Q2) ?? "",
		"",
		"<informationTable/>",
		"<informationTable></informationTable>",
		"<informationTable>text</informationTable>",
		"<x/>",
	]) {
		cases.push({ input, output: plain(parseInformationTable(input)) });
	}
	return cases;
}

function holdingsOf(rng: Rng): Reported13FHolding[] {
	const cusips = ["AAAAAAAA1", "BBBBBBBB2", "CCCCCCCC3", "DDDDDDDD4", "EEEEEEEE5"];
	const count = rng.int(0, 5);
	return rng
		.shuffle([...cusips])
		.slice(0, count)
		.map((cusip) => ({
			issuerName: rng.pick(["Alpha", "Beta", "Gamma"]),
			cusip,
			reportedShares: rng.pick([0, 1, 100, 100, 250.5, 1e9, Number.POSITIVE_INFINITY]),
			reportedValueUsd: rng.pick([0, 1, 100, 1e12]),
		}));
}

function compareCases(rng: Rng): unknown[] {
	const cases: unknown[] = [];
	for (let index = 0; index < 400; index += 1) {
		const previous = holdingsOf(rng);
		const current = holdingsOf(rng);
		cases.push({ previous, current, output: plain(compareReportedPositions(previous, current)) });
	}
	return cases;
}

/* ---------- 13F: source transcripts ---------- */

const FILING_URL_1 =
	"https://www.sec.gov/Archives/edgar/data/9999993/000999999326000001/0009999993-26-000001.txt";
const FILING_URL_4 =
	"https://www.sec.gov/Archives/edgar/data/9999993/000999999326000004/0009999993-26-000004.txt";

async function sec13fSourceCases(): Promise<SecCase[]> {
	const rng = new Rng(0x13f);
	const cases: SecCase[] = [];
	const base: ScriptEntry[] = [{ text: SUBMISSIONS }, { text: FILING_Q2 }, { text: FILING_Q1 }];
	const step = (arg: string, advanceMs = 0, cancel = false): SecStep => ({
		advanceMs,
		arg,
		cancel,
	});
	cases.push(await runSec("13f", UA, [step("0009999993")], base));
	cases.push(await runSec("13f", UA, [step("CIK9999993"), step("9999993", 5)], [...base, ...base]));
	cases.push(await runSec("13f", null, [step("0009999993")], base));
	cases.push(await runSec("13f", UA, [step("abc")], base));
	cases.push(await runSec("13f", UA, [step("0009999993")], [fetchError("HTTP_ERROR", "HTTP 404")]));
	cases.push(await runSec("13f", UA, [step("0009999993")], [{ text: "{oops" }]));
	cases.push(
		await runSec(
			"13f",
			UA,
			[step("0009999993")],
			[{ text: SUBMISSIONS }, fetchError("HTTP_ERROR", "HTTP 429")],
		),
	);
	cases.push(
		await runSec(
			"13f",
			UA,
			[step("0009999993")],
			[{ text: SUBMISSIONS }, { text: FILING_Q2 }, fetchError("TIMEOUT", "x")],
		),
	);
	cases.push(
		await runSec(
			"13f",
			UA,
			[step("0009999993")],
			[{ text: SUBMISSIONS }, { text: "no documents" }],
		),
	);
	cases.push(await runSec("13f", UA, [step("0009999993", 0, true)], base));
	void FILING_URL_1;
	void FILING_URL_4;
	for (let index = 0; index < 220; index += 1) {
		const submissions = rng.chance(0.8) ? SUBMISSIONS : randomSubmissions(rng);
		const filingCount = rng.chance(0.75) ? 2 : rng.int(0, 3);
		const script: ScriptEntry[] = [{ text: submissions }];
		for (let item = 0; item < filingCount; item += 1) {
			const roll = rng.float();
			if (roll < 0.04)
				script.push(
					fetchError(
						rng.pick(["HTTP_ERROR", "TIMEOUT", "NETWORK_ERROR"] as const),
						rng.pick(["HTTP 500", "HTTP 403", "x"]),
					),
				);
			else if (roll < 0.07) script.push({ text: submissionText(rng, null) });
			else
				script.push({
					text: submissionText(rng, randomInfoTable(rng, 0.1), rng.chance(0.85)),
					finalUrl: rng.pick([undefined, "https://www.sec.gov/final.txt"]),
				});
		}
		const steps = [
			step(
				rng.chance(0.95) ? rng.pick(["0009999993", "CIK9999993", "123"]) : "bad",
				rng.pick([0, 10, 200]),
			),
		];
		cases.push(await runSec("13f", rng.chance(0.97) ? UA : null, steps, script));
	}
	return cases;
}

/* ---------- company facts ---------- */

const FACT_DATES: readonly [string, string][] = [
	["2022-07-01", "2023-06-30"],
	["2023-07-01", "2024-06-30"],
	["2024-07-01", "2025-06-30"],
	["2024-01-01", "2024-12-31"],
	["2023-01-01", "2023-12-31"],
	["2025-01-01", "2025-12-31"],
	["2024-01-01", "2024-03-31"],
	["2024-01-01", "2024-12-30"],
	["2024-01-01", "2025-01-10"],
	["2024-01-01", "2025-01-20"],
	["2024-02-01", "2025-01-31"],
	["2023-12-30", "2024-12-28"],
	["1989-01-01", "1989-12-31"],
	["2100-01-01", "2100-12-31"],
	["2101-01-01", "2101-12-31"],
	["2024-02-29", "2025-02-28"],
	["2024-02-30", "2025-02-28"],
];

function randomFact(rng: Rng): { [key: string]: unknown } {
	const [start, end] = rng.pick(FACT_DATES);
	const fact: { [key: string]: unknown } = {
		start,
		end,
		val: rng.pick([1_400_000_000, -5, 0, 1.5, 123456789012, 2.5e9, 7]),
		accn: rng.pick([
			"0009999991-24-000009",
			"0009999991-25-000010",
			"0009999991-25-000011",
			"A",
			"a",
			"Z9",
			"x".repeat(40),
			"x".repeat(41),
			"",
		]),
		fy: rng.pick<unknown>([2024, 2025, null, undefined, 2024.5, "2024"]),
		fp: rng.pick<unknown>(["FY", "FY", "FY", "Q3", "Q1", null, undefined, 5]),
		form: rng.pick(["10-K", "10-K", "10-K/A", "10-Q", "8-K", "20-F"]),
		filed: rng.pick(["2024-08-21", "2025-08-20", "2025-08-21", "2025-09-01", "2024-02-30", "bad"]),
	};
	if (rng.chance(0.08)) delete fact.start;
	if (rng.chance(0.05)) fact.val = rng.pick(["x", null, "5"]);
	if (rng.chance(0.03)) delete fact.end;
	for (const key of Object.keys(fact)) if (fact[key] === undefined) delete fact[key];
	return fact;
}

export function randomFacts(rng: Rng): unknown {
	const unitsFor = (perShare: boolean): { [key: string]: unknown[] } => {
		const units: { [key: string]: unknown[] } = {};
		const names = perShare
			? ["USD/shares", "JPY/shares", "EUR/shares", "USD", "shares"]
			: ["USD", "JPY", "EUR", "USDX", "usd", "USD/shares"];
		const wanted = rng.int(0, 3);
		for (let item = 0; item < wanted; item += 1) {
			units[rng.pick(names)] = Array.from({ length: rng.int(0, 6) }, () => randomFact(rng));
		}
		return units;
	};
	const concept = (perShare: boolean): unknown =>
		rng.chance(0.05)
			? rng.pick([null, "x", 5, { units: 5 }, { units: { USD: 5 } }])
			: { label: rng.pick([undefined, "L", null, 5]), units: unitsFor(perShare) };
	const gaap: { [key: string]: unknown } = {};
	for (const [name, perShare] of [
		["Revenues", false],
		["RevenueFromContractWithCustomerExcludingAssessedTax", false],
		["RevenueFromContractWithCustomerIncludingAssessedTax", false],
		["SalesRevenueNet", false],
		["NetIncomeLoss", false],
		["EarningsPerShareDiluted", true],
	] as const) {
		if (rng.chance(0.7)) gaap[name] = concept(perShare);
	}
	const doc: { [key: string]: unknown } = {
		entityName: "Synthetic",
		facts: { "us-gaap": gaap, dei: {} },
	};
	if (rng.chance(0.06))
		doc.facts = rng.pick([{}, { "us-gaap": [] }, { "us-gaap": null }, null, []]);
	if (rng.chance(0.03)) doc.entityName = rng.pick([null, 5]);
	if (rng.chance(0.02)) return rng.pick([null, [], "x", {}]);
	return doc;
}

/** A facts document tuned so that revenue, income and EPS all line up. */
export function alignedFacts(rng: Rng): unknown {
	const [start, end] = rng.pick(FACT_DATES.slice(0, 6));
	const fact = (val: number, accn: string, filed: string): { [key: string]: unknown } => ({
		start,
		end,
		val,
		accn,
		fy: 2025,
		fp: "FY",
		form: "10-K",
		filed,
	});
	const currency = rng.pick(["USD", "USD", "JPY"]);
	const gaap: { [key: string]: unknown } = {
		Revenues: {
			units: {
				[currency]: [
					fact(rng.pick([1000, 0, -5, 2e9]), "0000000001-25-000001", "2025-08-01"),
					fact(1100, "0000000001-25-000002", "2025-09-01"),
				],
			},
		},
		NetIncomeLoss: {
			units: {
				[rng.pick([currency, currency, "EUR"])]: [
					fact(rng.pick([100, -20, 2.5]), "0000000001-25-000001", "2025-08-01"),
				],
			},
		},
		EarningsPerShareDiluted: {
			units: { [`${currency}/shares`]: [fact(1.25, "0000000001-25-000001", "2025-08-01")] },
		},
	};
	if (rng.chance(0.2)) {
		gaap.SalesRevenueNet = {
			units: { [currency]: [fact(5, "0000000001-25-000003", "2025-08-01")] },
		};
	}
	if (rng.chance(0.2)) {
		(gaap.NetIncomeLoss as { units: { [k: string]: unknown[] } }).units.USD = [
			fact(7, "0000000001-25-000004", "2025-08-01"),
		];
	}
	return { entityName: "Aligned", facts: { "us-gaap": gaap } };
}

function factsCases(rng: Rng): unknown[] {
	const cases: unknown[] = [];
	const inputs: unknown[] = [JSON.parse(FACTS_ONE), JSON.parse(FACTS_TWO)];
	for (let index = 0; index < 450; index += 1)
		inputs.push(rng.chance(0.45) ? alignedFacts(rng) : randomFacts(rng));
	for (const input of inputs) cases.push({ input, output: plain(selectAnnualFinancials(input)) });
	return cases;
}

function directoryCases(rng: Rng): unknown[] {
	const cases: unknown[] = [];
	const inputs: unknown[] = [
		JSON.parse(TICKERS),
		null,
		{},
		{ fields: [], data: [] },
		{ fields: ["cik"], data: [[1]] },
	];
	const names = ["cik", "name", "ticker", "exchange"];
	for (let index = 0; index < 300; index += 1) {
		const fields = rng.chance(0.85)
			? rng.shuffle([...names])
			: rng.pick([names.slice(1), [...names, "x"], ["cik", "name", "ticker"]]);
		const data = Array.from({ length: rng.int(0, 8) }, () =>
			fields.map((field) => {
				if (field === "cik")
					return rng.pick<unknown>([
						9999991,
						320193,
						1,
						0,
						-5,
						1.5,
						3,
						"320193",
						null,
						1e21,
						12345678901,
						5.0,
					]);
				if (field === "name") return rng.pick<unknown>(["Apple Inc.", " Padded ", "", 5, null]);
				if (field === "ticker")
					return rng.pick<unknown>([
						"AAPL",
						"brk.b",
						"BRK-B",
						" msft ",
						"",
						" ",
						"A.B.C",
						5,
						null,
						"ä",
					]);
				return rng.pick<unknown>(["Nasdaq", "NYSE", " OTC ", "", " ", null, 5]);
			}),
		);
		const input: { [key: string]: unknown } = { fields, data };
		if (rng.chance(0.05)) input.data = rng.pick([[[1, 2], 5], "x", [null]]);
		inputs.push(input);
	}
	for (const input of inputs) {
		const result = parseTickerDirectory(input);
		// A Map keeps insertion order; the record keeps it as entries.
		const output = result.ok ? { ok: [...result.value.entries()] } : { err: result.error };
		cases.push({ input, output: plain(output) });
	}
	const keys = ["aapl", " brk.b ", "BRK.B", "a.b.c", "", "ß", "ǆ"];
	return [cases, keys.map((input) => ({ input, output: normalizeTickerKey(input) }))];
}

async function secFinancialsSourceCases(): Promise<SecCase[]> {
	const rng = new Rng(0xfa17);
	const cases: SecCase[] = [];
	const step = (arg: string, advanceMs = 0, cancel = false): SecStep => ({
		advanceMs,
		arg,
		cancel,
	});
	const directory: ScriptEntry = { text: TICKERS };
	cases.push(await runSec("financials", UA, [step("XTESTA")], [directory, { text: FACTS_ONE }]));
	cases.push(
		await runSec(
			"financials",
			UA,
			[
				step("xtesta"),
				step("XTESTB", 100),
				step("XTESTA", 43_199_999),
				step("XTESTB", 2),
				step("XTESTB", 43_200_000),
			],
			[
				directory,
				{ text: FACTS_ONE },
				{ text: FACTS_TWO },
				{ text: FACTS_ONE },
				directory,
				{ text: FACTS_TWO },
			],
		),
	);
	cases.push(await runSec("financials", UA, [step("NOPE")], [directory]));
	cases.push(await runSec("financials", null, [step("XTESTA")], [directory]));
	cases.push(
		await runSec("financials", UA, [step("XTESTA")], [fetchError("HTTP_ERROR", "HTTP 403")]),
	);
	cases.push(
		await runSec(
			"financials",
			UA,
			[step("XTESTA")],
			[directory, fetchError("HTTP_ERROR", "HTTP 404")],
		),
	);
	cases.push(await runSec("financials", UA, [step("XTESTA")], [directory, { text: "[" }]));
	cases.push(
		await runSec(
			"financials",
			UA,
			[step("XTST-B"), step("xtst.b")],
			[directory, { text: FACTS_ONE }, { text: FACTS_ONE }],
		),
	);
	for (let index = 0; index < 160; index += 1) {
		const steps = Array.from({ length: rng.int(1, 4) }, () =>
			step(
				rng.pick(["XTESTA", "XTESTB", "XTESTA", "XTESTB", "XTESTC", "nope", "xtest-a"]),
				rng.pick([0, 5, 43_200_000, 20_000_000]),
			),
		);
		const script: ScriptEntry[] = [rng.chance(0.1) ? fetchError("TIMEOUT", "x") : directory];
		for (let item = 0; item < steps.length * 2; item += 1) {
			script.push(
				rng.chance(0.05)
					? fetchError("HTTP_ERROR", "HTTP 500")
					: rng.chance(0.3)
						? directory
						: { text: JSON.stringify(rng.chance(0.7) ? alignedFacts(rng) : randomFacts(rng)) },
			);
		}
		cases.push(await runSec("financials", rng.chance(0.9) ? UA : null, steps, script));
	}
	return cases;
}

/* ---------- files ---------- */

export async function secFiles(): Promise<{ path: string; content: unknown }[]> {
	const rng = new Rng(0x5ec);
	const [directory, tickerKeys] = directoryCases(rng) as [unknown[], unknown[]];
	return [
		{
			path: "finance/sec_client.json",
			content: { primitives: clientPrimitiveCases(), calls: await clientCases() },
		},
		{
			path: "finance/sec_13f.json",
			content: {
				urls: [
					{
						cik: "0009999993",
						accession: "0009999993-26-000004",
						submissions: secSubmissionsUrl("0009999993"),
						filing: secFilingTextUrl("0009999993", "0009999993-26-000004"),
					},
					{
						cik: "0000000042",
						accession: "0000000042-25-000001",
						submissions: secSubmissionsUrl("0000000042"),
						filing: secFilingTextUrl("0000000042", "0000000042-25-000001"),
					},
				],
				selection: selectionCases(rng),
				extraction: extractionCases(rng),
				comparisons: compareCases(rng),
			},
		},
		{ path: "finance/sec_13f_trees.json", content: treeCorpus(rng) },
		{ path: "finance/sec_13f_tables.json", content: parseCases(rng) },
		{ path: "finance/sec_13f_source.json", content: await sec13fSourceCases() },
		{
			path: "finance/sec_financials.json",
			content: {
				selection: factsCases(rng),
				directory,
				tickerKeys,
				urls: [secCompanyFactsUrl("0000320193")],
			},
		},
		{ path: "finance/sec_financials_source.json", content: await secFinancialsSourceCases() },
	];
}
