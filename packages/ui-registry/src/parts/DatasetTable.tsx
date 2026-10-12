import type { DatasetCell } from "@research/contracts";
import { createMemo, For, type JSX, Show } from "solid-js";
import {
	CELL_BASIS_MARKER,
	cellBasis,
	cellDisplay,
	type DatasetColumn,
	type GuardedDataset,
} from "../datasetGuard.ts";
import { ComponentCitation, citationGroupFocusOut, useCitationScope } from "./citations.tsx";
import { DateText, SafeLink, type SourceMap, SourceUnavailable } from "./SourceLinks.tsx";
import { EmptyState, Unavailable } from "./states.tsx";

export interface RowSelection {
	readonly selectedKey: string | null;
	readonly onSelect: (itemKey: string | null) => void;
}

export function rowItemKey(rowIndex: number): string {
	return `row-${rowIndex}`;
}

function columnHeading(column: DatasetColumn): string {
	return column.unit === undefined ? column.label : `${column.label} (${column.unit})`;
}

/**
 * A component's cell-cited sources in row-major order, for its citation
 * scope: cells render before the sources block, so their ids number first and
 * the same source keeps one number in cells and in the disclosure.
 */
export function cellSourceIdsInOrder(data: GuardedDataset | undefined): string[] {
	if (data === undefined) return [];
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const row of data.dataset.rows) {
		for (const column of data.dataset.columns) {
			const sourceId = row[column.key]?.sourceId;
			if (sourceId !== undefined && !seen.has(sourceId)) {
				seen.add(sourceId);
				ids.push(sourceId);
			}
		}
	}
	return ids;
}

/**
 * Everything that qualifies a value (hard gate 6): the as-of date and a
 * numbered citation chip for a sourced figure, or a visible marker saying the
 * number is an assumption, a derived value, or (stale data only) of no stated
 * basis.
 */
function CellProvenance(props: {
	readonly cell: DatasetCell;
	readonly sources: SourceMap;
	readonly chipKey: string;
}): JSX.Element {
	const scope = useCitationScope();
	const source = createMemo(() =>
		props.cell.sourceId === undefined ? undefined : props.sources.get(props.cell.sourceId),
	);
	const marker = createMemo(() => {
		const basis = cellBasis(props.cell);
		return basis === null || basis === "sourced" ? null : basis;
	});
	// A sourced number without an as-of date can only be stale data; the gap is stated.
	const asOfMissing = () =>
		cellBasis(props.cell) !== null &&
		props.cell.sourceId !== undefined &&
		props.cell.asOf === undefined;
	return (
		<Show
			when={props.cell.asOf !== undefined || props.cell.sourceId !== undefined || marker() !== null}
		>
			<span class="block text-2xs font-normal text-slate-600">
				<Show when={marker()}>
					{(basis) => (
						<span
							data-cell-basis={basis()}
							class="rounded border border-dashed px-1"
							classList={{
								"border-slate-500 text-slate-800": basis() !== "unstated",
								"border-amber-700 text-amber-900": basis() === "unstated",
							}}
						>
							{CELL_BASIS_MARKER[basis()]}
						</span>
					)}
				</Show>
				<Show when={props.cell.asOf}>
					{(asOf) => (
						<span>
							{" "}
							as of <DateText iso={asOf()} missing="date not stated" />
						</span>
					)}
				</Show>
				<Show when={asOfMissing()}>
					<span data-as-of-missing="true" class="italic text-amber-900">
						{" "}
						as-of date not stated
					</span>
				</Show>
				<Show when={props.cell.sourceId}>
					{(sourceId) => (
						<span>
							{" "}
							<Show
								when={scope !== null}
								fallback={
									<Show when={source()} fallback={<SourceUnavailable sourceId={sourceId()} />}>
										{(evidence) => (
											<SafeLink url={evidence().sourceUrl} label={`Source: ${evidence().title}`}>
												source
											</SafeLink>
										)}
									</Show>
								}
							>
								<ComponentCitation
									sourceId={sourceId()}
									chipKey={`${props.chipKey}::${sourceId()}`}
									sources={props.sources}
								/>
							</Show>
						</span>
					)}
				</Show>
			</span>
		</Show>
	);
}

function CellContent(props: {
	readonly cell: DatasetCell | undefined;
	readonly column: DatasetColumn;
	readonly sources: SourceMap;
	readonly chipKey: string;
}): JSX.Element {
	const display = createMemo(() => cellDisplay(props.cell, props.column));
	const text = () => {
		const current = display();
		return current.available ? current.text : null;
	};
	const reason = () => {
		const current = display();
		return current.available ? "" : current.reason;
	};
	return (
		<>
			<Show when={text() !== null} fallback={<Unavailable reason={reason()} />}>
				<span>{text()}</span>
			</Show>
			<Show when={props.cell}>
				{(cell) => <CellProvenance cell={cell()} sources={props.sources} chipKey={props.chipKey} />}
			</Show>
		</>
	);
}

