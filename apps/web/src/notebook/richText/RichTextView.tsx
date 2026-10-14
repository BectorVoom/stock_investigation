import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { type BlockNode, type InlineNode, plainText } from "./model.ts";

/**
 * Renders a parsed document with real elements, never `innerHTML`: every
 * string reaches the DOM as a text node or a validated `href`, so hostile
 * markup from the assistant or an import stays inert text.
 */
export function RichTextInline(props: { readonly nodes: readonly InlineNode[] }): JSX.Element {
	return (
		<For each={props.nodes}>
			{(node) => {
				if (node.kind === "text") return <>{node.text}</>;
				if (node.kind === "strong")
					return (
						<strong>
							<RichTextInline nodes={node.children} />
						</strong>
					);
				if (node.kind === "em")
					return (
						<em>
							<RichTextInline nodes={node.children} />
						</em>
					);
				if (node.kind === "strike")
					return (
						<s>
							<RichTextInline nodes={node.children} />
						</s>
					);
				if (node.kind === "code")
					return <code class="rounded bg-slate-100 px-0.5 font-mono">{node.text}</code>;
				return (
					<a
						href={node.href}
						target="_blank"
						rel="noopener noreferrer"
						class="text-blue-700 underline"
					>
						<RichTextInline nodes={node.label} />
					</a>
				);
			}}
		</For>
	);
}

/** One source line break inside a paragraph or quote (legacy text relies on it). */
function LineBreak(): JSX.Element {
	return <br />;
}

function InlineLines(props: { readonly lines: readonly (readonly InlineNode[])[] }): JSX.Element {
	return (
		<For each={props.lines}>
			{(line, index) => (
				<>
					<Show when={index() > 0}>
						<LineBreak />
					</Show>
					<RichTextInline nodes={line} />
				</>
			)}
		</For>
	);
}

export function RichTextView(props: {
	readonly doc: { readonly blocks: readonly BlockNode[] };
	/** Source line of a toggled to-do, or null when checkboxes stay read-only. */
	readonly onToggleTodo: ((line: number) => void) | null;
	readonly checkboxesDisabled: boolean;
}): JSX.Element {
	return (
		<div data-rich-text-view class="space-y-2">
			<For each={props.doc.blocks}>
				{(block) => {
					if (block.kind === "heading" && block.level === 1)
						return (
							<h1 class="text-lg font-semibold text-slate-900">
								<RichTextInline nodes={block.inline} />
							</h1>
						);
					if (block.kind === "heading" && block.level === 2)
						return (
							<h2 class="text-base font-semibold text-slate-900">
								<RichTextInline nodes={block.inline} />
							</h2>
						);
					if (block.kind === "heading")
						return (
							<h3 class="text-sm font-semibold text-slate-900">
								<RichTextInline nodes={block.inline} />
							</h3>
						);
					if (block.kind === "paragraph")
						return (
							<p class="whitespace-pre-wrap">
								<InlineLines lines={block.lines} />
							</p>
						);
					if (block.kind === "bullet")
						return (
							<ul class="list-disc space-y-1 pl-5">
								<For each={block.items}>
									{(item) => (
										<li>
											<RichTextInline nodes={item.inline} />
										</li>
									)}
								</For>
							</ul>
						);
					if (block.kind === "ordered")
						return (
							<ol class="list-decimal space-y-1 pl-5">
								<For each={block.items}>
									{(item) => (
										<li>
											<RichTextInline nodes={item.inline} />
										</li>
									)}
								</For>
							</ol>
						);
					if (block.kind === "todo")
						return (
							<ul class="list-none space-y-1 pl-0">
								<For each={block.items}>
									{(item) => (
										<li class="flex items-start gap-2">
											<input
												type="checkbox"
												class="rich-text-todo mt-0.5 shrink-0"
												checked={item.checked}
												disabled={props.onToggleTodo === null || props.checkboxesDisabled}
												aria-label={`To-do: ${plainText(item.inline)}`}
												onChange={() => props.onToggleTodo?.(item.line)}
											/>
											<span classList={{ "text-slate-500 line-through": item.checked }}>
												<RichTextInline nodes={item.inline} />
											</span>
										</li>
									)}
								</For>
							</ul>
						);
					if (block.kind === "quote")
						return (
							<blockquote class="border-l-2 border-slate-300 pl-3 text-slate-700">
								<InlineLines lines={block.lines} />
							</blockquote>
						);
					if (block.kind === "code")
						return (
							<pre class="overflow-x-auto rounded bg-slate-100 p-2 font-mono text-xs text-slate-900">
								<code>{block.code}</code>
							</pre>
						);
					return <hr class="border-slate-200" />;
				}}
			</For>
		</div>
	);
}
