/**
 * Domain rules (crate `research-domain`): claim verification, budgets,
 * finance, market and watchlist ids, civil dates, the Google sync plan and
 * the text budgets. Expected values come from the real TypeScript in
 * `packages/domain`, run over the inputs of its unit tests plus a seeded
 * generated corpus. The Lean-proved families are replayed from
 * `formal/vectors.json` directly and are not repeated here.
 */

import {
	addDaysIso,
	excelSerialToIsoDate,
	isValidIsoDate,
} from "../../packages/domain/src/calendar/civilDate.ts";
import {
	encodeBase32Hex,
	type GoogleEventBody,
	type ManagedGoogleEvent,
	planGoogleSync,
} from "../../packages/domain/src/calendar/googleSync.ts";
import {
	type ClaimType,
	type DraftClaim,
	type EvidenceRelation,
	type EvidenceText,
	extractNumberTokens,
	isPassageOf,
	mentions,
	verifyClaims,
} from "../../packages/domain/src/evidence/verifyClaims.ts";
import { deriveCagr } from "../../packages/domain/src/finance/cagr.ts";
import {
	type DemandScenarioInput,
	deriveScenarioCagr,
} from "../../packages/domain/src/finance/demandScenario.ts";
import {
	classifyReportedPositionChange,
	describeReportedPositionChange,
} from "../../packages/domain/src/finance/filings.ts";
import { trailingPer } from "../../packages/domain/src/finance/per.ts";
import {
	jpMarginBuySellRatio,
	usDaysToCover,
} from "../../packages/domain/src/finance/positions.ts";
import {
	assessPricingPower,
	type PricingPowerInputs,
} from "../../packages/domain/src/finance/pricingPower.ts";
import {
	addUsage,
	checkBudget,
	type ResearchBudget,
	type ResourceUsage,
	summarizeCost,
	type UsageDelta,
} from "../../packages/domain/src/jobs/budget.ts";
import { decideClaim, leaseExpiryIso } from "../../packages/domain/src/jobs/lease.ts";
import { JOB_STATES } from "../../packages/domain/src/jobs/stateMachine.ts";
import { rateWindowPermit } from "../../packages/domain/src/market/rateWindow.ts";
import { parseMarketSeriesId } from "../../packages/domain/src/market/seriesId.ts";
import { recentCountWithinBudget } from "../../packages/domain/src/text/recentWithinBudget.ts";
import { truncateText } from "../../packages/domain/src/text/truncate.ts";
import { parseStockId } from "../../packages/domain/src/watchlist/stockId.ts";
import {
	doubleBits,
	randomDouble,
	seededRandom,
	type VectorExporter,
	type VectorFile,
	wellFormed,
} from "./shared.ts";

type Random = () => number;

const pick = <T>(random: Random, items: readonly T[]): T => {
	const item = items[Math.floor(random() * items.length)];
	if (item === undefined) throw new Error("pick from an empty list");
	return item;
};
const integer = (random: Random, max: number): number => Math.floor(random() * (max + 1));

/**
 * Text fragments that exercise the JavaScript-vs-Rust differences of
 * normalisation: NFKC compatibility forms, full-width and other-script
 * digits, special casing, JS whitespace (U+FEFF yes, U+0085 no), astral
 * characters and thousands separators.
 */
const FRAGMENTS = [
	"Revenue",
	"revenue",
	"REVENUE",
	"ＲＥＶＥＮＵＥ",
	"rose",
	"fell",
	" ",
	"  ",
	"\t",
	"\n",
	"\r\n",
	" ",
	"　",
	"﻿",
	"\u0085",
	" ",
	"​",
	"12",
	"１２",
	"1,234",
	"1,234.5",
	"3.14",
	"0.5%",
	"2027",
	"٣٤",
	"①",
	"½",
	"Ⅻ",
	"㎏",
	"ﬁ",
	"İstanbul",
	"ΑΣ",
	"σ",
	"ß",
	"ǅ",
	"é",
	"é",
	"😀",
	"𝟏𝟐",
	"日本語",
	"売上高は１２３４億円",
	"percent",
	"year on year",
	".",
	",",
	",,",
	"..5",
	"-",
	"Example Corp",
	"according to the filing",
];

function randomText(random: Random, maxPieces: number): string {
	const pieces = integer(random, maxPieces);
	let text = "";
	for (let index = 0; index < pieces; index += 1) text += pick(random, FRAGMENTS);
	return text;
}

