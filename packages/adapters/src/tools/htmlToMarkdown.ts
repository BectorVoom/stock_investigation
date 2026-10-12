/**
 * HTML → Markdown for the research runner (a building block, not a tool).
 *
 * Purpose: the smallest faithful text representation of a page's content.
 * The text is later sent to a language-model API and every byte costs, so
 * markup, page chrome (`nav`/`footer`/`aside`), scripts, styles and images
 * are dropped and only the article text survives as Markdown blocks.
 *
 * Everything retrieved is untrusted (SEC-001): the input may be malformed,
 * hostile or binary garbage, so parsing is streaming and total — this
 * function never throws. The output is shown as plain text and sent to a
 * model, never rendered as HTML (UI-005).
 *
 * No Markdown escaping of text is attempted, for the same reason: escaping
 * would only matter if the output were rendered as Markdown/HTML, which it
 * never is. A literal `*` or `[` in the source stays literal; the model
 * reads the text, it does not evaluate it.
 *
 * Real pages rarely use semantic elements: many are `<div>` layouts whose
 * menus share no `<nav>` ancestor. The main-content detection below is
 * therefore heuristic (role/state, conventional `id`/`class` tokens,
 * link-only lists, the article `<h1>`); whatever it drops is counted in
 * `omitted` so neither the archive reader nor the model is misled about
 * completeness.
 *
 * COST (finding: nested formatting blew a bounded input into ~1B characters).
 * Every element kind that carries formatting state — blockquotes, lists,
 * tables (with rows/cells), inline emphasis/links — is capped at
 * `MAX_FORMAT_NESTING_DEPTH` (32) levels; deeper elements are flattened to
 * their text, so each input character participates in at most 32 levels of
 * line-prefixing or marker-wrapping. Sections, items and headings carry the
 * same ceiling so blocks bubble up at most 32 levels instead of O(depth²). A
 * work budget stops root-directed output once it exceeds
 * `WORK_BUDGET_MULTIPLE` times `maxChars` (the result is truncated anyway).
 * Together: parsing is one streaming pass, tag matching is O(1) per tag via a
 * per-tag index (amortized O(n) overall; repeated mismatched closes were
 * O(n²)), each close rebuilds at most O(frame) characters with frame nesting
 * bounded by 32, the clean-up unwind pops at most O(frames) ≤ O(n), and final
 * assembly is O(blocks) — everything past the parser is linear in input size.
 *
 * RESIDUAL: the parser (htmlparser2) keeps its own open-element stack with
 * front-of-array push/pop, i.e. O(depth) per tag. Adversarial nesting depth
 * therefore costs O(n·depth) parser time (measured: 2 MiB at 4,000 mixed
 * levels ≈ 0.5 s node / 0.2 s bun; 2 MiB at 150,000 levels ≈ 30 s node /
 * 0.6 s bun — the runner, which does this work, runs on bun). Capping input
 * depth ahead of the parser would need a second tokenizer and its own parse
 * differentials, so depth itself is bounded only by the 2 MiB fetch cap.
 */
import { Parser } from "htmlparser2";

export interface OmittedCounts {
	readonly boilerplateBlocks: number;
	readonly menuLists: number;
	readonly leadingBlocks: number;
}

const ZERO_OMITTED: OmittedCounts = { boilerplateBlocks: 0, menuLists: 0, leadingBlocks: 0 };

export interface MarkdownPage {
	/** Text of <title>, else the first <h1>, else null. Whitespace-collapsed, at most 300 characters. */
	readonly title: string | null;
	readonly markdown: string;
	/** True when the page was longer than `maxChars` and the Markdown was cut. */
	readonly truncated: boolean;
	/** Heuristic drops, so a reader knows the Markdown is not the whole page. */
	readonly omitted: OmittedCounts;
}

export interface HtmlToMarkdownOptions {
	readonly baseUrl: string;
	readonly maxChars: number;
}

/** Elements dropped with everything inside them (plus HTML comments, below). */
const DROPPED_ELEMENTS: ReadonlySet<string> = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"canvas",
	"iframe",
	"object",
	"embed",
	"form",
	"button",
	"select",
	"textarea",
	"nav",
	"footer",
	"aside",
]);

/** `role` values dropped with everything inside them (rule 1: drop by role, not only by tag). */
const DROP_ROLES: ReadonlySet<string> = new Set([
	"navigation",
	"banner",
	"contentinfo",
	"complementary",
	"search",
	"menu",
	"menubar",
	"dialog",
	"alertdialog",
]);

/**
 * Conventional chrome names (rule 2). Matched as whole tokens only, so
 * `menu` never matches `document`.
 */
const BOILERPLATE_TOKENS: ReadonlySet<string> = new Set([
	"nav",
	"navbar",
	"navigation",
	"menu",
	"breadcrumb",
	"breadcrumbs",
	"sidebar",
	"footer",
	"cookie",
	"cookies",
	"consent",
	"banner",
	"masthead",
	"share",
	"social",
	"subnav",
	"skip",
	"skiplink",
	"toolbar",
]);

/** Tags the token rule may drop; never `body`/`html`/`main`/`article` (rule 2). */
const BOILERPLATE_TAGS: ReadonlySet<string> = new Set(["div", "section", "ul", "ol", "header"]);

/** Void elements: no close tag follows, so they are never pushed on a stack. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

/** Elements that become Markdown blocks separated by one blank line. */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
	"p",
	"div",
	"section",
	"article",
	"main",
	"header",
	"hgroup",
	"figure",
	"figcaption",
	"dl",
	"dt",
	"dd",
	"details",
	"summary",
	"address",
	"search",
]);

