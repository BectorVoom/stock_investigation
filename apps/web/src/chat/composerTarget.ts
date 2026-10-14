/**
 * Routing the composer's draft to the notebook assistant (ADR-0021). While
 * the owner has not chosen a target by hand, the draft names the notebook
 * or a widget, so the instruction is about the notebook even in Chat-first
 * with nothing selected.
 */

const LATIN_PATTERN = /\bnotebooks?\b|\bwidgets?\b/i;

/** Japanese terms have no word boundaries, so they match as substrings. */
const JAPANESE_TERMS: readonly string[] = ["ノートブック", "ウィジェット"];

/**
 * True when `text` names the notebook or a widget: whole-word and
 * case-insensitive for `notebook(s)` / `widget(s)`, substring for the
 * Japanese ノートブック / ウィジェット.
 */
export function mentionsNotebook(text: string): boolean {
	if (LATIN_PATTERN.test(text)) return true;
	return JAPANESE_TERMS.some((term) => text.includes(term));
}