/** A quote taken from `text` (sometimes re-cased or re-spaced), or a random one. */
function quoteFrom(random: Random, text: string): string {
	const roll = random();
	if (roll < 0.15) return randomText(random, 4);
	const chars = [...text];
	const start = integer(random, chars.length);
	const end = start + integer(random, chars.length - start);
	let quote = chars.slice(start, end).join("");
	if (roll < 0.35) quote = quote.toUpperCase();
	else if (roll < 0.5) quote = quote.replace(/ /g, "  \t");
	else if (roll < 0.6) quote = ` ${quote}　`;
	return quote;
}

const TEST_EVIDENCE: readonly EvidenceText[] = [
	{
		evidenceId: "ev_earnings",
		retrievedText:
			"Example Corp FY2025 results. Example Corp reported revenue of 1,234 million yen, up 12% year on year, driven by strong demand.",
	},
	{
		evidenceId: "ev_analyst",
		retrievedText: "Analysts warn that demand may fall as subsidies expire in 2027.",
	},
	{
		evidenceId: "ev_listing",
		retrievedText: "Example Corp is listed on the Tokyo Stock Exchange.",
	},
	{ evidenceId: "ev_fullwidth", retrievedText: "ＲＥＶＥＮＵＥ ＲＯＳＥ　１２％ year on year" },
];

const CLAIM_TYPES: readonly ClaimType[] = ["observation", "inference", "hypothesis", "forecast"];
const RELATIONS: readonly EvidenceRelation[] = ["supports", "contradicts", "context"];

function testClaims(): DraftClaim[] {
	const link = (evidenceId: string, relation: EvidenceRelation, quote: string | null) => ({
		evidenceId,
		relation,
		quote,
	});
	const claim = (
		text: string,
		links: DraftClaim["links"],
		claimType: ClaimType = "observation",
	) => ({
		claimId: `cl_${text.length}_${links.length}`,
		text,
		claimType,
		links,
	});
	return [
		claim("Example Corp revenue rose 12% year on year.", [
			link("ev_earnings", "supports", "up 12% year on year"),
		]),
		claim("Revenue rose 12%.", [link("ev_earnings", "supports", "  UP 12%\n YEAR on year ")]),
		claim("Revenue rose 12%.", [link("ev_fullwidth", "supports", "revenue rose 12%")]),
		claim("Example Corp is listed in Tokyo.", [
			link("ev_listing", "context", null),
			link("ev_earnings", "supports", "reported revenue of 1,234 million yen"),
		]),
		claim("Revenue rose.", [link("ev_invented", "supports", "anything at all here")]),
		claim("Revenue rose.", [link("ev_earnings", "supports", "revenue fell sharply in 2025")]),
		claim("Revenue rose.", [link("ev_analyst", "supports", "up 12% year on year")]),
		claim("Revenue rose.", [link("ev_earnings", "supports", "up 12% ... driven by strong demand")]),
		claim("Revenue rose.", [link("ev_earnings", "supports", null)]),
		claim("Revenue rose.", [link("ev_earnings", "supports", " \t ")]),
		claim("Demand may fall.", [
			link("ev_earnings", "supports", "up 12% year on year"),
			link("ev_analyst", "contradicts", null),
		]),
		claim("Example Corp revenue rose.", []),
		claim("Example Corp revenue rose 21% year on year.", [
			link("ev_earnings", "supports", "up 12% year on year"),
		]),
		claim("Revenue was 1,234 million yen, up 15%, with a 9.5% margin.", [
			link("ev_earnings", "supports", "up 12% year on year"),
		]),
		claim("Revenue was 1234 million yen, up 12%.", [
			link("ev_earnings", "supports", "revenue of 1,234 million yen"),
		]),
		claim("Subsidies expire in 2027 and revenue rose 12%.", [
			link("ev_earnings", "supports", "up 12% year on year"),
			link("ev_analyst", "supports", "subsidies expire next year"),
		]),
		claim("Revenue rose 12% and subsidies run to 2027.", [
			link("ev_earnings", "supports", "up 12% year on year"),
			link("ev_analyst", "contradicts", "subsidies expire in 2027"),
		]),
		claim(
			"Demand could reach 40 GWh by 2030, a 25% CAGR.",
			[link("ev_earnings", "supports", "driven by strong demand")],
			"forecast",
		),
		claim(
			"Demand could reach 40 GWh by 2030.",
			[link("ev_earnings", "supports", "driven by strong demand")],
			"hypothesis",
		),
		claim("Demand for Example Corp products will keep growing.", [], "forecast"),
		claim("Revenue rose 12% but demand may fall.", [
			link("ev_earnings", "supports", "up 12% year on year"),
			link("ev_analyst", "contradicts", "demand may fall as subsidies expire"),
		]),
		claim("Demand may fall.", [link("ev_analyst", "contradicts", "demand may fall as subsidies")]),
		claim("Revenue rose 12%.", [
			link("ev_earnings", "supports", "up 12% year on year"),
			link("ev_analyst", "contradicts", "a fabricated contradiction"),
		]),
		claim("Revenue rose 12%.", [link("ev_earnings", "supports", "up 12%")]),
		claim("Revenue rose 12%.", [link("ev_earnings", "context", "up 12%")]),
		claim("Revenue rose 12%.", [
			link("ev_earnings", "supports", "up 12% year on year"),
			link("ev_ghost", "supports", "up 12% year on year"),
			link("ev_analyst", "context", null),
			link("ev_analyst", "supports", "not in the analyst note at all"),
			link("ev_listing", "context", "listed on the Tokyo Stock Exchange"),
		]),
	];
}

