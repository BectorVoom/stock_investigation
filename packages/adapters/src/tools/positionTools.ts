/**
 * Position-statistics tools (FR-007, DATA-006). Japan's margin balances and US
 * short interest are different measurements and get separate tools, labels and
 * record shapes. V1 has no licensed source for either, so in practice these
 * tools tell the model, with a stored reason, that the data is unavailable —
 * which is the point: the model must not fill the gap itself.
 *
 * `securityId` is optional because these tools do not create Security records.
 * Pass the id returned by a tool that did; otherwise a fresh id is allocated
 * and the observation is not linked to any Security.
 */
import {
	type CollectedEvidence,
	defineTool,
	EMPTY_TOOL_OUTPUT,
	type ToolContext,
	type ToolDefinition,
} from "@research/agent-core";
import type { Hasher } from "@research/application";
import { idSchema, type PositionObservation } from "@research/contracts";
import { ok, type PositionFigures, positionLabels, type Result } from "@research/domain";
import { z } from "zod";
import type {
	JpMarginBalanceSource,
	MarketDataProvenance,
	MarketDataUnavailable,
	UsShortInterestSource,
} from "../finance/marketData.ts";
import { boundModelText, collectEvidence, truncateText } from "./shared.ts";

export interface PositionToolDeps {
	readonly usShortInterest: UsShortInterestSource;
	readonly jpMarginBalance: JpMarginBalanceSource;
	readonly hasher: Hasher;
}

interface PositionReport {
	readonly figures: PositionFigures;
	readonly asOfDate: string;
	readonly disseminatedAt: string | null;
	readonly provenance: MarketDataProvenance;
}

async function positionOutput(
	hasher: Hasher,
	context: ToolContext,
	input: {
		readonly metric: PositionFigures["metric"];
		readonly subject: string;
		readonly securityId: string | undefined;
		readonly result: Result<PositionReport, MarketDataUnavailable>;
	},
) {
	const labels = positionLabels(input.metric);
	const securityId = input.securityId ?? context.nextId("sec");
	const base = {
		observationId: context.nextId("po"),
		securityId,
		jurisdiction: input.metric === "jp-margin-balance" ? "JP" : "US",
		metric: input.metric,
		metricDefinition: `${labels.heading}. ${labels.caveat}`,
		unit: "shares",
	} as const;
	const linkNote =
		input.securityId === undefined
			? " No securityId was supplied, so this observation is not linked to a Security record."
			: "";

	if (!input.result.ok) {
		const reason = truncateText(input.result.error.reason, 300);
		const observation: PositionObservation = {
			...base,
			figures: null,
			unavailableReason: reason,
			asOfDate: null,
			disseminatedAt: null,
			sourceEvidenceId: null,
		};
		return ok({
			...EMPTY_TOOL_OUTPUT,
			modelText: boundModelText([
				`${labels.heading} for ${input.subject}: UNAVAILABLE. ${reason}`,
				`${labels.caveat} Report this metric as unavailable; do not estimate or substitute another figure. Observation id: ${observation.observationId}.${linkNote}`,
			]),
			positionObservations: [observation],
		});
	}

	const report = input.result.value;
	const evidence: CollectedEvidence = await collectEvidence(hasher, {
		evidenceId: context.nextId("ev"),
		sourceUrl: report.provenance.sourceUrl,
		title: report.provenance.title,
		publisher: report.provenance.publisher,
		publishedAt: report.provenance.publishedAt,
		retrievedAt: context.nowIso(),
		effectiveAt: `${report.asOfDate}T00:00:00.000Z`,
		sourceClass: "market-data",
		retrievedText: report.provenance.retrievedText,
		// The terms of whatever source gets configured are unknown here, so no passage is stored.
		retainQuotes: false,
		excerpt: null,
	});
	const observation: PositionObservation = {
		...base,
		figures: report.figures,
		unavailableReason: null,
		asOfDate: report.asOfDate,
		disseminatedAt: report.disseminatedAt,
		sourceEvidenceId: evidence.evidence.evidenceId,
	};
	return ok({
		...EMPTY_TOOL_OUTPUT,
		modelText: boundModelText([
			`${labels.heading} for ${input.subject}, as of ${report.asOfDate}: ${JSON.stringify(report.figures)} (shares). Evidence [${evidence.evidence.evidenceId}]. Observation id: ${observation.observationId}.${linkNote}`,
			labels.caveat,
		]),
		evidence: [evidence],
		positionObservations: [observation],
	});
}

export function createPositionTools(deps: PositionToolDeps): readonly ToolDefinition[] {
	const usShortInterest = defineTool({
		toolId: "positions.us_short_interest",
		version: "1.0.0",
		description:
			"US short interest for one security (shares sold short as of a settlement date). Not comparable to Japan's margin balances. Returns an explicit 'unavailable' when no source is configured.",
		argsSchema: z.strictObject({
			ticker: z
				.string()
				.trim()
				.regex(/^[A-Za-z0-9.-]{1,12}$/),
			securityId: idSchema.optional(),
		}),
		argsHint: '{ "ticker": "<US ticker>", "securityId": "<optional id of an existing Security>" }',
		timeoutMs: 20_000,
		permission: "research-read",
		costCategory: "free",
		sideEffect: "none",
		networkAllowlist: { kind: "none" },
		async execute({ ticker, securityId }, context) {
			const symbol = ticker.toUpperCase();
			const result = await deps.usShortInterest.latestShortInterest({ ticker: symbol });
			return positionOutput(deps.hasher, context, {
				metric: "us-short-interest",
				subject: `US ticker ${symbol}`,
				securityId,
				result: result.ok
					? ok({
							figures: result.value.figures,
							asOfDate: result.value.settlementDate,
							disseminatedAt: result.value.disseminatedAt,
							provenance: result.value.provenance,
						})
					: result,
			});
		},
	});

	const jpMarginBalance = defineTool({
		toolId: "positions.jp_margin_balance",
		version: "1.0.0",
		description:
			"Japan margin trading balances (信用取引残高: margin purchase and margin sale balances) for one securities code. Not comparable to US short interest. Returns an explicit 'unavailable' when no source is configured.",
		argsSchema: z.strictObject({
			code: z
				.string()
				.trim()
				.regex(/^[0-9][0-9A-Za-z]{3}$/),
			securityId: idSchema.optional(),
		}),
		argsHint:
			'{ "code": "<4-character Japanese securities code, e.g. 7203>", "securityId": "<optional id of an existing Security>" }',
		timeoutMs: 20_000,
		permission: "research-read",
		costCategory: "free",
		sideEffect: "none",
		networkAllowlist: { kind: "none" },
		async execute({ code, securityId }, context) {
			const securitiesCode = code.toUpperCase();
			const result = await deps.jpMarginBalance.latestMarginBalance({ code: securitiesCode });
			return positionOutput(deps.hasher, context, {
				metric: "jp-margin-balance",
				subject: `Japanese securities code ${securitiesCode}`,
				securityId,
				result,
			});
		},
	});

	return [usShortInterest, jpMarginBalance];
}
