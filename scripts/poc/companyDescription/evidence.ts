import type {
	CompanyDescription,
	CompanySource,
	Evidence,
	VerifiedDescription,
} from "./template.ts";

/**
 * The evidence check: a field is shown only when every quote it gives is
 * found, word for word, in the source it names. Comparison ignores what a
 * model rewrites without changing the words — Unicode width (NFKC), curly
 * versus straight quotes and dashes, letter case and runs of whitespace —
 * and nothing else, so a paraphrase is a failure. Numbers get a second
 * rule: a stated percentage must appear in one of its quotes, and text with
 * a digit must quote something with a digit — a figure is never the model's.
 */
export function normalizeForQuote(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** The numbers written in `text` ("1,234.5" → 1234.5). */
export function numbersIn(text: string): number[] {
	const matches = text.normalize("NFKC").match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
	return matches.map((match) => Number(match.replaceAll(",", "")));
}

export type EvidenceProblem =
	| { readonly kind: "unknown-source"; readonly evidence: Evidence }
	| { readonly kind: "quote-not-found"; readonly evidence: Evidence }
	| { readonly kind: "number-not-quoted"; readonly value: number }
	| { readonly kind: "digit-without-quote" };

/** One model-written field as the check sees it. */
export interface CheckedField {
	/** Where it is in the reply: "feature", "segments[1]", "themes[0].reason". */
	readonly path: string;
	readonly problems: readonly EvidenceProblem[];
}

interface FieldToCheck {
	readonly path: string;
	readonly texts: readonly string[];
	/** Numbers the field states as data (a sales share, a margin): each must be quoted. */
	readonly numbers: readonly number[];
	readonly evidence: readonly Evidence[];
}

const DIGIT = /[0-9０-９]/;

function fieldProblems(
	field: FieldToCheck,
	sources: ReadonlyMap<string, string>,
): EvidenceProblem[] {
	const problems: EvidenceProblem[] = [];
	for (const evidence of field.evidence) {
		const normalizedSource = sources.get(evidence.source);
		if (normalizedSource === undefined) {
			problems.push({ kind: "unknown-source", evidence });
		} else if (!normalizedSource.includes(normalizeForQuote(evidence.quote))) {
			problems.push({ kind: "quote-not-found", evidence });
		}
	}
	const quoted = new Set(field.evidence.flatMap((evidence) => numbersIn(evidence.quote)));
	for (const value of field.numbers) {
		if (!quoted.has(value)) problems.push({ kind: "number-not-quoted", value });
	}
	if (
		field.texts.some((text) => DIGIT.test(text)) &&
		!field.evidence.some((evidence) => DIGIT.test(evidence.quote))
	) {
		problems.push({ kind: "digit-without-quote" });
	}
	return problems;
}

function fieldsOf(description: CompanyDescription): FieldToCheck[] {
	const statement = (
		path: string,
		item: { en: string; ja: string; evidence: readonly Evidence[] },
	): FieldToCheck => ({ path, texts: [item.en, item.ja], numbers: [], evidence: item.evidence });
	return [
		statement("feature", description.feature),
		...description.businesses.map((item, index) => statement(`businesses[${index}]`, item)),
		...description.segments.map((segment, index) => ({
			path: `segments[${index}]`,
			texts: [
				segment.name.en,
				segment.name.ja,
				...(segment.activity === null ? [] : [segment.activity.en, segment.activity.ja]),
			],
			numbers: [segment.salesSharePercent, segment.marginPercent].flatMap((value) =>
				value === null ? [] : [Math.abs(value)],
			),
			evidence: segment.evidence,
		})),
		...(description.overseasSales === null
			? []
			: [
					{
						path: "overseasSales",
						texts: [],
						numbers: [description.overseasSales.percent],
						evidence: description.overseasSales.evidence,
					},
				]),
		...description.profile.map((fact, index) => ({
			path: `profile[${index}]`,
			texts: [fact.value.en, fact.value.ja],
			numbers: [],
			evidence: fact.evidence,
		})),
		...description.themes.map((theme, index) => statement(`themes[${index}].reason`, theme.reason)),
	];
}

/** Every model-written field of a description with its problems (none = verified). */
export function checkDescription(
	description: CompanyDescription,
	sources: readonly CompanySource[],
): CheckedField[] {
	const normalized = new Map(sources.map((source) => [source.id, normalizeForQuote(source.text)]));
	return fieldsOf(description).map((field) => ({
		path: field.path,
		problems: fieldProblems(field, normalized),
	}));
}

/** One line per problem, for the repair turn and the report. */
export function describeProblems(checked: readonly CheckedField[]): string[] {
	return checked.flatMap((field) =>
		field.problems.map((problem) => {
			switch (problem.kind) {
				case "unknown-source":
					return `${field.path}: source ${problem.evidence.source} does not exist.`;
				case "quote-not-found":
					return `${field.path}: the quote "${problem.evidence.quote}" is not in ${problem.evidence.source} word for word.`;
				case "number-not-quoted":
					return `${field.path}: the number ${problem.value} is not in any of its quotes; use null when no source states it.`;
				case "digit-without-quote":
					return `${field.path}: the text has a number but no quote with a number.`;
			}
			return `${field.path}: unknown problem.`;
		}),
	);
}

/**
 * The description with every unverified field removed — what is stored and
 * what the Company tab shows. A failing feature leaves it null.
 */
export function keepVerified(
	description: CompanyDescription,
	checked: readonly CheckedField[],
): VerifiedDescription {
	const failed = new Set(
		checked.filter((field) => field.problems.length > 0).map((field) => field.path),
	);
	const ok = (path: string) => !failed.has(path);
	return {
		feature: ok("feature") ? description.feature : null,
		businesses: description.businesses.filter((_, index) => ok(`businesses[${index}]`)),
		segments: description.segments.filter((_, index) => ok(`segments[${index}]`)),
		overseasSales: ok("overseasSales") ? description.overseasSales : null,
		profile: description.profile.filter((_, index) => ok(`profile[${index}]`)),
		themes: description.themes.filter((_, index) => ok(`themes[${index}].reason`)),
	};
}
