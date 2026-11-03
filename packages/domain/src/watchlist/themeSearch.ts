/**
 * Theme search (ADR-0066): which stocks carry a theme that contains the
 * owner's words. The database narrows the rows with `instr` over the stored
 * `theme_names` JSON (SQLite's `lower` folds ASCII letters only, as
 * `foldAscii` does), and `themeMatches` keeps the themes that really contain
 * the query — a JSON match can span two names or fall on the JSON
 * punctuation between them.
 *
 * Matching is a substring test that ignores the case of ASCII letters and
 * compares every other character exactly (Japanese has no case). The query
 * is NFKC-normalized (full-width letters and digits become ASCII), its
 * whitespace runs become one space, and control characters are removed.
 */

/** One theme's name in both languages. */
export interface ThemeName {
	readonly en: string;
	readonly ja: string;
}

/** The longest query worth sending: no theme name is longer (`maxThemeChars`). */
export const THEME_QUERY_MAX_CHARS = 40;

/** C0 controls and DEL (whitespace among them is collapsed before this runs). */
function isControl(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 0x20 || code === 0x7f;
}

/**
 * The query as matched: NFKC, whitespace runs as one space, no control
 * characters, trimmed. Null when nothing is left or it is longer than any
 * theme name.
 */
export function normalizeThemeQuery(raw: string): string | null {
	const spaced = raw.normalize("NFKC").replace(/\s+/gu, " ");
	const text = [...spaced]
		.filter((char) => !isControl(char))
		.join("")
		.trim();
	if (text === "" || [...text].length > THEME_QUERY_MAX_CHARS) return null;
	return text;
}

/** ASCII letters to lower case; every other character unchanged (SQLite's `lower`). */
export function foldAscii(text: string): string {
	return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * What `instr(lower(theme_names), ?)` looks for: the folded query as it
 * appears inside a JSON string (`"` and `\` escaped, the only characters a
 * normalized query has that JSON escapes).
 */
export function themeNeedle(query: string): string {
	return foldAscii(JSON.stringify(query).slice(1, -1));
}

/** True when the English or the Japanese name contains the query. */
export function themeMatches(theme: ThemeName, query: string): boolean {
	const folded = foldAscii(query);
	return foldAscii(theme.en).includes(folded) || foldAscii(theme.ja).includes(folded);
}

/** The themes that contain the query, in their stored order. */
export function matchingThemes(themes: readonly ThemeName[], query: string): ThemeName[] {
	return themes.filter((theme) => themeMatches(theme, query));
}