function generatedVerification(random: Random) {
	const cases: { claims: DraftClaim[]; evidence: EvidenceText[] }[] = [];
	for (let caseIndex = 0; caseIndex < 300; caseIndex += 1) {
		const evidence: EvidenceText[] = [];
		const evidenceCount = 1 + integer(random, 5);
		for (let index = 0; index < evidenceCount; index += 1) {
			// Repeated ids are allowed: the last text wins, as in a JS Map.
			const id = `ev${integer(random, evidenceCount)}`;
			evidence.push({ evidenceId: id, retrievedText: wellFormed(randomText(random, 30)) });
		}
		const claims: DraftClaim[] = [];
		const claimCount = integer(random, 10);
		for (let index = 0; index < claimCount; index += 1) {
			const links: DraftClaim["links"][number][] = [];
			const linkCount = integer(random, 4);
			for (let linkIndex = 0; linkIndex < linkCount; linkIndex += 1) {
				const target = random() < 0.1 ? null : pick(random, evidence);
				const quote =
					random() < 0.15 ? null : wellFormed(quoteFrom(random, target?.retrievedText ?? ""));
				links.push({
					evidenceId: target?.evidenceId ?? "ev_missing",
					relation: pick(random, RELATIONS),
					quote,
				});
			}
			const source = pick(random, evidence).retrievedText;
			const text = random() < 0.5 ? quoteFrom(random, source) : randomText(random, 10);
			claims.push({
				claimId: `cl${index}`,
				text: wellFormed(text),
				claimType: pick(random, CLAIM_TYPES),
				links,
			});
		}
		cases.push({ claims, evidence });
	}
	return cases;
}

function verificationFile(): VectorFile {
	const random = seededRandom(2026_10_17);
	const verifyCases = [
		{ claims: testClaims(), evidence: [...TEST_EVIDENCE] },
		...generatedVerification(random),
	];
	const texts: string[] = [
		"Revenue was 1,234.5 million, up 12%.",
		"売上高は１２３４億円",
		"no figures here",
		"",
		"1.2.3 and 4,5,6. and 7,.8",
		"٣ ①②③ ½ 𝟏𝟐 ¹²",
	];
	for (let index = 0; index < 1500; index += 1) texts.push(wellFormed(randomText(random, 12)));
	const passages: { quote: string; text: string }[] = [
		{
			quote: "supplies cathodes to battery",
			text: "Example Corp supplies   cathodes to Battery Inc.",
		},
		{ quote: "cathodes", text: "Example Corp supplies cathodes." },
		{ quote: "ＲＥＶＥＮＵＥ ＲＯＳＥ", text: "revenue rose" },
		{ quote: "İSTANBUL OFFICE", text: "the i̇stanbul office opened" },
	];
	for (let index = 0; index < 1500; index += 1) {
		const text = wellFormed(randomText(random, 20));
		passages.push({ quote: wellFormed(quoteFrom(random, text)), text });
	}
	return {
		path: "domain/verify.json",
		content: {
			extractNumberTokens: texts.map((input) => ({ input, output: extractNumberTokens(input) })),
			isPassageOf: passages.map(({ quote, text }) => ({
				quote,
				text,
				output: isPassageOf(quote, text),
			})),
			mentions: passages.map(({ quote, text }) => ({
				text,
				phrase: quote,
				output: mentions(text, quote),
			})),
			verifyClaims: verifyCases.map(({ claims, evidence }) => ({
				claims,
				evidence,
				output: verifyClaims(claims, evidence),
			})),
		},
	};
}