/**
 * Semantic table for a dataset. Used directly by the table components and as
 * the non-visual fallback of every chart, so the two can never disagree. It
 * only accepts a `GuardedDataset`, i.e. data that already went through the
 * display rules in `datasetGuard.ts`.
 */
export function DatasetTable(props: {
	readonly data: GuardedDataset;
	readonly caption: string;
	readonly sources: SourceMap;
	/** Restricts and orders the columns; unknown keys are ignored. */
	readonly columnKeys?: readonly string[];
	readonly selection?: RowSelection;
	/**
	 * Citation group for this table's cell chips: `${componentId}::table`.
	 * The outer box is the chips' group and their cards' anchor, so cards
	 * float below the table at the table's width, inside the panel.
	 */
	readonly citationGroupKey: string;
}): JSX.Element {
	const dataset = () => props.data.dataset;
	const scope = useCitationScope();
	const hoverEnd = () => scope?.hoverEnd();
	const columns = createMemo((): readonly DatasetColumn[] => {
		const keys = props.columnKeys;
		if (keys === undefined) return dataset().columns;
		const byKey = new Map(dataset().columns.map((column) => [column.key, column] as const));
		return [...new Set(keys)].flatMap((key) => {
			const column = byKey.get(key);
			return column === undefined ? [] : [column];
		});
	});

	return (
		// A figure: the table is self-contained content, and the figure box is
		// the cell chips' citation group and their cards' anchor, so cards
		// float below the table at the table's width, inside the panel.
		<figure
			class="relative m-0 min-w-0"
			data-citation-group={props.citationGroupKey}
			onMouseLeave={hoverEnd}
			onFocusOut={(event) => citationGroupFocusOut(event, hoverEnd)}
		>
			<div class="overflow-x-auto">
				<table class="w-full border-collapse text-left text-sm">
					<caption class="caption-top pb-1 text-left text-xs text-slate-600">
						{props.caption}
					</caption>
					<thead>
						<tr class="border-b border-slate-300 text-xs text-slate-700">
							<Show when={props.selection}>
								<th scope="col" class="py-1 pr-2 font-semibold">
									Select
								</th>
							</Show>
							<For each={columns()}>
								{(column) => (
									<th
										scope="col"
										class="py-1 pr-3 font-semibold"
										classList={{ "text-right": column.kind === "number" }}
									>
										{columnHeading(column)}
									</th>
								)}
							</For>
						</tr>
					</thead>
					<tbody>
						<For each={dataset().rows}>
							{(row, rowIndex) => {
								const itemKey = () => rowItemKey(rowIndex());
								const isSelected = () => props.selection?.selectedKey === itemKey();
								return (
									<tr
										class="border-b border-slate-200 align-top"
										classList={{ "bg-blue-50": isSelected() }}
									>
										<Show when={props.selection}>
											{(selection) => (
												<td class="py-1 pr-2">
													<button
														type="button"
														aria-pressed={isSelected()}
														aria-label={`Select row ${rowIndex() + 1}`}
														class="min-h-6 rounded bg-slate-200 px-1.5 text-xs text-slate-900 hover:bg-slate-300"
														onClick={() => selection().onSelect(isSelected() ? null : itemKey())}
													>
														{isSelected() ? "Selected" : "Select"}
													</button>
												</td>
											)}
										</Show>
										<For each={columns()}>
											{(column, columnIndex) => (
												<Show
													when={columnIndex() === 0}
													fallback={
														<td
															class="py-1 pr-3"
															classList={{ "text-right tabular-nums": column.kind === "number" }}
														>
															<CellContent
																cell={row[column.key]}
																column={column}
																sources={props.sources}
																chipKey={`${props.citationGroupKey}::r${rowIndex()}::${column.key}`}
															/>
														</td>
													}
												>
													<th scope="row" class="py-1 pr-3 font-medium">
														<CellContent
															cell={row[column.key]}
															column={column}
															sources={props.sources}
															chipKey={`${props.citationGroupKey}::r${rowIndex()}::${column.key}`}
														/>
													</th>
												</Show>
											)}
										</For>
									</tr>
								);
							}}
						</For>
					</tbody>
				</table>
				<Show when={dataset().rows.length === 0}>
					<EmptyState>No rows — this dataset is empty.</EmptyState>
				</Show>
			</div>
		</figure>
	);
}
