import type { DOMOutputSpec } from "prosemirror-model";
import { Schema } from "prosemirror-model";

/**
 * ProseMirror schema for the `WIDGET_TEXT_MARKDOWN` subset (ADR-0021).
 * It mirrors `model.ts` exactly — paragraph, headings 1–3, bullet and
 * numbered lists, to-do lists, blockquote, code block, divider, hard break;
 * marks strong, em, strike, code and link (href limited to http/https/mailto
 * at conversion time) — so the document converts losslessly through the
 * typed tree (`parser.ts` ⇄ `docConvert.ts` ⇄ `serializer.ts`).
 *
 * Nesting is deliberately flat: list items hold exactly one paragraph and
 * quotes hold paragraphs only. Anything deeper has no Markdown form, so the
 * schema refuses to build it instead of dropping content on save.
 *
 * The rendered classes match `RichTextView`, so a block looks identical
 * while reading and while editing. Positioning and ornament stay in
 * `apps/web/src/styles.css`: the editor sets no inline style attributes and
 * injects no `<style>`, keeping the app's `style-src 'self'` CSP intact.
 */
/**
 * A to-do item's DOM. The checkbox's accessible name is UI text in the
 * current language, so the editor's node view passes it (`toggleLabel`);
 * the schema's own rendering (clipboard HTML) has none.
 */
export function todoItemDOM(checked: boolean, toggleLabel: string | null): DOMOutputSpec {
	return [
		"li",
		{
			class: "flex items-start gap-2",
			"data-todo-item": checked ? "checked" : "open",
		},
		[
			"input",
			{
				type: "checkbox",
				class: "rich-text-todo mt-0.5 shrink-0",
				contenteditable: "false",
				// Mouse-only inside the editor: keyboard toggling
				// lives in the read view (a focused checkbox that
				// ProseMirror re-renders would drop focus to the
				// body, which reads as "leave the editor").
				tabindex: "-1",
				...(toggleLabel === null ? {} : { "aria-label": toggleLabel }),
				...(checked ? { checked: "" } : {}),
			},
		],
		[
			"div",
			{
				class: checked ? "min-w-0 flex-1 text-slate-600 line-through" : "min-w-0 flex-1",
			},
			0,
		],
	];
}

export const richTextSchema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph: {
			content: "inline*",
			group: "block",
			toDOM: (): DOMOutputSpec => ["p", { class: "whitespace-pre-wrap" }, 0],
			parseDOM: [{ tag: "p" }],
		},
		heading: {
			attrs: { level: { default: 1 } },
			content: "inline*",
			group: "block",
			defining: true,
			toDOM: (node): DOMOutputSpec => {
				const level = node.attrs.level === 2 ? 2 : node.attrs.level === 3 ? 3 : 1;
				const tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
				const size =
					level === 1
						? "text-lg font-semibold text-slate-900"
						: level === 2
							? "text-base font-semibold text-slate-900"
							: "text-sm font-semibold text-slate-900";
				return [tag, { class: size }, 0];
			},
			parseDOM: [
				{ tag: "h1", attrs: { level: 1 } },
				{ tag: "h2", attrs: { level: 2 } },
				{ tag: "h3", attrs: { level: 3 } },
			],
		},
		bullet_list: {
			content: "list_item+",
			group: "block",
			toDOM: (): DOMOutputSpec => ["ul", { class: "list-disc space-y-1 pl-5" }, 0],
			parseDOM: [{ tag: "ul:not([data-todo-list])" }],
		},
		ordered_list: {
			content: "list_item+",
			group: "block",
			toDOM: (): DOMOutputSpec => ["ol", { class: "list-decimal space-y-1 pl-5" }, 0],
			parseDOM: [{ tag: "ol" }],
		},
		list_item: {
			content: "paragraph",
			toDOM: (): DOMOutputSpec => ["li", 0],
			parseDOM: [{ tag: "li:not([data-todo-item])" }],
		},
		todo_list: {
			content: "todo_item+",
			group: "block",
			toDOM: (): DOMOutputSpec => ["ul", { class: "list-none space-y-1 pl-0" }, 0],
			parseDOM: [{ tag: "ul[data-todo-list]" }],
		},
		todo_item: {
			attrs: { checked: { default: false } },
			content: "paragraph",
			toDOM: (node): DOMOutputSpec => todoItemDOM(node.attrs.checked === true, null),
			parseDOM: [{ tag: "li[data-todo-item]" }],
		},
		blockquote: {
			content: "paragraph+",
			group: "block",
			defining: true,
			toDOM: (): DOMOutputSpec => [
				"blockquote",
				{ class: "border-l-2 border-slate-300 pl-3 text-slate-700" },
				0,
			],
			parseDOM: [{ tag: "blockquote" }],
		},
		code_block: {
			attrs: { language: { default: "" } },
			content: "text*",
			marks: "",
			group: "block",
			code: true,
			defining: true,
			toDOM: (): DOMOutputSpec => [
				"pre",
				{ class: "overflow-x-auto rounded bg-slate-100 p-2 font-mono text-xs text-slate-900" },
				["code", 0],
			],
			parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
		},
		horizontal_rule: {
			group: "block",
			toDOM: (): DOMOutputSpec => ["hr", { class: "border-slate-200" }],
			parseDOM: [{ tag: "hr" }],
		},
		text: { group: "inline" },
		hard_break: {
			inline: true,
			group: "inline",
			selectable: false,
			toDOM: (): DOMOutputSpec => ["br"],
			parseDOM: [{ tag: "br" }],
		},
	},
	marks: {
		strong: {
			toDOM: (): DOMOutputSpec => ["strong", 0],
			parseDOM: [{ tag: "strong" }, { tag: "b", getAttrs: () => null }],
		},
		em: {
			toDOM: (): DOMOutputSpec => ["em", 0],
			parseDOM: [{ tag: "em" }, { tag: "i", getAttrs: () => null }],
		},
		strike: {
			toDOM: (): DOMOutputSpec => ["s", 0],
			parseDOM: [{ tag: "s" }, { tag: "del", getAttrs: () => null }],
		},
		code: {
			toDOM: (): DOMOutputSpec => ["code", { class: "rounded bg-slate-100 px-0.5 font-mono" }, 0],
			parseDOM: [{ tag: "code" }],
		},
		link: {
			attrs: { href: { default: "" } },
			inclusive: false,
			toDOM: (mark): DOMOutputSpec => [
				"a",
				{
					href: typeof mark.attrs.href === "string" ? mark.attrs.href : "",
					target: "_blank",
					rel: "noopener noreferrer",
					class: "text-blue-700 underline",
				},
				0,
			],
			parseDOM: [
				{
					tag: "a[href]",
					getAttrs: (dom: string | HTMLElement) => {
						if (typeof dom === "string") return false;
						const href = dom.getAttribute("href") ?? "";
						// The subset admits only these schemes; anything else
						// (notably `javascript:`) must not become a link.
						if (!/^(https?:|mailto:)/i.test(href) || /[\s<>]/.test(href)) return false;
						return { href };
					},
				},
			],
		},
	},
});

export type RichTextSchema = typeof richTextSchema;