const TITLE_MAX_CHARS = 300;
/** An `<h1>` counts as the article start only with this much paragraph text after it (rule 5). */
const ARTICLE_H1_MIN_PARAGRAPH_CHARS = 200;
/** A link-only list counts as a menu only from this many items (rule 4). */
const MENU_LIST_MIN_ITEMS = 5;
/**
 * Nesting ceiling for every element kind that carries formatting state
 * (blockquote, lists, tables/rows/cells, inline emphasis and links). Deeper
 * elements are flattened to their text: without it, N nested blockquotes
 * around M lines rebuild every line N times (10,000 × 50,000 ≈ 1B chars).
 */
const MAX_FORMAT_NESTING_DEPTH = 32;
/**
 * The converter stops producing output once rendered blocks exceed this many
 * times `maxChars` — the result is truncated anyway, so further rendering is
 * wasted work. Bounds intermediate memory even at the ceiling depth.
 */
const WORK_BUDGET_MULTIPLE = 4;

interface TextBlock {
	readonly text: string;
	readonly inMain: boolean;
	/** A rendered nested list: an enclosing `li` splices its lines as-is (they already carry their indent). */
	readonly list: boolean;
}

type Frame =
	| {
			readonly kind: "section";
			readonly tag: string;
			readonly inMain: boolean;
			readonly inline: string[];
			readonly blocks: TextBlock[];
	  }
	| {
			readonly kind: "heading";
			readonly tag: string;
			readonly level: number;
			readonly inline: string[];
	  }
	| {
			readonly kind: "inline";
			readonly tag: string;
			readonly marker: string;
			readonly href: string | null;
			readonly samePage: boolean;
			readonly inline: string[];
	  }
	| { readonly kind: "pre"; readonly tag: string }
	| {
			readonly kind: "list";
			readonly tag: string;
			readonly ordered: boolean;
			readonly depth: number;
			readonly items: string[];
	  }
	| {
			readonly kind: "item";
			readonly tag: string;
			readonly inline: string[];
			readonly blocks: TextBlock[];
			readonly depth: number;
			readonly ordered: boolean;
			readonly index: number;
			readonly orphan: boolean;
	  }
	| {
			readonly kind: "quote";
			readonly tag: string;
			readonly inMain: boolean;
			readonly inline: string[];
			readonly blocks: TextBlock[];
	  }
	| { readonly kind: "table"; readonly tag: string; readonly rows: string[][] }
	| { readonly kind: "row"; readonly tag: string; readonly cells: string[] }
	| { readonly kind: "cell"; readonly tag: string; readonly inline: string[] };

interface OpenElement {
	readonly tag: string;
	readonly main: boolean;
}

/** Collapses every run of whitespace except newlines (from `br`) to one space. */
function collapseWhitespace(text: string): string {
	return text.replace(/[^\S\n]+/g, " ");
}

/** One logical line per physical line: trimmed, no leading/trailing blanks, at most one blank in a row. */
function finalizeBlockLines(text: string): string {
	const lines = collapseWhitespace(text)
		.split("\n")
		.map((line) => line.trim());
	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const kept: string[] = [];
	for (const line of lines) {
		if (line !== "" || kept[kept.length - 1] !== "") kept.push(line);
	}
	return kept.join("\n");
}

/** Single-line text: line breaks and runs of whitespace become one space. */
function singleLine(text: string): string {
	return collapseWhitespace(text.replace(/\n/g, " ")).trim();
}

/** Cuts on a Unicode code-point boundary, so a surrogate pair is never split. */
function cutCodePoints(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	let kept = "";
	for (const character of text) {
		if (kept.length + character.length > maxLength) break;
		kept += character;
	}
	return kept;
}

function collapseTitle(text: string): string {
	return cutCodePoints(singleLine(text), TITLE_MAX_CHARS);
}

/** Resolves `href` against `baseUrl`; only http(s) results stay links (SEC-001). */
function resolveLink(href: string, baseUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(href.trim(), baseUrl);
	} catch {
		return null;
	}
	return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

/** Case-insensitive attribute lookup; htmlparser2 keeps the source case for names. */
function attribValue(
	attribs: { readonly [name: string]: string },
	wanted: string,
): string | undefined {
	for (const key of Object.keys(attribs)) {
		if (key.toLowerCase() === wanted) return attribs[key];
	}
	return undefined;
}

function hasAttrib(attribs: { readonly [name: string]: string }, wanted: string): boolean {
	for (const key of Object.keys(attribs)) {
		if (key.toLowerCase() === wanted) return true;
	}
	return false;
}

/** Splits `id`/`class` values on anything that is not a letter or digit (rule 2). */
function tokensOf(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token !== "");
}

function hasBoilerplateToken(id: string | undefined, className: string | undefined): boolean {
	const tokens = [...tokensOf(id ?? ""), ...tokensOf(className ?? "")];
	for (const token of tokens) {
		if (BOILERPLATE_TOKENS.has(token)) return true;
	}
	return false;
}

/** A link whose text is a skip hint is chrome, not content (rule 3). */
function isSkipLinkText(text: string): boolean {
	return /^skip( to)? /i.test(text);
}

/** The page URL without its fragment; null when `baseUrl` is not an http(s) URL. */
function pageNoFragment(baseUrl: string): string | null {
	try {
		const pageUrl = new URL(baseUrl);
		if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return null;
		const hashIndex = pageUrl.href.indexOf("#");
		return hashIndex === -1 ? pageUrl.href : pageUrl.href.slice(0, hashIndex);
	} catch {
		return null;
	}
}