/* ----- Budgets ----- */

/** A double that is usually an ordinary cost and sometimes hostile. */
function costDouble(random: Random): number {
	const roll = random();
	if (roll < 0.1) return pick(random, [Number.NaN, Number.POSITIVE_INFINITY, -1, -0, 0, -0.01]);
	if (roll < 0.2) return randomDouble(random);
	return Math.round(random() * 1_000_000) / 10 ** integer(random, 6);
}

type WireCost = { readonly kind: "absent" } | { readonly kind: "null" } | { readonly usd: string };

function randomDelta(random: Random): {
	delta: UsageDelta;
	wire: { steps: number; tools: number; bytes: number; cost: WireCost };
} {
	const steps = random() < 0.5 ? 0 : integer(random, 3);
	const tools = random() < 0.5 ? 0 : integer(random, 3);
	const bytes = random() < 0.5 ? 0 : integer(random, 200_000);
	const roll = random();
	if (roll < 0.3) {
		return {
			delta: { agentSteps: steps, toolCalls: tools, inputBytes: bytes },
			wire: { steps, tools, bytes, cost: { kind: "absent" } },
		};
	}
	if (roll < 0.45) {
		return {
			delta: { agentSteps: steps, toolCalls: tools, inputBytes: bytes, costUsd: null },
			wire: { steps, tools, bytes, cost: { kind: "null" } },
		};
	}
	const cost = costDouble(random);
	return {
		delta: { agentSteps: steps, toolCalls: tools, inputBytes: bytes, costUsd: cost },
		wire: { steps, tools, bytes, cost: { usd: doubleBits(cost) } },
	};
}

function usageWire(usage: ResourceUsage) {
	return {
		agentSteps: usage.agentSteps,
		toolCalls: usage.toolCalls,
		inputBytes: usage.inputBytes,
		knownCostUsd: doubleBits(usage.knownCostUsd),
		hasUnmeteredUsage: usage.hasUnmeteredUsage,
	};
}

function budgetFile(): VectorFile {
	const random = seededRandom(1_234_567);
	const cases = [];
	for (let index = 0; index < 1500; index += 1) {
		const budget: ResearchBudget = {
			maxAgentSteps: 1 + integer(random, 11),
			maxToolCalls: integer(random, 60),
			maxWallClockMs: 30_000 + integer(random, 1_770_000),
			maxInputBytes: 10_000 + integer(random, 1_990_000),
			maxSpendUsd: random() < 0.3 ? null : Math.round(random() * 5000) / 100,
		};
		let usage: ResourceUsage = {
			agentSteps: integer(random, 12),
			toolCalls: integer(random, 60),
			inputBytes: integer(random, 2_000_000),
			knownCostUsd: random() < 0.3 ? 0 : Math.round(random() * 5000) / 100,
			hasUnmeteredUsage: random() < 0.2,
		};
		const start = usageWire(usage);
		const steps = [];
		for (let step = 0; step < 1 + integer(random, 3); step += 1) {
			const { delta, wire } = randomDelta(random);
			const elapsedMs = integer(random, 2_000_000);
			const checked = checkBudget(budget, usage, elapsedMs, delta);
			usage = addUsage(usage, delta);
			steps.push({
				delta: wire,
				elapsedMs,
				limit: checked.ok ? null : checked.error,
				after: usageWire(usage),
				cost: (() => {
					const summary = summarizeCost(usage);
					return {
						status: summary.status,
						totalCostUsd: summary.totalCostUsd === null ? null : doubleBits(summary.totalCostUsd),
						meteredPortionUsd: doubleBits(summary.meteredPortionUsd),
					};
				})(),
			});
		}
		cases.push({
			budget: {
				...budget,
				maxSpendUsd: budget.maxSpendUsd === null ? null : doubleBits(budget.maxSpendUsd),
			},
			usage: start,
			steps,
		});
	}
	return { path: "domain/budget.json", content: cases };
}

/* ----- Finance ----- */

function financeDouble(random: Random): number {
	const roll = random();
	if (roll < 0.08)
		return pick(random, [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			0,
			-0,
			1e-300,
			1e300,
			5e-324,
		]);
	if (roll < 0.15) return randomDouble(random);
	if (roll < 0.3) return -random() * 100;
	return Math.round(random() * 10_000_000) / 10 ** integer(random, 4);
}

