import type { NotebookWidget } from "@research/contracts";
import type { JSX } from "solid-js";
import { For } from "solid-js";

type TableWidget = Extract<NotebookWidget, { readonly type: "table" }>;

function cellText(cell: string | number | null): string {
	if (cell === null) return "—";
	return typeof cell === "number" ? String(cell) : cell;
}

function isNumberCell(cell: string | number | null): boolean {
	return typeof cell === "number";
}

/** Structured rows under named columns; scrolls inside the frame, numbers right-aligned. */
export function TableWidget(props: { readonly widget: TableWidget }): JSX.Element {
	const widget = () => props.widget;
	return (
		<div data-widget-body="table" class="overflow-auto">
			<table class="w-full border-collapse text-sm text-slate-900">
				<caption class="text-left text-2xs text-slate-600">{`${widget().columns.length} columns, ${widget().rows.length} rows`}</caption>
				<thead>
					<tr>
						<For each={widget().columns}>
							{(column) => (
								<th
									scope="col"
									class="border border-slate-200 px-2 py-1 text-left text-xs font-semibold"
								>
									{column}
								</th>
							)}
						</For>
					</tr>
				</thead>
				<tbody>
					<For each={widget().rows}>
						{(row) => (
							<tr>
								<For each={row}>
									{(cell) => (
										<td
											class="border border-slate-200 px-2 py-1 text-sm tabular-nums"
											classList={{
												"text-right": isNumberCell(cell),
												"text-left": !isNumberCell(cell),
											}}
										>
											{cellText(cell)}
										</td>
									)}
								</For>
							</tr>
						)}
					</For>
				</tbody>
			</table>
		</div>
	);
}
