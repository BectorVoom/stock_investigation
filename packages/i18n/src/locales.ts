/**
 * The languages the UI is written in (ADR-0031). Adding one means adding its
 * code here and a translation to every catalog; the compiler then lists every
 * catalog that lacks it.
 */
export const LOCALES = ["en", "ja"] as const;

export type Locale = (typeof LOCALES)[number];

/** The language of the source text and the fallback when nothing else matches. */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Each language's name in that language (an endonym), so a reader who cannot
 * read the current UI language still finds their own in the language picker.
 */
export const LOCALE_NAMES: { readonly [L in Locale]: string } = {
	en: "English",
	ja: "日本語",
};

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The first supported language in `preferred` (BCP 47 tags in preference
 * order, as `navigator.languages` gives them), matched on the primary
 * language subtag without regard to case: `ja-JP` and `JA` both give `ja`.
 * `DEFAULT_LOCALE` when none matches.
 */
export function negotiateLocale(preferred: readonly string[]): Locale {
	for (const tag of preferred) {
		const primary = tag.trim().split(/[-_]/, 1)[0]?.toLowerCase();
		if (isLocale(primary)) return primary;
	}
	return DEFAULT_LOCALE;
}