const optionalBits = (value: number | null): string | null =>
	value === null ? null : doubleBits(value);

function financeFile(): VectorFile {
	const random = seededRandom(424_242);
	const cagr = [];
	const fixed: [number, number, number, number][] = [
		[100, 200, 2020, 2025],
		[100, 100, 2024, 2027],
		[1e-300, 1e300, 2020, 2023],
		[1, 0, 2020, 2023],
		[0, 1, 2020, 2023],
		[1, -1, 2020, 2023],
		[1, 1, 2020.5, 2023],
		[1, 1, 2023, 2023],
		[Number.NaN, 1, 2020, 2023],
		[5e-324, 1.7976931348623157e308, 2020, 2021],
	];
	for (const [base, target, baseYear, targetYear] of fixed) {
		const result = deriveCagr(base, target, baseYear, targetYear);
		cagr.push({
			inputs: [base, target, baseYear, targetYear].map(doubleBits),
			ok: result.ok ? doubleBits(result.value) : null,
			error: result.ok ? null : result.error,
		});
	}
	for (let index = 0; index < 3000; index += 1) {
		const baseYear = random() < 0.9 ? 2015 + integer(random, 15) : financeDouble(random);
		const targetYear = random() < 0.9 ? baseYear + integer(random, 8) - 1 : financeDouble(random);
		const base = financeDouble(random);
		const target = random() < 0.5 ? base * (0.2 + random() * 5) : financeDouble(random);
		const result = deriveCagr(base, target, baseYear, targetYear);
		cagr.push({
			inputs: [base, target, baseYear, targetYear].map(doubleBits),
			ok: result.ok ? doubleBits(result.value) : null,
			error: result.ok ? null : result.error,
		});
	}

	const scenarios = [];
	const list = (count: number) => Array.from({ length: count }, (_, index) => `item ${index}`);
	for (let index = 0; index < 1500; index += 1) {
		const baseYear = 2020 + integer(random, 8);
		const value = () => (random() < 0.08 ? financeDouble(random) : 50 + random() * 200);
		const scenarioCase = () => ({
			targetValue: value(),
			assumptions: list(random() < 0.1 ? 0 : 1 + integer(random, 2)),
		});
		const input: DemandScenarioInput = {
			productOrService: "Grid storage",
			quantityKind: pick(random, ["unit-demand", "revenue", "price"] as const),
			unit: pick(random, ["GWh", "", " ", "﻿", "\u0085", "units"]),
			baseYear,
			targetYear: random() < 0.9 ? baseYear + integer(random, 7) : baseYear + 3.5,
			baselineValue: random() < 0.2 ? null : value(),
			bear: scenarioCase(),
			base: scenarioCase(),
			bull: scenarioCase(),
			drivers: list(random() < 0.1 ? 0 : 1),
			barriers: list(integer(random, 1)),
			falsifiers: list(random() < 0.1 ? 0 : 1),
			methodology: pick(random, ["Bottom-up", "", "\t", "x"]),
		};
		const result = deriveScenarioCagr(input);
		scenarios.push({
			input: {
				...input,
				baseYear: doubleBits(input.baseYear),
				targetYear: doubleBits(input.targetYear),
				baselineValue: optionalBits(input.baselineValue),
				bear: { ...input.bear, targetValue: doubleBits(input.bear.targetValue) },
				base: { ...input.base, targetValue: doubleBits(input.base.targetValue) },
				bull: { ...input.bull, targetValue: doubleBits(input.bull.targetValue) },
			},
			ok: result.ok
				? {
						bear: optionalBits(result.value.bear),
						base: optionalBits(result.value.base),
						bull: optionalBits(result.value.bull),
					}
				: null,
			errors: result.ok ? null : result.error,
		});
	}

	const pricing = [];
	for (let index = 0; index < 2000; index += 1) {
		const maybe = () =>
			random() < 0.25 ? null : random() < 0.1 ? financeDouble(random) : (random() - 0.4) * 30;
		const inputs: PricingPowerInputs = {
			revenueGrowthPct: maybe(),
			priceRealizationPct: maybe(),
			volumeGrowthPct: maybe(),
			mixEffectPct: maybe(),
			fxEffectPct: maybe(),
			inputCostChangePct: maybe(),
			grossMarginChangeBps: maybe(),
			operatingMarginChangeBps: maybe(),
			managementCommentaryEvidenceIds: random() < 0.5 ? [] : ["ev1"],
		};
		const output = assessPricingPower(inputs);
		pricing.push({
			inputs: {
				revenueGrowthPct: optionalBits(inputs.revenueGrowthPct),
				priceRealizationPct: optionalBits(inputs.priceRealizationPct),
				volumeGrowthPct: optionalBits(inputs.volumeGrowthPct),
				mixEffectPct: optionalBits(inputs.mixEffectPct),
				fxEffectPct: optionalBits(inputs.fxEffectPct),
				inputCostChangePct: optionalBits(inputs.inputCostChangePct),
				grossMarginChangeBps: optionalBits(inputs.grossMarginChangeBps),
				operatingMarginChangeBps: optionalBits(inputs.operatingMarginChangeBps),
				managementCommentaryEvidenceIds: inputs.managementCommentaryEvidenceIds,
			},
			output: {
				...output,
				unexplainedRevenueResidualPct: optionalBits(output.unexplainedRevenueResidualPct),
			},
		});
	}

	const shares = [
		null,
		0,
		-0,
		-5,
		5,
		10,
		1e300,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		5.000000000000001,
	];
	const positionChanges = shares.flatMap((previous) =>
		shares.map((current) => {
			const change = classifyReportedPositionChange(previous, current);
			return {
				previous: optionalBits(previous),
				current: optionalBits(current),
				change,
				description: describeReportedPositionChange(change, {
					investorName: "Fund — Ünïcode",
					issuerName: "Example Corp",
					reportPeriodEnd: "2026-06-30",
					filedAt: "2026-08-14",
					form: "13F-HR",
				}),
			};
		}),
	);

	const ratios = [];
	for (let index = 0; index < 600; index += 1) {
		const numerator = financeDouble(random);
		const denominator = random() < 0.1 ? 0 : financeDouble(random);
		const volume = random() < 0.1 ? null : denominator;
		const jp = jpMarginBuySellRatio({
			jurisdiction: "JP",
			metric: "jp-margin-balance",
			marginBuyBalanceShares: numerator,
			marginSellBalanceShares: denominator,
		});
		const us = usDaysToCover({
			jurisdiction: "US",
			metric: "us-short-interest",
			reportedShortInterestShares: numerator,
			averageDailyVolumeShares: volume,
		});
		const per = trailingPer(numerator, denominator);
		ratios.push({
			numerator: doubleBits(numerator),
			denominator: doubleBits(denominator),
			volume: optionalBits(volume),
			jp: jp.ok ? { ok: doubleBits(jp.value) } : { error: jp.error },
			us: us.ok ? { ok: doubleBits(us.value) } : { error: us.error },
			per: per.ok ? { ok: doubleBits(per.value) } : { error: per.error },
		});
	}
	return {
		path: "domain/finance.json",
		content: { cagr, scenarios, pricing, positionChanges, ratios },
	};
}