/**
 * True when `href`, resolved against the page URL, differs from the page URL
 * only by its fragment (rule 3). Non-http(s) targets are never same-page:
 * they become plain text through `resolveLink` anyway.
 */
function isSamePageLink(
	href: string,
	baseUrl: string,
	pageWithoutFragment: string | null,
): boolean {
	if (pageWithoutFragment === null) return false;
	let resolved: URL;
	try {
		resolved = new URL(href.trim(), baseUrl);
	} catch {
		return false;
	}
	if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return false;
	const hashIndex = resolved.href.indexOf("#");
	const resolvedWithoutFragment =
		hashIndex === -1 ? resolved.href : resolved.href.slice(0, hashIndex);
	return resolvedWithoutFragment === pageWithoutFragment;
}

const MENU_ITEM_LINK_PATTERN = /^(-|\d+\.)\s+\[.+\]\(https?:\/\/\S+\)$/;

/**
 * A rendered list block is a menu when every line is exactly one link
 * (rule 4). Nested lists are included: they were spliced into the same
 * block, so every nested line must be link-only too.
 */
function isMenuListBlock(text: string): boolean {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (lines.length < MENU_LIST_MIN_ITEMS) return false;
	for (const line of lines) {
		if (!MENU_ITEM_LINK_PATTERN.test(line)) return false;
	}
	return true;
}

function isH1Block(text: string): boolean {
	return text.startsWith("# ");
}

function isHeadingBlock(text: string): boolean {
	return /^#{1,6} /.test(text);
}

function headingLevel(tag: string): number | null {
	switch (tag) {
		case "h1":
			return 1;
		case "h2":
			return 2;
		case "h3":
			return 3;
		case "h4":
			return 4;
		case "h5":
			return 5;
		case "h6":
			return 6;
		default:
			return null;
	}
}

export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions): MarkdownPage {
	try {
		if (typeof html !== "string")
			return { title: null, markdown: "", truncated: false, omitted: ZERO_OMITTED };
		const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : "";
		const maxChars =
			typeof options.maxChars === "number" && Number.isFinite(options.maxChars)
				? Math.max(0, Math.floor(options.maxChars))
				: 0;
		return convert(html, baseUrl, maxChars);
	} catch {
		// Total function: malformed input, hostile nesting and binary garbage all end here.
		return { title: null, markdown: "", truncated: false, omitted: ZERO_OMITTED };
	}
}

