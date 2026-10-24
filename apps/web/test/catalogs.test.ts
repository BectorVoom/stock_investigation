import { catalogProblems, LOCALES } from "@research/i18n";
import { describe, expect, it } from "vitest";

/**
 * Every translation catalog of the UI (ADR-0032), found by name so a new one
 * is checked without registering it here.
 */
const CATALOG_MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
	...import.meta.glob("../src/**/*.messages.{ts,tsx}", { eager: true }),
	...import.meta.glob("../../../packages/ui-registry/src/**/*.messages.{ts,tsx}", { eager: true }),
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An English text of two or more words that another language copies unchanged. */
const ENGLISH_SENTENCE = /[A-Za-z]{2,}\s+[a-z]{2,}/;

function untranslatedCopies(catalog: Readonly<Record<string, unknown>>): string[] {
	const english = catalog.en;
	if (!isRecord(english)) return [];
	const problems: string[] = [];
	for (const locale of LOCALES) {
		if (locale === "en") continue;
		const table = catalog[locale];
		if (!isRecord(table)) continue;
		for (const [key, value] of Object.entries(english)) {
			const translated = table[key];
			if (typeof value === "string" && value === translated && ENGLISH_SENTENCE.test(value)) {
				problems.push(`${locale}.${key} copies the English text "${value}"`);
			}
		}
	}
	return problems;
}

describe("translation catalogs", () => {
	const entries = Object.entries(CATALOG_MODULES).flatMap(([file, module]) =>
		Object.entries(module).map(([name, catalog]) => ({ file, name, catalog })),
	);

	it("exist", () => {
		expect(entries.length).toBeGreaterThan(0);
	});

	it.each(
		entries.map((entry) => [`${entry.file} ${entry.name}`, entry] as const),
	)("%s is complete in every language", (_label, entry) => {
		// A `*.messages` module exports catalogs and nothing else.
		const catalog = entry.catalog;
		if (!isRecord(catalog)) throw new Error(`${entry.name} is not a catalog`);
		expect([...catalogProblems(catalog), ...untranslatedCopies(catalog)]).toEqual([]);
	});
});
