import type { EquityFactQuery, EquityFactsResponse } from "@research/contracts";
import { recentCountWithinBudget } from "@research/domain";

/** Fits inside Chat's 2,000-character question limit, leaving room for a question.
 * The existing Lean-verified budget selector retains a contiguous prefix of
 * displayed facts. Source values are never rounded or truncated to make room.
 */
export function equityResearchSnapshot(
	issuerId: string,
	data: EquityFactsResponse,
	cutoffs: Partial<EquityFactQuery>,
): string | null {
	const facts = data.facts.map((fact) => ({
		factId: fact.factId,
		metricDefinitionId: fact.metric.metricDefinitionId,
		metric: fact.metric.metricCode,
		definition: fact.metric.definition,
		valueDecimal: fact.valueDecimal,
		unavailableReason: fact.unavailableReason,
		unit: fact.metric.unit,
		currency:
			fact.metric.unit === "currency" || fact.metric.unit === "currency-per-share"
				? fact.statement.reportingCurrency
				: null,
		period: {
			start: fact.statement.periodStart,
			end: fact.statement.periodEnd,
			kind: fact.statement.periodKind,
		},
		scope: fact.statement.scope,
		accountingStandard: fact.statement.accountingStandard,
		actualOrEstimate: fact.actualOrEstimate,
		shareBasis: fact.shareBasis,
		dimensions: fact.dimensions,
		source: {
			url: fact.document.url,
			locator: fact.sourceLocator,
			availableAt: fact.filing.publicAvailableAt,
		},
	}));
	const header = {
		issuerId,
		verification: "unverified-owner-import",
		informationCutoff: cutoffs.informationCutoff ?? null,
		ingestionCutoff: cutoffs.ingestionCutoff ?? null,
		ingestionVersion: data.ingestionVersion,
		partial: true,
		omittedDisplayedFacts: facts.length,
		facts: [],
	};
	const bytes = (value: object): number =>
		new TextEncoder().encode(JSON.stringify(value)).byteLength;
	// One extra byte allows `false` instead of `true`. The omitted count only shrinks.
	const budget = 1800 - bytes(header) - 1;
	const count = recentCountWithinBudget(
		facts.map((fact) => bytes(fact) + 1).reverse(),
		budget,
		facts.length,
	);
	if (count === 0) return null;
	return JSON.stringify({
		...header,
		partial: count < facts.length || data.nextCursor !== null,
		omittedDisplayedFacts: facts.length - count,
		facts: facts.slice(0, count),
	});
}