/* ----- Text, ids, dates, sync plan, leases ----- */

function miscFile(): VectorFile {
	const random = seededRandom(77_001);
	const truncateInputs = [
		"",
		"short",
		"abcde",
		"😀😀",
		"abcdefghij",
		"abcdef",
		"abcdefg",
		"a😀b",
		"😀".repeat(10),
		"a😀b😀c",
		"hello",
		"😀hi",
	];
	for (let index = 0; index < 300; index += 1)
		truncateInputs.push(wellFormed(randomText(random, 8)));
	const truncate = truncateInputs.flatMap((input) =>
		[0, 1, 2, 3, 4, 5, 6, 10, 40].map((max) => ({ input, max, output: truncateText(input, max) })),
	);

	const recent = [];
	for (let index = 0; index < 1000; index += 1) {
		const sizes = Array.from({ length: integer(random, 8) }, () => integer(random, 600));
		const budget = integer(random, 2400);
		const maxItems = integer(random, 8);
		recent.push({
			sizes,
			budget,
			maxItems,
			count: recentCountWithinBudget(sizes, budget, maxItems),
		});
	}

	const seriesInputs = [
		"fred:VIXCLS",
		"fred:vixcls",
		"fred:",
		`fred:${"A".repeat(25)}`,
		`fred:${"A".repeat(26)}`,
		":VIX",
		"VIX",
		"",
		"twelve-data:AAPL",
		"twelve-data:7203:XTKS",
		"twelve-data:BRK.B",
		"twelve-data:BRK/B",
		"twelve-data:.A",
		"twelve-data:A:B",
		"twelve-data:A:BB:CC",
		`twelve-data:${"A".repeat(20)}`,
		`twelve-data:${"A".repeat(21)}`,
		`twelve-data:A:${"B".repeat(10)}`,
		`twelve-data:A:${"B".repeat(11)}`,
		"twelve-data:ＡＡＰＬ",
		"twelve-data:AAPL\n",
		"other:AAPL",
		"Fred:VIX",
		"fred:VIX:CLS",
	];
	const stockInputs = [
		"us:AAPL",
		"us:BRK.B",
		"us:BRK-B",
		"us:A",
		`us:${"A".repeat(10)}`,
		`us:${"A".repeat(11)}`,
		"us:1AB",
		"us:aapl",
		"jp:7203",
		"jp:130A",
		"jp:A130",
		"jp:72030",
		"jp:720",
		"jp:72a3",
		"US:AAPL",
		":AAPL",
		"us:",
		"uk:VOD",
		"us:AAPL:X",
		"jp:７２０３",
		"us:AAPL\n",
	];
	const alphabet = "abfjpstuwyxz:-.AJPSUVXB0123456789/é";
	for (let index = 0; index < 600; index += 1) {
		const length = integer(random, 16);
		let text = random() < 0.5 ? pick(random, ["fred:", "twelve-data:", "us:", "jp:"]) : "";
		for (let char = 0; char < length; char += 1) text += pick(random, [...alphabet]);
		(index % 2 === 0 ? seriesInputs : stockInputs).push(text);
	}
	const series = seriesInputs.map((input) => {
		const parsed = parseMarketSeriesId(input);
		return { input, output: parsed.ok ? parsed.value : null };
	});
	const stocks = stockInputs.map((input) => {
		const parsed = parseStockId(input);
		return { input, output: parsed.ok ? parsed.value : null };
	});

	const rate = [];
	for (let index = 0; index < 1000; index += 1) {
		const grants = Array.from(
			{ length: integer(random, 6) },
			() => integer(random, 20_000) - 5_000,
		);
		const now = integer(random, 15_000);
		const maxPer = integer(random, 4);
		const window = integer(random, 12_000);
		const permit = rateWindowPermit(grants, now, maxPer, window);
		rate.push({
			grants,
			now,
			maxPer,
			window,
			retryAfter: permit.allowed ? null : permit.retryAfterMs,
		});
	}

	const dateInputs = [
		"2024-02-29",
		"2023-02-29",
		"2026-02-30",
		"2026-13-01",
		"2026-00-10",
		"2026-01-00",
		"0050-01-01",
		"0099-12-31",
		"0100-01-01",
		"9999-12-31",
		"2026-1-01",
		"２０２６-01-01",
		"2026-01-01T00:00:00Z",
		" 2026-01-01",
		"",
		"1900-02-29",
		"2000-02-29",
		"2100-02-29",
	];
	for (let index = 0; index < 400; index += 1) {
		const year = String(integer(random, 9999)).padStart(4, "0");
		const month = String(integer(random, 13)).padStart(2, "0");
		const day = String(integer(random, 32)).padStart(2, "0");
		dateInputs.push(`${year}-${month}-${day}`);
	}
	const shifts = [
		0,
		1,
		-1,
		0.5,
		365,
		-36500,
		3_000_000,
		-3_000_000,
		1e9,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-0,
	];
	const dates = dateInputs.map((input) => ({
		input,
		valid: isValidIsoDate(input),
		shifted: shifts.map((days) => {
			const result = addDaysIso(input, days);
			return {
				days: doubleBits(days),
				output: result.ok ? result.value : null,
				error: result.ok ? null : result.error,
			};
		}),
	}));
	const serialInputs = [60, 61, 62, 2958465, 2958466, 46331, 46331.5, Number.NaN, -1, 0];
	for (let index = 0; index < 300; index += 1) serialInputs.push(integer(random, 3_000_000));
	const serials = serialInputs.map((serial) => {
		const result = excelSerialToIsoDate(serial);
		return { serial: doubleBits(serial), output: result.ok ? result.value : null };
	});

	const base32 = [];
	for (let index = 0; index < 200; index += 1) {
		const bytes = Array.from({ length: 5 * integer(random, 5) + (random() < 0.1 ? 1 : 0) }, () =>
			integer(random, 255),
		);
		const result = encodeBase32Hex(bytes);
		base32.push({ bytes, output: result.ok ? result.value : null });
	}

	const idPool = ["a", "b", "0v", "s1", "s10", "s2", "\u{FF21}", "\u{1F600}", "\u{E000}", "é"];
	const sync = [];
	for (let index = 0; index < 400; index += 1) {
		const desired: GoogleEventBody[] = [];
		for (const id of idPool) {
			if (random() < 0.4) {
				const fp = integer(random, 2);
				desired.push({
					id,
					summary: `fp-${fp}`,
					description: `desc-${fp}`,
					startDate: "2026-10-29",
					endDate: random() < 0.9 ? "2026-10-30" : "2026-10-31",
					privateProperties: {
						researchWorkspace: "earnings",
						stockId: "us:AAPL",
						periodKey: "2026-q4",
					},
					sourceTitle: "Finnhub",
					sourceUrl: "https://finnhub.io/",
				});
			}
		}
		if (random() < 0.05 && desired[0] !== undefined) desired.push(desired[0]);
		const existing: ManagedGoogleEvent[] = [];
		for (const id of idPool) {
			if (random() < 0.4) {
				const fp = integer(random, 2);
				existing.push({
					id,
					status: random() < 0.2 ? "cancelled" : "confirmed",
					startDate: "2026-10-29",
					endDate: "2026-10-30",
					summary: `fp-${fp}`,
					description: `desc-${fp}`,
				});
			}
		}
		// Arrival order is arbitrary; the plan's order must not depend on it.
		desired.sort(() => random() - 0.5);
		existing.sort(() => random() - 0.5);
		const plan = planGoogleSync(desired, existing);
		sync.push({
			desired,
			existing,
			output: plan.ok
				? {
						inserts: plan.value.inserts.map((body) => body.id),
						updates: plan.value.updates.map((body) => body.id),
						deletes: plan.value.deletes,
						unchanged: plan.value.unchanged,
					}
				: null,
		});
	}

	const nowMs = Date.parse("2026-10-11T00:00:00.000Z");
	const expiries = [
		null,
		"2026-10-10T23:59:00.000Z",
		"2026-10-11T00:00:00.000Z",
		"2026-10-11T00:00:00.001Z",
		"garbage",
		"2026-02-30T00:00:00.000Z",
	];
	const claims = JOB_STATES.flatMap((state) =>
		expiries.flatMap((leaseExpiresAt) =>
			[0, 2, 3].map((attempt) => ({
				state,
				leaseExpiresAt,
				attempt,
				decision: decideClaim(
					{
						state,
						leaseGeneration: 4,
						leaseOwnerId: "runner-1",
						leaseExpiresAt,
						attempt,
						maxAttempts: 3,
						cancelRequested: false,
					},
					nowMs,
				),
			})),
		),
	);
	const expiryIso = [0, 1, 999, 86_399_999, nowMs, 253_402_300_799_999].map((ms) => ({
		ms,
		output: leaseExpiryIso(ms, 0),
	}));
	return {
		path: "domain/misc.json",
		content: {
			truncate,
			recent,
			series,
			stocks,
			rate,
			dates,
			serials,
			base32,
			sync,
			claims,
			expiryIso,
		},
	};
}