function convert(html: string, baseUrl: string, maxChars: number): MarkdownPage {
	const root: Frame = { kind: "section", tag: "", inMain: false, inline: [], blocks: [] };
	const stack: Frame[] = [root];
	const dropped: string[] = [];
	const openElements: OpenElement[] = [];
	const pageWithoutFragment = pageNoFragment(baseUrl);
	/**
	 * Per-tag stacks of positions in `openElements`, so `popElement` finds its
	 * match in O(1) instead of scanning: repeated mismatched closes (`</span>`
	 * against 400k `<div>` opens) would otherwise make matching O(n²) on a
	 * 2 MB input. Every push records its index; every unwind pops the entries
	 * it removes, so the map stays in sync. Each element is pushed once and
	 * popped at most once — total matching work O(n).
	 */
	const openTagPositions = new Map<string, number[]>();

	let bodySeen = false;
	let bodyDepth = 0;
	let mainDepth = 0;
	let sawMain = false;
	let boilerplateDrops = 0;
	let menuListsDropped = 0;
	let leadingDropped = 0;
	let titleDepth = 0;
	let titleChunks: string[] = [];
	let titleText: string | null = null;
	let firstH1: string | null = null;
	let preDepth = 0;
	let preChunks: string[] = [];
	let headingDepth = 0;
	let listDepth = 0;
	let tableDepth = 0;
	let rowDepth = 0;
	let cellDepth = 0;
	let quoteDepth = 0;
	let inlineDepth = 0;
	let sectionDepth = 0;
	let itemDepth = 0;
	// Opens flattened (not pushed) past the nesting ceiling, per kind. Each
	// close of that kind consumes one pending skip first, so a flattened close
	// can never pop a pushed ancestor with the same tag. All bounded by input
	// length; every open adds at most one skip and every close removes at most
	// one, so both handlers terminate.
	let skippedQuotes = 0;
	let skippedLists = 0;
	let skippedTables = 0;
	let skippedRows = 0;
	let skippedInline = 0;
	let skippedSections = 0;
	let skippedItems = 0;
	let skippedHeadings = 0;
	// Work budget: rendered block characters so far; once past
	// `WORK_BUDGET_MULTIPLE * maxChars` further output is dropped (the result
	// is truncated anyway). Monotone: set once, never unset within a convert.
	let renderedChars = 0;
	let overBudget = false;
	const workBudget = maxChars * WORK_BUDGET_MULTIPLE;

	const top = (): Frame | undefined => stack[stack.length - 1];
	const eligible = (): boolean => !bodySeen || bodyDepth > 0;

	function omitted(): OmittedCounts {
		return {
			boilerplateBlocks: boilerplateDrops,
			menuLists: menuListsDropped,
			leadingBlocks: leadingDropped,
		};
	}

	/** Starts dropping an element; only the subtree root is counted (rule 1–2). */
	function dropElement(tag: string): void {
		if (dropped.length === 0) boilerplateDrops += 1;
		if (!VOID_ELEMENTS.has(tag)) dropped.push(tag);
	}

	/** Pops `openElements` through the matching close, releasing its main contributions. */
	function popElement(tag: string): void {
		// O(1) match via the per-tag index: a stray close with no matching open
		// returns immediately instead of scanning the whole stack (which made
		// mismatched closes O(n²) on hostile input). The unwind below pops each
		// element once overall, so total work across all closes is O(n).
		const positions = openTagPositions.get(tag);
		const matchIndex =
			positions === undefined || positions.length === 0
				? -1
				: (positions[positions.length - 1] ?? -1);
		if (matchIndex === -1) return;
		for (let back = openElements.length - 1; back >= matchIndex; back -= 1) {
			const popped = openElements.pop();
			const tagStack = openTagPositions.get(popped?.tag ?? "");
			// Entries unwind in reverse push order, so the popped position is
			// its tag stack's top; the guard keeps a bug fail-safe.
			if (tagStack !== undefined && tagStack[tagStack.length - 1] === back) tagStack.pop();
			if (popped?.main === true) mainDepth = Math.max(0, mainDepth - 1);
		}
	}

	/** Records one `openElements` entry and its per-tag index together. */
	function pushElement(tag: string, main: boolean): void {
		openElements.push({ tag, main });
		let positions = openTagPositions.get(tag);
		if (positions === undefined) {
			positions = [];
			openTagPositions.set(tag, positions);
		}
		positions.push(openElements.length - 1);
	}

	/** Moves pending inline text of a block frame into its block list. */
	function flushInline(frame: Frame): void {
		if (frame.kind !== "section" && frame.kind !== "quote" && frame.kind !== "item") return;
		const text = finalizeBlockLines(frame.inline.join(""));
		frame.inline.length = 0;
		if (text !== "")
			frame.blocks.push({
				text,
				inMain: frame.kind === "section" || frame.kind === "quote" ? frame.inMain : mainDepth > 0,
				list: false,
			});
	}

	/** Appends a finished block to whatever frame is now on top of the stack. */
	function emitBlock(text: string, inMain: boolean, list = false): void {
		if (text === "") return;
		const parent = top();
		if (parent === undefined) return;
		// Work budget: only root-directed output counts. Intermediate rebuilds
		// (one quote/list level re-emitting its frame) are bounded by the nesting
		// ceiling instead; counting them here would drop the very blocks the
		// final output is assembled from. Once root output passes the budget the
		// result is truncated anyway, so further root blocks are dropped.
		const isRoot = stack.length === 1;
		if (isRoot) {
			if (overBudget) return;
			renderedChars += text.length;
			if (renderedChars > workBudget) overBudget = true;
		}
		switch (parent.kind) {
			case "section":
			case "quote":
			case "item":
				parent.blocks.push({ text, inMain, list });
				break;
			case "inline":
			case "heading":
			case "cell":
				parent.inline.push(` ${text} `);
				break;
			case "list":
				parent.items.push(text);
				break;
			case "table":
			case "row":
			case "pre":
				break;
		}
	}

	/** Appends finished inline text to whatever frame is now on top of the stack. */
	function emitInline(text: string): void {
		if (text === "") return;
		const parent = top();
		if (parent === undefined) return;
		switch (parent.kind) {
			case "section":
			case "quote":
			case "item":
			case "inline":
			case "heading":
			case "cell":
				parent.inline.push(text);
				break;
			case "list":
				if (singleLine(text) !== "") parent.items.push(singleLine(text));
				break;
			case "table":
			case "row":
			case "pre":
				break;
		}
	}

	function openTag(rawName: string, attribs: { readonly [name: string]: string }): void {
		const name = rawName.toLowerCase();
		if (dropped.length > 0) {
			// Inside a dropped subtree every tag is dropped; pushing keeps
			// nested same-name closes balanced so the outer pop lands correctly.
			if (!VOID_ELEMENTS.has(name)) dropped.push(name);
			return;
		}
		if (DROPPED_ELEMENTS.has(name)) {
			dropElement(name);
			return;
		}
		// Rule 1: drop by role and state, not only by tag. `role="main"` and
		// `role="article"` count as `<main>`/`<article>` below instead.
		const roleRaw = attribValue(attribs, "role");
		const roleTokens =
			roleRaw === undefined
				? []
				: roleRaw
						.trim()
						.toLowerCase()
						.split(/\s+/)
						.filter((token) => token !== "");
		const ariaHidden = attribValue(attribs, "aria-hidden");
		const isAriaHidden = ariaHidden !== undefined && ariaHidden.trim().toLowerCase() === "true";
		if (
			isAriaHidden ||
			hasAttrib(attribs, "hidden") ||
			roleTokens.some((token) => DROP_ROLES.has(token))
		) {
			dropElement(name);
			return;
		}
		if (name === "body") {
			bodySeen = true;
			bodyDepth += 1;
			return;
		}
		if (name === "title") {
			if (titleDepth === 0) titleChunks = [];
			titleDepth += 1;
			return;
		}
		if (titleDepth > 0) return;
		if (name === "pre") {
			// One frame for the outermost `<pre>` only: nested `<pre>` pushes
			// used to leave an orphan frame whose close never popped it, so the
			// clean-up unwind spun forever on `<pre><pre>x</pre></pre>`.
			if (preDepth === 0) {
				preChunks = [];
				if (eligible()) stack.push({ kind: "pre", tag: name });
			}
			preDepth += 1;
			return;
		}
		if (headingLevel(name) !== null) headingDepth += 1;
		if (name === "head" || name === "html") return;
		if (!eligible()) return;
		if (preDepth > 0) {
			// Inside `pre` only a line break still structures text; every other tag is literal.
			if (name === "br") preChunks.push("\n");
			return;
		}
		// From here every open has a close (void tags return below), so the
		// element stack stays balanced for the `role="main"` bookkeeping.
		if (name === "br") {
			emitInline("\n");
			return;
		}
		if (name === "hr") {
			const parent = top();
			if (parent !== undefined) flushInline(parent);
			emitBlock("---", mainDepth > 0);
			return;
		}
		if (name === "img") return;
		const hasMainRole = roleTokens.some((token) => token === "main" || token === "article");
		const tagIsMain = name === "main" || name === "article";
		const contributesMain = tagIsMain || hasMainRole;
		if (contributesMain) {
			sawMain = true;
			mainDepth += 1;
		}
		// Rule 2: drop by conventional names when there is no semantic help.
		// Never inside main content and never for the document elements themselves.
		if (!contributesMain && mainDepth === 0 && BOILERPLATE_TAGS.has(name)) {
			if (hasBoilerplateToken(attribValue(attribs, "id"), attribValue(attribs, "class"))) {
				// The main contribution above never happened here (`!contributesMain`),
				// so no element was pushed yet and nothing needs unwinding.
				dropElement(name);
				return;
			}
		}
		if (!VOID_ELEMENTS.has(name)) pushElement(name, contributesMain);
		const level = headingLevel(name);
		if (level !== null) {
			// Past the ceiling a heading is flattened to its text; `headingDepth`
			// already counts this open, so pushed-so-far excluding it is `depth - 1`.
			if (headingDepth - 1 >= MAX_FORMAT_NESTING_DEPTH) {
				skippedHeadings += 1;
				return;
			}
			const parent = top();
			if (parent !== undefined) flushInline(parent);
			stack.push({ kind: "heading", tag: name, level, inline: [] });
			return;
		}
		if (headingDepth > 0) {
			// A block tag inside a heading is invalid HTML; keep its text flowing, not its structure.
			if (
				BLOCK_ELEMENTS.has(name) ||
				name === "ul" ||
				name === "ol" ||
				name === "li" ||
				name === "blockquote" ||
				name === "table" ||
				name === "tr" ||
				name === "td" ||
				name === "th" ||
				name === "hr"
			)
				return;
		}
		if (name === "ul" || name === "ol") {
			const parent = top();
			if (parent !== undefined) flushInline(parent);
			// Past the ceiling the list is flattened: no frame is pushed, so a
			// later `li` attaches to the nearest pushed ancestor (depth capped)
			// or becomes a plain block. The matching close consumes the skip.
			if (listDepth >= MAX_FORMAT_NESTING_DEPTH) {
				skippedLists += 1;
				return;
			}
			stack.push({ kind: "list", tag: name, ordered: name === "ol", depth: listDepth, items: [] });
			listDepth += 1;
			return;
		}
		if (name === "li") {
			const parent = top();
			if (parent !== undefined) flushInline(parent);
			// Past the ceiling an item is flattened to a plain block; this also
			// bounds the ancestor scan below to ~32 consecutive items.
			if (itemDepth >= MAX_FORMAT_NESTING_DEPTH) {
				skippedItems += 1;
				return;
			}
			// Number and marker come from the enclosing list; find it without popping.
			// Terminates: `i` decreases each iteration; with the item ceiling the
			// scan crosses at most ~32 consecutive items before a list or break.
			let ordered = false;
			let index = 1;
			let depth = 0;
			let orphan = true;
			if (listDepth > 0) {
				for (let i = stack.length - 1; i >= 0; i -= 1) {
					const candidate = stack[i];
					if (candidate === undefined) break;
					if (candidate.kind === "list") {
						ordered = candidate.ordered;
						index = candidate.items.length + 1;
						depth = candidate.depth;
						orphan = false;
						break;
					}
					if (candidate.kind !== "item") break;
				}
			}
			stack.push({
				kind: "item",
				tag: name,
				inline: [],
				blocks: [],
				depth,
				ordered,
				index,
				orphan,
			});
			itemDepth += 1;
			return;
		}
		if (name === "blockquote") {
			const parent = top();
			if (parent !== undefined) flushInline(parent);
			// Past the ceiling the quote is flattened to its text (no `>` run
			// is built for it); the matching close consumes the skip.
			if (quoteDepth >= MAX_FORMAT_NESTING_DEPTH) {
				skippedQuotes += 1;
				return;
			}
			stack.push({ kind: "quote", tag: name, inMain: mainDepth > 0, inline: [], blocks: [] });
			quoteDepth += 1;
			return;
		}
		if (name === "table") {
			// A table inside a cell would corrupt the outer row; keep only its text.
			if (cellDepth > 0) return;
			// Past the ceiling the table is flattened to its text.
			if (tableDepth >= MAX_FORMAT_NESTING_DEPTH) {
				skippedTables += 1;
				return;
			}
			const parent = top();
			if (parent !== undefined) flushInline(parent);
			stack.push({ kind: "table", tag: name, rows: [] });
			tableDepth += 1;
			return;
		}
		if (name === "tr") {
			if (tableDepth === 0 || cellDepth > 0) return;
			// A row nested directly in a row is malformed; keep only its text.
			if (rowDepth > 0) {
				skippedRows += 1;
				return;
			}
			stack.push({ kind: "row", tag: name, cells: [] });
			rowDepth += 1;
			return;
		}
		if (name === "td" || name === "th") {
			// Cells cannot nest (`cellDepth > 0` returns): at most one cell
			// frame per row, so no ceiling is needed here.
			if (rowDepth === 0 || cellDepth > 0) return;
			stack.push({ kind: "cell", tag: name, inline: [] });
			cellDepth += 1;
			return;
		}
		// Past the ceiling emphasis and links are flattened to their text; the
		// matching close consumes the skip (see closeTag) so a flattened close
		// can never pop a pushed ancestor with the same tag.
		if (
			name === "a" ||
			name === "strong" ||
			name === "b" ||
			name === "em" ||
			name === "i" ||
			name === "code"
		) {
			if (inlineDepth >= MAX_FORMAT_NESTING_DEPTH) {
				skippedInline += 1;
				return;
			}
		}
		if (name === "a") {
			const href = attribValue(attribs, "href");
			const samePage =
				href === undefined ? false : isSamePageLink(href, baseUrl, pageWithoutFragment);
			stack.push({
				kind: "inline",
				tag: name,
				marker: "",
				href: href ?? null,
				samePage,
				inline: [],
			});
			inlineDepth += 1;
			return;
		}
		if (name === "strong" || name === "b") {
			stack.push({
				kind: "inline",
				tag: name,
				marker: "**",
				href: null,
				samePage: false,
				inline: [],
			});
			inlineDepth += 1;
			return;
		}
		if (name === "em" || name === "i") {
			stack.push({
				kind: "inline",
				tag: name,
				marker: "*",
				href: null,
				samePage: false,
				inline: [],
			});
			inlineDepth += 1;
			return;
		}
		if (name === "code") {
			stack.push({
				kind: "inline",
				tag: name,
				marker: "`",
				href: null,
				samePage: false,
				inline: [],
			});
			inlineDepth += 1;
			return;
		}
		if (BLOCK_ELEMENTS.has(name)) {
			const parent = top();
			if (parent !== undefined) flushInline(parent);
			// Past the ceiling a section is flattened to its text: without this,
			// each close re-emits all blocks accumulated below it, which is
			// O(depth × blocks) on hostile nesting. Text still flows to the
			// parent frame; `inMain` bookkeeping is unaffected (openElements).
			if (sectionDepth >= MAX_FORMAT_NESTING_DEPTH) {
				skippedSections += 1;
				return;
			}
			stack.push({ kind: "section", tag: name, inMain: mainDepth > 0, inline: [], blocks: [] });
			sectionDepth += 1;
			return;
		}
		// Transparent elements (`span`, `picture`, unknown and custom tags): text flows to the parent.
	}

	function closeTag(rawName: string): void {
		const name = rawName.toLowerCase();
		if (dropped.length > 0) {
			if (dropped[dropped.length - 1] === name) dropped.pop();
			return;
		}
		if (name === "body") {
			bodyDepth = Math.max(0, bodyDepth - 1);
			return;
		}
		if (name === "title") {
			if (titleDepth > 0) {
				titleDepth -= 1;
				if (titleDepth === 0 && titleText === null) {
					const collapsed = collapseTitle(titleChunks.join(""));
					if (collapsed !== "") titleText = collapsed;
				}
			}
			return;
		}
		if (titleDepth > 0) return;
		if (name === "pre") {
			if (preDepth > 0) {
				preDepth -= 1;
				if (preDepth === 0) {
					const frame = top();
					if (frame !== undefined && frame.kind === "pre") stack.pop();
					const content = preChunks.join("").replace(/^\n+|\n+$/g, "");
					preChunks = [];
					if (content !== "") emitBlock(`\`\`\`\n${content}\n\`\`\``, mainDepth > 0);
				}
			}
			return;
		}
		// The heading counter is decremented before the `pre` early return: a
		// heading opened inside `pre` incremented it, so its close must release
		// it, or the counter leaks and later headings flatten spuriously.
		if (headingLevel(name) !== null) headingDepth = Math.max(0, headingDepth - 1);
		if (preDepth > 0) return;
		if (name === "head" || name === "html" || name === "body") return;
		// Flattened (over-ceiling) closes: the matching open pushed no frame but
		// did push an `openElements` entry, so release that entry and consume one
		// pending skip instead of popping a pushed ancestor with the same tag.
		// Each close removes at most one frame or one skip, so this terminates.
		if (headingLevel(name) !== null) {
			const candidate = top();
			if (
				(candidate === undefined || candidate.kind !== "heading" || candidate.tag !== name) &&
				skippedHeadings > 0
			) {
				popElement(name);
				skippedHeadings -= 1;
				return;
			}
		} else if (name === "blockquote") {
			const candidate = top();
			if (
				(candidate === undefined || candidate.kind !== "quote" || candidate.tag !== name) &&
				skippedQuotes > 0
			) {
				popElement(name);
				skippedQuotes -= 1;
				return;
			}
		} else if (name === "ul" || name === "ol") {
			const candidate = top();
			if (
				(candidate === undefined || candidate.kind !== "list" || candidate.tag !== name) &&
				skippedLists > 0
			) {
				popElement(name);
				skippedLists -= 1;
				return;
			}
		} else if (name === "li") {
			const candidate = top();
			if (
				(candidate === undefined || candidate.kind !== "item" || candidate.tag !== name) &&
				skippedItems > 0
			) {
				popElement(name);
				skippedItems -= 1;
				return;
			}
		} else if (name === "table") {
			const candidate = top();
			if (
				(candidate === undefined || candidate.kind !== "table" || candidate.tag !== name) &&
				skippedTables > 0
			) {
				popElement(name);
				skippedTables -= 1;
				return;
			}
		} else if (name === "tr") {
			const candidate = top();
			if (
				(candidate === undefined || candidate.kind !== "row" || candidate.tag !== name) &&
				skippedRows > 0
			) {
				popElement(name);
				skippedRows -= 1;
				return;
			}
		} else if (
			name === "a" ||
			name === "strong" ||
			name === "b" ||
			name === "em" ||
			name === "i" ||
			name === "code"
		) {
			const candidate = top();
			if (
				(candidate === undefined || candidate.kind !== "inline" || candidate.tag !== name) &&
				skippedInline > 0
			) {
				popElement(name);
				skippedInline -= 1;
				return;
			}
		} else if (BLOCK_ELEMENTS.has(name)) {
			const candidate = top();
			if (
				(candidate === undefined || candidate.kind !== "section" || candidate.tag !== name) &&
				skippedSections > 0
			) {
				popElement(name);
				skippedSections -= 1;
				return;
			}
		}
		popElement(name);
		const frame = top();
		if (frame === undefined || frame.tag !== name) return;
		stack.pop();
		switch (frame.kind) {
			case "section": {
				sectionDepth = Math.max(0, sectionDepth - 1);
				flushInline(frame);
				for (const block of frame.blocks) emitBlock(block.text, block.inMain, block.list);
				break;
			}
			case "heading": {
				const text = singleLine(frame.inline.join(""));
				if (text !== "") {
					if (frame.tag === "h1" && firstH1 === null) firstH1 = collapseTitle(text);
					emitBlock(`${"#".repeat(frame.level)} ${text}`, mainDepth > 0);
				}
				break;
			}
			case "inline": {
				inlineDepth = Math.max(0, inlineDepth - 1);
				const raw = frame.inline.join("");
				const hasLead = /^\s/.test(raw);
				const hasTrail = /\s$/.test(raw);
				const lead = hasLead ? " " : "";
				const trail = hasTrail ? " " : "";
				if (frame.href !== null) {
					const text = singleLine(raw);
					if (text === "") break;
					// Skip hints are chrome even when they carry a real URL (rule 3).
					if (isSkipLinkText(text)) {
						boilerplateDrops += 1;
						break;
					}
					// Same-page links are not links: keep the text, drop the target (rule 3).
					if (frame.samePage) {
						emitInline(`${lead}${text}${trail}`);
						break;
					}
					const url = resolveLink(frame.href, baseUrl);
					if (url === null) emitInline(`${lead}${text}${trail}`);
					else emitInline(`${lead}[${text}](${url})${trail}`);
				} else if (frame.marker !== "") {
					// Rule 6: a space lost inside the emphasis must survive
					// outside it, or `**Data source:**U.S.` is emitted.
					const text = finalizeBlockLines(raw);
					if (text !== "") emitInline(`${lead}${frame.marker}${text}${frame.marker}${trail}`);
				} else {
					emitInline(raw);
				}
				break;
			}
			case "list": {
				listDepth = Math.max(0, listDepth - 1);
				if (frame.items.length > 0) emitBlock(frame.items.join("\n"), mainDepth > 0, true);
				break;
			}
			case "item": {
				itemDepth = Math.max(0, itemDepth - 1);
				flushInline(frame);
				const parts = [...frame.blocks];
				const direct = finalizeBlockLines(frame.inline.join(""));
				if (direct !== "") parts.push({ text: direct, inMain: mainDepth > 0, list: false });
				const kept = parts.filter((part) => part.text !== "");
				if (kept.length === 0) break;
				const [first, ...rest] = kept;
				if (first === undefined) break;
				if (frame.orphan) {
					emitBlock(first.text, mainDepth > 0);
					for (const extra of rest) emitBlock(extra.text, mainDepth > 0);
				} else {
					const marker = frame.ordered ? `${frame.index}.` : "-";
					const indent = "  ".repeat(frame.depth);
					const lines = [`${indent}${marker} ${first.text}`];
					for (const extra of rest) {
						if (extra.list) {
							// A nested list already carries its absolute indent; splice it unchanged.
							for (const line of extra.text.split("\n")) lines.push(line);
						} else {
							for (const line of extra.text.split("\n")) lines.push(`${indent}  ${line}`);
						}
					}
					const parent = top();
					if (parent !== undefined && parent.kind === "list") parent.items.push(lines.join("\n"));
					else emitBlock(lines.join("\n"), mainDepth > 0);
				}
				break;
			}
			case "quote": {
				quoteDepth = Math.max(0, quoteDepth - 1);
				flushInline(frame);
				const lines: string[] = [];
				for (const block of frame.blocks) {
					for (const line of block.text.split("\n")) lines.push(line === "" ? ">" : `> ${line}`);
				}
				if (lines.length > 0) emitBlock(lines.join("\n"), frame.inMain);
				break;
			}
			case "table": {
				tableDepth = Math.max(0, tableDepth - 1);
				const rows = frame.rows.filter((row) => row.some((cell) => cell !== ""));
				if (rows.length === 0) break;
				const [header, ...body] = rows;
				if (header === undefined) break;
				const pipe = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
				const lines = [pipe(header), `| ${header.map(() => "---").join(" | ")} |`];
				for (const row of body) lines.push(pipe(row));
				emitBlock(lines.join("\n"), mainDepth > 0);
				break;
			}
			case "row": {
				rowDepth = Math.max(0, rowDepth - 1);
				const parent = top();
				if (parent !== undefined && parent.kind === "table") parent.rows.push(frame.cells);
				break;
			}
			case "cell": {
				cellDepth = Math.max(0, cellDepth - 1);
				const text = singleLine(frame.inline.join("").replace(/[|\n]/g, " "));
				const parent = top();
				if (parent !== undefined && parent.kind === "row") parent.cells.push(text);
				else if (text !== "") emitInline(text);
				break;
			}
			case "pre":
				break;
		}
	}

	function onText(data: string): void {
		if (dropped.length > 0) return;
		if (titleDepth > 0) {
			titleChunks.push(data);
			return;
		}
		if (preDepth > 0) {
			preChunks.push(data);
			return;
		}
		if (!eligible()) return;
		const frame = top();
		if (frame === undefined) return;
		switch (frame.kind) {
			case "section":
			case "quote":
			case "item":
			case "inline":
			case "heading":
			case "cell":
				frame.inline.push(data);
				break;
			case "list": {
				const text = singleLine(data);
				if (text !== "") frame.items.push(text);
				break;
			}
			case "table":
			case "row":
			case "pre":
				break;
		}
	}

	const parser = new Parser(
		{
			onopentag: (name, attribs) => {
				openTag(name, attribs);
			},
			ontext: (data) => {
				onText(data);
			},
			onclosetag: (name) => {
				closeTag(name);
			},
			// Comments are dropped with everything in them.
			oncomment: () => {},
		},
		{ decodeEntities: true },
	);
	parser.write(html);
	parser.end();

	// Unclosed tags still contribute their text: unwind the stack in order.
	// Structurally unable to spin: unclosed `script`/`title`/`pre` state is
	// drained first (each drain loop strictly decreases its counter), then every
	// iteration either pops a frame via closeTag (stack shrinks) or — when
	// closeTag declines a frame it does not own — the frame is dropped outright.
	// Terminates after at most stack.length + pending-state steps.
	while (stack.length > 1) {
		const frame = stack[stack.length - 1];
		if (frame === undefined || frame.tag === "") break;
		if (dropped.length > 0) {
			// Unclosed dropped elements end at end-of-input; their content was
			// already suppressed during parsing, so release them and continue
			// with the ancestor frames (whose own content is legitimate).
			dropped.length = 0;
			continue;
		}
		if (titleDepth > 0) {
			// Unclosed titles end here; each close strictly decrements.
			while (titleDepth > 0) closeTag("title");
			continue;
		}
		if (preDepth > 0) {
			// Unclosed pres end here; each close strictly decrements and the
			// last one emits the fenced block.
			while (preDepth > 0) closeTag("pre");
			continue;
		}
		const before = stack.length;
		closeTag(frame.tag);
		if (stack.length >= before) stack.pop();
	}
	const finalRoot = top();
	if (finalRoot !== undefined) flushInline(finalRoot);
	const blocks =
		finalRoot !== undefined &&
		(finalRoot.kind === "section" || finalRoot.kind === "quote" || finalRoot.kind === "item")
			? finalRoot.blocks
			: [];

	let visible: TextBlock[];
	if (sawMain) {
		const before = blocks.length;
		visible = blocks.filter((block) => block.inMain);
		// Blocks outside `<main>`/`<article>` are chrome by definition; count them with the drops.
		boilerplateDrops += before - visible.length;
	} else {
		// Rule 4: link-only lists outside the main content are menus.
		const kept: TextBlock[] = [];
		for (const block of blocks) {
			if (block.list && isMenuListBlock(block.text)) menuListsDropped += 1;
			else kept.push(block);
		}
		visible = kept;
		// Rule 5: start at the article when the page offers no main element.
		const h1Indices: number[] = [];
		for (let index = 0; index < visible.length; index += 1) {
			const block = visible[index];
			if (block !== undefined && isH1Block(block.text)) h1Indices.push(index);
		}
		const firstIndex = h1Indices[0];
		if (h1Indices.length === 1 && firstIndex !== undefined && firstIndex > 0) {
			leadingDropped = firstIndex;
			visible = visible.slice(firstIndex);
		} else if (h1Indices.length > 1) {
			let chosen: number | null = null;
			for (let cursor = h1Indices.length - 1; cursor >= 0; cursor -= 1) {
				const index = h1Indices[cursor];
				if (index === undefined) continue;
				let chars = 0;
				for (let next = index + 1; next < visible.length; next += 1) {
					const following = visible[next];
					if (following === undefined) continue;
					if (isH1Block(following.text)) break;
					if (isHeadingBlock(following.text) || following.list) continue;
					chars += following.text.length;
					if (chars >= ARTICLE_H1_MIN_PARAGRAPH_CHARS) break;
				}
				if (chars >= ARTICLE_H1_MIN_PARAGRAPH_CHARS) {
					chosen = index;
					break;
				}
			}
			if (chosen !== null && chosen > 0) {
				leadingDropped = chosen;
				visible = visible.slice(chosen);
			}
		}
	}
	const texts = visible.map((block) => block.text);

	const full = texts.join("\n\n");
	// `overBudget` means blocks were dropped during rendering, so the result is
	// truncated even when what survived fits `maxChars`.
	if (!overBudget && full.length <= maxChars) {
		return { title: titleText ?? firstH1, markdown: full, truncated: false, omitted: omitted() };
	}
	const kept: string[] = [];
	let used = 0;
	for (const text of texts) {
		const separator = kept.length === 0 ? 0 : 2;
		if (used + separator + text.length <= maxChars) {
			kept.push(text);
			used += separator + text.length;
		} else break;
	}
	const first = texts[0];
	const markdown = kept.length === 0 ? cutCodePoints(first ?? "", maxChars) : kept.join("\n\n");
	return { title: titleText ?? firstH1, markdown, truncated: true, omitted: omitted() };
}
