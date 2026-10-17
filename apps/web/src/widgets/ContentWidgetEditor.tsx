import {
	WIDGET_LIMITS,
	WIDGET_TYPE_META,
	type WidgetCore,
	widgetCoreSchema,
} from "@research/contracts";
import { WidgetSizePicker } from "@research/widget-grid";
import {
	createSignal,
	createUniqueId,
	For,
	type JSX,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { BUTTON, BUTTON_PRIMARY, INPUT, LABEL } from "../components/ui.tsx";
import { carryChartProvenance } from "./widgetModel.ts";

interface ChartSeriesDraft {
	name: string;
	points: { x: string; y: number }[];
}

/**
 * One native-dialog editor per content widget type, the same on Home and in
 * the Notebook (ADR-0024); validates with the contract schemas before
 * saving. Live market widgets open the market dialog instead.
 */
export function ContentWidgetEditor(props: {
	readonly widget: WidgetCore;
	readonly opener: HTMLElement | null;
	readonly onSave: (core: WidgetCore) => Promise<boolean>;
	readonly onClose: () => void;
}): JSX.Element {
	const headingId = createUniqueId();
	let dialog: HTMLDialogElement | undefined;
	const [title, setTitle] = createSignal(props.widget.title);
	const [size, setSize] = createSignal<WidgetCore["size"]>(props.widget.size);
	const [problems, setProblems] = createSignal<readonly string[]>([]);
	const [saveError, setSaveError] = createSignal<string | null>(null);
	const [saving, setSaving] = createSignal(false);

	// Per-type drafts, initialised once from the widget being edited.
	const [text, setText] = createSignal(props.widget.type === "text" ? props.widget.text : "");
	const [metricValue, setMetricValue] = createSignal(
		props.widget.type === "metric" && props.widget.value !== null ? String(props.widget.value) : "",
	);
	const [metricUnit, setMetricUnit] = createSignal(
		props.widget.type === "metric" ? props.widget.unit : "",
	);
	const [metricChange, setMetricChange] = createSignal(
		props.widget.type === "metric" && props.widget.change !== null
			? String(props.widget.change)
			: "",
	);
	const [metricCaption, setMetricCaption] = createSignal(
		props.widget.type === "metric" ? props.widget.caption : "",
	);
	const [metricAsOf, setMetricAsOf] = createSignal(
		props.widget.type === "metric" ? (props.widget.asOf ?? "") : "",
	);
	const [chartType, setChartType] = createSignal<"line" | "bar">(
		props.widget.type === "chart" ? props.widget.chartType : "line",
	);
	const [chartUnit, setChartUnit] = createSignal(
		props.widget.type === "chart" ? props.widget.unit : "",
	);
	const [chartText, setChartText] = createSignal(
		props.widget.type === "chart" ? seriesToText(props.widget.series) : "",
	);
	const [tableColumns, setTableColumns] = createSignal(
		props.widget.type === "table" ? props.widget.columns.join(", ") : "",
	);
	const [tableRows, setTableRows] = createSignal(
		props.widget.type === "table"
			? props.widget.rows
					.map((row) => row.map((cell) => (cell === null ? "" : String(cell))).join(", "))
					.join("\n")
			: "",
	);

	const closeToOpener = () => {
		props.opener?.focus();
	};

	onMount(() => {
		dialog?.showModal();
	});
	onCleanup(() => {
		if (dialog?.open === true) dialog.close();
	});

	const describeIssues = (
		issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
	): readonly string[] =>
		issues.map((issue) => `${issue.path.map(String).join(".") || "widget"}: ${issue.message}`);

	const save = async (): Promise<void> => {
		setSaveError(null);
		const core = buildCore();
		if (core === null) return;
		const parsed = widgetCoreSchema.safeParse(core);
		if (!parsed.success) {
			setProblems(describeIssues(parsed.error.issues));
			return;
		}
		setProblems([]);
		setSaving(true);
		try {
			const saved = await props.onSave(parsed.data);
			if (saved) {
				props.onClose();
				closeToOpener();
			} else {
				setSaveError("The widget was not saved. The notice above the widgets says why.");
			}
		} finally {
			setSaving(false);
		}
	};

	/** Builds the edited core, or null after recording structural parse problems. */
	const buildCore = (): WidgetCore | null => {
		const widgetId = props.widget.widgetId;
		const trimmedTitle = title().trim();
		const widgetSize = size();
		const widget = props.widget;
		if (widget.type === "text") {
			return { widgetId, type: "text", title: trimmedTitle, size: widgetSize, text: text() };
		}
		if (widget.type === "metric") {
			const value = parseOptionalNumber(metricValue(), "Value");
			if (value === undefined) return null;
			const change = parseOptionalNumber(metricChange(), "Change");
			if (change === undefined) return null;
			const asOf = metricAsOf().trim() === "" ? null : metricAsOf().trim();
			return {
				widgetId,
				type: "metric",
				title: trimmedTitle,
				size: widgetSize,
				value,
				unit: metricUnit(),
				change,
				caption: metricCaption(),
				asOf,
			};
		}
		if (widget.type === "chart") {
			const series = parseSeriesText(chartText());
			if (series === null) return null;
			return {
				widgetId,
				type: "chart",
				title: trimmedTitle,
				size: widgetSize,
				chartType: chartType(),
				unit: chartUnit(),
				...carryChartProvenance(widget, series, chartUnit()),
				...(widget.xLabel === undefined ? {} : { xLabel: widget.xLabel }),
				...(widget.yLabel === undefined ? {} : { yLabel: widget.yLabel }),
				...(widget.xKind === undefined ? {} : { xKind: widget.xKind }),
			};
		}
		if (widget.type === "table") {
			const parsed = parseTableText(tableColumns(), tableRows());
			if (parsed === null) return null;
			return { widgetId, type: "table", title: trimmedTitle, size: widgetSize, ...parsed };
		}
		// Research widgets are read-only: only the title and size are editable.
		if (widget.type === "research") {
			return {
				widgetId,
				type: "research",
				title: trimmedTitle,
				size: widgetSize,
				componentId: widget.componentId,
			};
		}
		// A live market widget keeps its series and options here: the
		// market dialog edits those; this editor changes only title and size.
		return { ...widget, title: trimmedTitle, size: widgetSize };
	};

	const parseOptionalNumber = (raw: string, field: string): number | null | undefined => {
		const trimmed = raw.trim();
		if (trimmed === "") return null;
		const value = Number(trimmed);
		if (!Number.isFinite(value)) {
			setProblems([`${field}: enter a number or leave it empty.`]);
			return undefined;
		}
		return value;
	};

	const parseSeriesText = (raw: string): ChartSeriesDraft[] | null => {
		const blocks = raw
			.split(/\n\s*\n/)
			.map((block) => block.trim())
			.filter((block) => block.length > 0);
		const errors: string[] = [];
		const series = blocks.flatMap((block, blockIndex) => {
			const lines = block
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			const name = lines[0] ?? "";
			if (name === "") {
				errors.push(`Series ${blockIndex + 1}: give the series a name on its first line.`);
				return [];
			}
			const points = lines.slice(1).flatMap((line, lineIndex) => {
				const comma = line.indexOf(",");
				if (comma < 0) {
					errors.push(`Series "${name}" line ${lineIndex + 1}: use "label, value".`);
					return [];
				}
				const x = line.slice(0, comma).trim();
				const y = Number(line.slice(comma + 1).trim());
				if (x === "" || !Number.isFinite(y)) {
					errors.push(`Series "${name}" line ${lineIndex + 1}: use "label, value" with a number.`);
					return [];
				}
				return [{ x, y }];
			});
			if (points.length === 0) {
				errors.push(`Series "${name}": add at least one "label, value" line.`);
				return [];
			}
			return [{ name, points }];
		});
		if (errors.length > 0) {
			setProblems(errors);
			return null;
		}
		if (series.length === 0) {
			setProblems(['Series: add one block per series: the name, then "label, value" lines.']);
			return null;
		}
		return series;
	};

	const parseTableText = (
		columnsRaw: string,
		rowsRaw: string,
	): { readonly columns: string[]; readonly rows: (string | number | null)[][] } | null => {
		const columns = columnsRaw
			.split(",")
			.map((column) => column.trim())
			.filter((column) => column.length > 0);
		if (columns.length === 0) {
			setProblems(["Columns: list at least one column name, separated by commas."]);
			return null;
		}
		const errors: string[] = [];
		const rows = rowsRaw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line, lineIndex) => {
				const cells = line.split(",").map((cell) => parseTableCell(cell.trim()));
				if (cells.length !== columns.length) {
					errors.push(`Row ${lineIndex + 1}: needs ${columns.length} cells, has ${cells.length}.`);
				}
				return cells;
			});
		if (errors.length > 0) {
			setProblems(errors);
			return null;
		}
		return { columns, rows };
	};

	const problemsId = createUniqueId();

	return (
		<dialog
			ref={(element) => {
				dialog = element;
			}}
			aria-labelledby={headingId}
			class="rounded bg-slate-100 p-4"
			onCancel={(event) => {
				event.preventDefault();
				props.onClose();
				closeToOpener();
			}}
			onClose={() => closeToOpener()}
		>
			<h3 id={headingId} class="text-base font-semibold text-slate-900">
				Edit {WIDGET_TYPE_META[props.widget.type].label.toLowerCase()} widget
			</h3>
			<div class="mt-2 max-w-md space-y-2">
				<Show when={problems().length > 0}>
					<ul
						id={problemsId}
						aria-label="Problems"
						class="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900"
					>
						<For each={problems()}>{(problem) => <li>{problem}</li>}</For>
					</ul>
				</Show>
				<Show when={saveError()}>{(error) => <p class="text-xs text-red-900">{error()}</p>}</Show>
				<div>
					<label for={`${headingId}-title`} class={LABEL}>
						Title
					</label>
					<input
						id={`${headingId}-title`}
						type="text"
						class={INPUT}
						maxLength={WIDGET_LIMITS.maxTitleChars}
						value={title()}
						onInput={(event) => setTitle(event.currentTarget.value)}
					/>
				</div>
				<WidgetSizePicker
					value={size()}
					sizes={[...WIDGET_TYPE_META[props.widget.type].sizes]}
					label={`Size of “${props.widget.title}”`}
					onChange={setSize}
				/>
				<Switch>
					<Match when={props.widget.type === "text"}>
						<div>
							<label for={`${headingId}-text`} class={LABEL}>
								Text (Markdown)
							</label>
							<textarea
								id={`${headingId}-text`}
								class={INPUT}
								rows={6}
								maxLength={WIDGET_LIMITS.maxTextChars}
								aria-describedby={`${headingId}-text-hint`}
								value={text()}
								onInput={(event) => setText(event.currentTarget.value)}
							/>
							<p id={`${headingId}-text-hint`} class="mt-1 text-xs text-slate-600">
								Markdown: # / ## / ### headings, **bold**, *italic*, ~~strike~~, `code`,
								[label](https://…) links, - bullets, 1. numbered, - [ ] to-dos, &gt; quotes, ```
								code blocks, --- dividers.
							</p>
						</div>
					</Match>
					<Match when={props.widget.type === "metric"}>
						<div class="space-y-2">
							<div>
								<label for={`${headingId}-value`} class={LABEL}>
									Value (empty means unavailable)
								</label>
								<input
									id={`${headingId}-value`}
									type="text"
									inputmode="decimal"
									class={INPUT}
									value={metricValue()}
									onInput={(event) => setMetricValue(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-unit`} class={LABEL}>
									Unit
								</label>
								<input
									id={`${headingId}-unit`}
									type="text"
									class={INPUT}
									maxLength={WIDGET_LIMITS.maxUnitChars}
									value={metricUnit()}
									onInput={(event) => setMetricUnit(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-change`} class={LABEL}>
									Change (empty means unknown)
								</label>
								<input
									id={`${headingId}-change`}
									type="text"
									inputmode="decimal"
									class={INPUT}
									value={metricChange()}
									onInput={(event) => setMetricChange(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-caption`} class={LABEL}>
									Caption
								</label>
								<input
									id={`${headingId}-caption`}
									type="text"
									class={INPUT}
									maxLength={WIDGET_LIMITS.maxCaptionChars}
									value={metricCaption()}
									onInput={(event) => setMetricCaption(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-asof`} class={LABEL}>
									As-of date (YYYY-MM-DD, empty means unstated)
								</label>
								<input
									id={`${headingId}-asof`}
									type="text"
									inputmode="numeric"
									class={INPUT}
									value={metricAsOf()}
									onInput={(event) => setMetricAsOf(event.currentTarget.value)}
								/>
							</div>
						</div>
					</Match>
					<Match when={props.widget.type === "chart"}>
						<div class="space-y-2">
							<div>
								<label for={`${headingId}-charttype`} class={LABEL}>
									Chart type
								</label>
								<select
									id={`${headingId}-charttype`}
									class="min-h-6 w-full rounded border border-slate-400 bg-white px-2 py-1 text-sm text-slate-900"
									value={chartType()}
									onChange={(event) => setChartType(event.currentTarget.value as "line" | "bar")}
								>
									<option value="line">Line</option>
									<option value="bar">Bar</option>
								</select>
							</div>
							<div>
								<label for={`${headingId}-chartunit`} class={LABEL}>
									Unit
								</label>
								<input
									id={`${headingId}-chartunit`}
									type="text"
									class={INPUT}
									maxLength={WIDGET_LIMITS.maxUnitChars}
									value={chartUnit()}
									onInput={(event) => setChartUnit(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-series`} class={LABEL}>
									Series (one block per series: the name, then “label, value” lines)
								</label>
								<textarea
									id={`${headingId}-series`}
									class={`${INPUT} font-mono`}
									rows={8}
									value={chartText()}
									onInput={(event) => setChartText(event.currentTarget.value)}
								/>
							</div>
						</div>
					</Match>
					<Match when={props.widget.type === "table"}>
						<div class="space-y-2">
							<div>
								<label for={`${headingId}-columns`} class={LABEL}>
									Columns (comma-separated)
								</label>
								<input
									id={`${headingId}-columns`}
									type="text"
									class={INPUT}
									value={tableColumns()}
									onInput={(event) => setTableColumns(event.currentTarget.value)}
								/>
							</div>
							<div>
								<label for={`${headingId}-rows`} class={LABEL}>
									Rows (one line per row, comma-separated)
								</label>
								<textarea
									id={`${headingId}-rows`}
									class={`${INPUT} font-mono`}
									rows={6}
									value={tableRows()}
									onInput={(event) => setTableRows(event.currentTarget.value)}
								/>
							</div>
						</div>
					</Match>
					<Match when={props.widget.type === "research"}>
						<p class="text-xs text-slate-600">
							Research content is read-only; only the title and size can be changed here.
						</p>
					</Match>
				</Switch>
			</div>
			<div class="mt-3 flex gap-2">
				<button
					type="button"
					class={BUTTON}
					disabled={saving()}
					onClick={() => {
						props.onClose();
						closeToOpener();
					}}
				>
					Cancel
				</button>
				<button
					type="button"
					class={BUTTON_PRIMARY}
					disabled={saving()}
					aria-describedby={problems().length > 0 ? problemsId : undefined}
					onClick={() => void save()}
				>
					{saving() ? "Saving…" : "Save widget"}
				</button>
			</div>
		</dialog>
	);
}

function seriesToText(
	series: readonly {
		readonly name: string;
		readonly points: readonly { readonly x: string; readonly y: number }[];
	}[],
): string {
	return series
		.map((entry) =>
			[entry.name, ...entry.points.map((point) => `${point.x}, ${point.y}`)].join("\n"),
		)
		.join("\n\n");
}

function parseTableCell(token: string): string | number | null {
	if (token === "") return null;
	if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(token)) {
		const value = Number(token);
		if (Number.isFinite(value)) return value;
	}
	return token.slice(0, WIDGET_LIMITS.maxCellChars);
}
