import type { NotebookWidgetOrigin, WidgetCore } from "@research/contracts";
import {
	type MarkdownTableAlignment,
	type MarkdownTextSegment,
	type ParsedMarkdownTable,
	parseMarkdownTables,
} from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import { createMemo, For, type JSX, Show } from "solid-js";
import { notebookModelMessages } from "../notebook/notebook.messages.ts";
import { widgetFromMarkdownTable } from "../notebook/notebookModel.ts";
import { conversationMessages } from "./conversation.messages.ts";

export interface MarkdownTableNotebookSave {
	readonly scopeId: string;
	readonly messageId: string;
	readonly runId: string | null;
	readonly onAddComponent: (core: WidgetCore, origin: NotebookWidgetOrigin) => void;
	readonly componentInNotebook: (componentId: string) => boolean;
	readonly savingIds: readonly string[];
}

function isNumericLookingCell(raw: string): boolean {
	const trimmed = raw.trim();
	if (trimmed === "") return false;
	return /^-?(?:[$¥€£])?[0-9][0-9,]*(?:\.[0-9]+)?%?$/.test(trimmed);
}

function headerAlignClass(alignment: MarkdownTableAlignment): string {
	if (alignment === "right") return "text-right";
	if (alignment === "center") return "text-center";
	return "text-left";
}

function cellAlignClass(alignment: MarkdownTableAlignment, cell: string): string {
	if (alignment === "right") return "text-right";
	if (alignment === "center") return "text-center";
	if (alignment === "left") return "text-left";
	return isNumericLookingCell(cell) ? "text-right" : "text-left";
}

function tableTitleHint(
	segments: readonly MarkdownTextSegment[],
	segmentIndex: number,
	table: ParsedMarkdownTable,
): string {
	const previous = segmentIndex > 0 ? segments[segmentIndex - 1] : undefined;
	if (previous?.kind === "text") {
		const lines = previous.text
			.split("\n")
			.map((line) => line.trim().replace(/[:：]$/, ""))
			.filter((line) => line.length > 0);
		const lastLine = lines.at(-1);
		if (lastLine !== undefined && lastLine.length <= 80) {
			return lastLine;
		}
	}
	return table.columns.join(" · ");
}

function markdownTableComponentId(scopeId: string, tableIndex: number): string {
	return `${scopeId.slice(0, 72)}_mdtable_${tableIndex}`;
}

/**
 * Renders chat reply or claim text with structured GitHub-style Markdown pipe
 * tables while keeping all other content — including any raw HTML markup — as
 * literal plain text (UI-005, SEC-001). Each rendered table can be saved to the
 * Notebook as an editable `table` widget.
 */
export function ChatMarkdownText(props: {
	readonly text: string;
	readonly textClass?: string;
	readonly trailing?: JSX.Element;
	readonly notebookSave?: MarkdownTableNotebookSave | null;
}): JSX.Element {
	const m = useMessages(conversationMessages);
	const notebookWords = useMessages(notebookModelMessages);
	const segments = createMemo(() => parseMarkdownTables(props.text));
	const hasTable = createMemo(() => segments().some((segment) => segment.kind === "table"));
	const paragraphClass = () =>
		`whitespace-pre-wrap wrap-anywhere ${props.textClass ?? "text-sm text-slate-900"}`;

	return (
		<Show
			when={hasTable()}
			fallback={
				<p class={paragraphClass()}>
					{props.text}
					{props.trailing}
				</p>
			}
		>
			<div class="space-y-2">
				<For each={segments()}>
					{(segment, index) => {
						const isLast = () => index() === segments().length - 1;
						if (segment.kind === "text") {
							return (
								<p class={paragraphClass()}>
									{segment.text}
									<Show when={isLast()}>{props.trailing}</Show>
								</p>
							);
						}
						const tableOrdinal = createMemo(
							() =>
								segments()
									.slice(0, index())
									.filter((entry) => entry.kind === "table").length,
						);
						const originComponentId = createMemo(() =>
							markdownTableComponentId(props.notebookSave?.scopeId ?? "chat", tableOrdinal()),
						);
						const inNotebook = () =>
							props.notebookSave?.componentInNotebook(originComponentId()) ?? false;
						const addPending = () =>
							(props.notebookSave?.savingIds ?? []).includes(originComponentId());
						const saveTable = () => {
							const save = props.notebookSave;
							if (save === undefined || save === null) return;
							const hint = tableTitleHint(segments(), index(), segment);
							const widget = widgetFromMarkdownTable(segment, hint, notebookWords().tableTitle);
							save.onAddComponent(widget, {
								kind: "chat",
								messageId: save.messageId,
								runId: save.runId,
								componentId: originComponentId(),
							});
						};

						return (
							<div data-chat-markdown-table="true" class="space-y-1">
								<div class="overflow-x-auto rounded border border-slate-200 bg-white">
									<table class="w-full border-collapse text-sm text-slate-900">
										<thead>
											<tr class="bg-slate-50">
												<For each={segment.columns}>
													{(column, colIndex) => (
														<th
															scope="col"
															class={`border-b border-r border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-900 last:border-r-0 ${headerAlignClass(segment.alignments[colIndex()] ?? null)}`}
														>
															{column}
														</th>
													)}
												</For>
											</tr>
										</thead>
										<tbody>
											<For each={segment.rows}>
												{(row) => (
													<tr class="border-b border-slate-200 last:border-b-0">
														<For each={row}>
															{(cell, colIndex) => (
																<td
																	class={`border-r border-slate-200 px-2.5 py-1.5 text-sm text-slate-900 tabular-nums last:border-r-0 ${cellAlignClass(segment.alignments[colIndex()] ?? null, cell)}`}
																>
																	{cell === "" ? "—" : cell}
																</td>
															)}
														</For>
													</tr>
												)}
											</For>
										</tbody>
									</table>
								</div>
								<Show when={props.notebookSave != null || (isLast() && props.trailing != null)}>
									<div class="flex flex-wrap items-center gap-2">
										<Show when={isLast() && props.trailing != null}>
											<span class="inline-flex flex-wrap gap-1 align-baseline">
												{props.trailing}
											</span>
										</Show>
										<Show when={props.notebookSave != null}>
											<Show
												when={!inNotebook()}
												fallback={
													<span class="inline-flex min-h-6 items-center px-1 py-0.5 text-xs text-slate-600">
														{m().inNotebook}
													</span>
												}
											>
												<button
													type="button"
													data-save-markdown-table="true"
													disabled={addPending()}
													onClick={saveTable}
													class="inline-flex min-h-6 items-center gap-1 rounded px-1 py-0.5 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
												>
													<svg
														aria-hidden="true"
														width="12"
														height="12"
														viewBox="0 0 12 12"
														fill="none"
													>
														<path
															d="M6 1.5v9M1.5 6h9"
															stroke="currentColor"
															stroke-width="1.8"
															stroke-linecap="round"
														/>
													</svg>
													<span>{m().addTableToNotebook}</span>
												</button>
											</Show>
										</Show>
									</div>
								</Show>
							</div>
						);
					}}
				</For>
			</div>
		</Show>
	);
}