/** `Math.pow`, `Math.exp` and `Math.log` (`research_js::math`). */
function mathFile(): VectorFile {
	const random = seededRandom(31_337);
	const special = [
		0,
		-0,
		1,
		-1,
		0.5,
		2,
		3,
		-3,
		1e-310,
		5e-324,
		1e308,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Math.E,
		709.79,
		-745.2,
		1e-9,
	];
	const pairs: [number, number][] = [];
	for (const x of special) for (const y of special) pairs.push([x, y]);
	for (let index = 0; index < 4000; index += 1) {
		const x = random() < 0.1 ? randomDouble(random) : Math.exp((random() - 0.5) * 60);
		const y =
			random() < 0.1
				? randomDouble(random)
				: random() < 0.3
					? 1 / (1 + integer(random, 7))
					: (random() - 0.5) * 8;
		pairs.push([x, y]);
	}
	return {
		path: "domain/math.json",
		content: pairs.map(([x, y]) => ({
			x: doubleBits(x),
			y: doubleBits(y),
			pow: doubleBits(x ** y),
			exp: doubleBits(Math.exp(y)),
			log: doubleBits(Math.log(x)),
		})),
	};
}

export const domainExporter: VectorExporter = {
	name: "domain",
	async build() {
		return [verificationFile(), budgetFile(), financeFile(), miscFile(), mathFile()];
	},
};
