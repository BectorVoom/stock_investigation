import type { NotebookWidget } from "@research/contracts";
import type { JSX } from "solid-js";
import { For, Show } from "solid-js";

/** Editable plain text: paragraphs separated by blank lines. */
export function TextWidget(props: {
	readonly widget: Extract<NotebookWidget, { readonly type: "text" }>;
}): JSX.Element {
	const paragraphs = () =>
		props.widget.text
			.split(/\n\s*\n/)
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
	const size = () => props.widget.size;
	return (
		<div
			data-widget-body="text"
			classList={{
				"text-xs text-slate-800": size() === "small",
				"text-sm text-slate-900": size() !== "small",
				"max-w-prose": size() === "large",
			}}
		>
			<Show
				when={size() === "small"}
				fallback={
					<div class="space-y-2">
						<For each={paragraphs()}>
							{(paragraph) => <p class="whitespace-pre-wrap">{paragraph}</p>}
						</For>
					</div>
				}
			>
				<div class="relative max-h-24 overflow-hidden">
					<div class="space-y-1">
						<For each={paragraphs()}>
							{(paragraph) => <p class="whitespace-pre-wrap">{paragraph}</p>}
						</For>
					</div>
					<div
						aria-hidden="true"
						class="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-white to-transparent"
					/>
				</div>
			</Show>
		</div>
	);
}
