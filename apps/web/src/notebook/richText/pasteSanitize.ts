/**
 * Paste keeps only what the `NOTEBOOK_TEXT_MARKDOWN` subset can express
 * (or falls back to plain text): hostile markup, styles and scripts never
 * reach the document. Runs in the browser (and in happy-dom tests) on the
 * clipboard HTML before ProseMirror parses it against the schema.
 */

const KEEP = new Set([
	"p",
	"h1",
	"h2",
	"h3",
	"ul",
	"ol",
	"li",
	"blockquote",
	"pre",
	"code",
	"hr",
	"br",
	"strong",
	"b",
	"em",
	"i",
	"s",
	"del",
	"a",
]);

/** Dropped with their content: nothing readable lives inside these. */
const DROP_WITH_CONTENT = new Set([
	"script",
	"style",
	"iframe",
	"object",
	"embed",
	"input",
	"img",
	"video",
	"audio",
]);

function cleanElement(element: Element): void {
	const tag = element.tagName.toLowerCase();
	if (DROP_WITH_CONTENT.has(tag)) {
		element.remove();
		return;
	}
	for (const child of [...element.children]) cleanElement(child);
	if (
		tag === "table" ||
		tag === "thead" ||
		tag === "tbody" ||
		tag === "tr" ||
		tag === "td" ||
		tag === "th"
	) {
		element.replaceWith(...[...element.childNodes]);
		return;
	}
	if (!KEEP.has(tag)) {
		if (
			tag === "div" ||
			tag === "section" ||
			tag === "article" ||
			tag === "span" ||
			tag === "font"
		) {
			element.replaceWith(...[...element.childNodes]);
		} else if (/^h[4-6]$/.test(tag)) {
			const paragraph = element.ownerDocument.createElement("p");
			paragraph.replaceChildren(...[...element.childNodes]);
			element.replaceWith(paragraph);
		} else {
			element.replaceWith(...[...element.childNodes]);
		}
		return;
	}
	if (tag === "a") {
		const href = element.getAttribute("href") ?? "";
		const allowed =
			/^(https?:|mailto:)/i.test(href) &&
			!/[\s<>]/.test(href) &&
			href.length > href.indexOf(":") + 1;
		for (const name of [...element.getAttributeNames()]) {
			if (name !== "href" || !allowed) element.removeAttribute(name);
		}
		if (!allowed) element.replaceWith(...[...element.childNodes]);
		return;
	}
	for (const name of [...element.getAttributeNames()]) element.removeAttribute(name);
}

/**
 * Sanitizes pasted HTML to the subset (paragraphs, headings 1–3, lists,
 * quotes, code, dividers, breaks, formatting, validated links). Anything
 * else unwraps to text; scripts, styles and media vanish with their
 * content. Never throws on any string input.
 */
export function sanitizePastedHTML(html: string): string {
	if (html === "") return "";
	// Fragment parsing through a detached host: `<script>` assigned via
	// `innerHTML` never executes, and comments survive for ProseMirror to
	// ignore during its own schema-checked parse.
	const host = document.createElement("div");
	host.innerHTML = html;
	for (const child of [...host.children]) cleanElement(child);
	return host.innerHTML;
}
