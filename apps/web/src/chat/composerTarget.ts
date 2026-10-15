/**
 * Routing the composer's draft to the notebook assistant (ADR-0021). While
 * the owner has not chosen a target by hand, a draft that names the notebook
 * or a widget, or asks to create a chart, is about the notebook even in
 * Chat-first with nothing selected: Research cannot create widgets, and the
 * owner's "Please create gold chart." went there and failed.
 */

const LATIN_PATTERN = /\bnotebooks?\b|\bwidgets?\b/i;

/**
 * A request to make a chart: a creation verb, then within the same clause a
 * chart noun ("create a gold chart", "Can you plot gold as a line graph").
 * A question about charts ("Which chart patterns…?") has no creation verb.
 */
const LATIN_CHART_REQUEST =
	/\b(?:create|make|add|draw|plot|build|generate|insert|put|show)\b[^.?!\n]{0,60}?\b(?:chart|graph|plot)s?\b/i;

/** Japanese terms have no word boundaries, so they match as substrings. */
const JAPANESE_TERMS: readonly string[] = ["ノートブック", "ウィジェット"];
const JAPANESE_CHART_NOUNS: readonly string[] = ["グラフ", "チャート"];
const JAPANESE_CREATE_VERBS: readonly string[] = [
	"作成",
	"作って",
	"作る",
	"作り",
	"追加",
	"表示",
	"描いて",
	"描く",
	"出して",
];

/**
 * True when `text` is addressed to the notebook: it names the notebook or a
 * widget (whole-word, case-insensitive `notebook(s)` / `widget(s)`;
 * substring ノートブック / ウィジェット), or it asks to create a chart
 * (a creation verb before chart / graph / plot; グラフ or チャート with
 * 作成, 作って, 追加, 表示, 描いて, 出して…).
 */
export function addressesNotebook(text: string): boolean {
	if (LATIN_PATTERN.test(text) || LATIN_CHART_REQUEST.test(text)) return true;
	if (JAPANESE_TERMS.some((term) => text.includes(term))) return true;
	return (
		JAPANESE_CHART_NOUNS.some((noun) => text.includes(noun)) &&
		JAPANESE_CREATE_VERBS.some((verb) => text.includes(verb))
	);
}
