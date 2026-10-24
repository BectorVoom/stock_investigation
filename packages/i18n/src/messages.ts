import { DEFAULT_LOCALE, LOCALES, type Locale } from "./locales.ts";

/**
 * A message is fixed text or a function of its parameters (counts, names,
 * elements to place in the sentence), so each language orders the words
 * itself and chooses its own plural forms. A function's return type is the
 * catalog's choice: text for most, a Solid element where a sentence holds a
 * link or a button.
 */
export type Message = string | ((...args: never[]) => unknown);

export type MessageTable = { readonly [key: string]: Message };

/** One table per supported language, all with the same keys and parameter types. */
export type Translations<T extends MessageTable> = { readonly [L in Locale]: T };

/**
 * Declares a catalog. The English table fixes the keys and every function's
 * parameters; each other language must supply the same keys with the same
 * types, so a missing or misspelled translation is a compile error.
 */
export function defineMessages<T extends MessageTable>(
	translations: { readonly en: T } & { readonly [L in Exclude<Locale, "en">]: NoInfer<T> },
): Translations<T> {
	return translations;
}

/**
 * Problems a type cast could hide from the compiler: a key one language
 * lacks or adds, a text in one language that is a function in another (or a
 * function with a different number of parameters), an empty text. Run over
 * every catalog by the catalog test; an empty list means the catalog is whole.
 */
export function catalogProblems(translations: Readonly<Record<string, unknown>>): string[] {
	const problems: string[] = [];
	const languages = Object.keys(translations);
	for (const locale of LOCALES) {
		if (!languages.includes(locale)) problems.push(`missing language ${locale}`);
	}
	for (const language of languages) {
		if (!(LOCALES as readonly string[]).includes(language)) {
			problems.push(`unsupported language ${language}`);
		}
	}
	const source = tableOf(translations[DEFAULT_LOCALE]);
	if (source === null) return [...problems, `${DEFAULT_LOCALE} is not a message table`];
	for (const locale of LOCALES) {
		const table = tableOf(translations[locale]);
		if (table === null) {
			problems.push(`${locale} is not a message table`);
			continue;
		}
		for (const [key, value] of Object.entries(table)) {
			if (!(key in source)) problems.push(`${locale}.${key} is not in ${DEFAULT_LOCALE}`);
			if (value === "") problems.push(`${locale}.${key} is empty`);
		}
		for (const [key, value] of Object.entries(source)) {
			if (!(key in table)) {
				problems.push(`${locale}.${key} is missing`);
				continue;
			}
			const translated = table[key];
			if (typeof value !== typeof translated) {
				problems.push(
					`${locale}.${key} is a ${typeof translated}, ${DEFAULT_LOCALE} a ${typeof value}`,
				);
			} else if (
				typeof value === "function" &&
				typeof translated === "function" &&
				value.length !== translated.length
			) {
				problems.push(
					`${locale}.${key} takes ${translated.length} parameters, ${DEFAULT_LOCALE} ${value.length}`,
				);
			}
		}
	}
	return problems;
}

function tableOf(value: unknown): Readonly<Record<string, unknown>> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return Object.fromEntries(Object.entries(value));
}
