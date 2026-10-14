import {
	type EarningsCalendarDaysAhead,
	type HomeDashboard,
	type HomeWidget,
	type MarketCatalogEntry,
	type MarketProviderId,
	type MarketRange,
	type MarketSeries,
	parseMarketSeriesId,
} from "@research/contracts";
import { createMemo, createSignal, For, type JSX, onMount, Show } from "solid-js";
import { DisclosureSummary, IconButton } from "../components/ui.tsx";
import { HOME_RANGE_LABELS, HOME_RANGES, widgetSeriesIds } from "./homeModel.ts";
import "./shoelace.ts";
import { WIDGET_SIZE_SHAPES } from "@research/widget-grid/core";
import { HOME_WIDGET_TYPES, type HomeWidgetType, WIDGET_REGISTRY } from "./widgetRegistry.tsx";

export type WidgetDialogState =
	| { readonly mode: "add" }
	| { readonly mode: "edit"; readonly widget: HomeWidget }
	| { readonly mode: "confirm-reset" };

const PROVIDERS: readonly MarketProviderId[] = ["fred", "twelve-data"];

const PROVIDER_SYMBOLS: { readonly [P in MarketProviderId]: string } = {
	fred: "e.g. VIXCLS",
	"twelve-data": "e.g. AAPL, XAU/USD, 7203:JPX",
};

const CATEGORY_LABELS: { readonly [C in MarketCatalogEntry["category"]]: string } = {
	volatility: "Volatility",
	rates: "Rates",
	inflation: "Inflation",
	labour: "Labour",
	growth: "Growth",
	"equity-index": "Equity indices",
	fx: "Currencies",
	commodity: "Commodities",
	equity: "Equities",
};

/** Days-ahead choices for the earnings calendar (contract `daysAhead` union). */
const DAYS_AHEAD_OPTIONS: readonly EarningsCalendarDaysAhead[] = [30, 60, 90, 180];

interface OptionGroup {
	readonly key: string;
	readonly label: string;
	readonly options: readonly MarketCatalogEntry[];
}

/**
 * Add / edit / reset-confirm dialog (`sl-dialog`). Problems are listed the
 * way other forms do it (`ul[aria-label="Before you can …"]`, save described
 * by it). Focus moves into the dialog on open and returns to the explicit
 * opener on close (Safari never focuses the clicked button itself, guideline
 * 9a — hence the explicit opener, never `document.activeElement`).
 */
export function WidgetDialog(props: {
	readonly state: WidgetDialogState | null;
	/** Element that opened the dialog; focus returns to it on close. */
	readonly opener: HTMLElement | null;
	readonly dashboard: HomeDashboard;
	readonly catalog: readonly MarketCatalogEntry[] | null;
	readonly catalogState: "loading" | "ready" | "error";
	readonly seriesById: ReadonlyMap<string, MarketSeries>;
	readonly onSave: (widget: HomeWidget) => void;
	readonly onConfirmReset: () => void;
	readonly onClose: () => void;
}): JSX.Element {
	const current = () => props.state;
	const opened = () => current() !== null;
	return (
		<Show when={opened()} fallback={null}>
			<DialogBody
				state={current() ?? { mode: "add" }}
				opener={props.opener}
				dashboard={props.dashboard}
				catalog={props.catalog}
				catalogState={props.catalogState}
				seriesById={props.seriesById}
				onSave={props.onSave}
				onConfirmReset={props.onConfirmReset}
				onClose={props.onClose}
			/>
		</Show>
	);
}

/**
 * Focuses the first field of an open dialog. Runs on mount (rAF, so the
 * Shoelace upgrade and open transition have settled) rather than on
 * `sl-after-show`: a dialog rendered already `open` does not reliably emit
 * the show events in every engine. The show-event handler stays as a backup.
 */
function useInitialFocus(): void {
	onMount(() => {
		requestAnimationFrame(() => {
			const dialog = document.querySelector("sl-dialog");
			const field = dialog?.querySelector("sl-input, sl-select");
			if (field instanceof HTMLElement) field.focus({ preventScroll: true });
		});
	});
}

function focusFirstField(event: Event): void {
	// H1: every Shoelace event bubbles and is composed — sl-select emits
	// sl-after-show/hide when its listbox opens/closes. Only the dialog's own
	// event (target === currentTarget) may move focus.
	if (event.target !== event.currentTarget) return;
	const root = event.currentTarget;
	if (root instanceof HTMLElement) {
		const field = root.querySelector("sl-input, sl-select");
		if (field instanceof HTMLElement) field.focus({ preventScroll: true });
	}
}

/** True only for the element's own Shoelace event, not a bubbled nested one (H1). */
export function isDirectShoelaceEvent(event: Event): boolean {
	return event.target === event.currentTarget;
}

function DialogBody(props: {
	readonly state: WidgetDialogState;
	readonly opener: HTMLElement | null;
	readonly dashboard: HomeDashboard;
	readonly catalog: readonly MarketCatalogEntry[] | null;
	readonly catalogState: "loading" | "ready" | "error";
	readonly seriesById: ReadonlyMap<string, MarketSeries>;
	readonly onSave: (widget: HomeWidget) => void;
	readonly onConfirmReset: () => void;
	readonly onClose: () => void;
}): JSX.Element {
	const closeAndReturnFocus = (event?: Event) => {
		// H1: a bubbled sl-after-hide from a nested sl-select listbox must not
		// close the dialog (nor steal focus handling).
		if (event !== undefined && !isDirectShoelaceEvent(event)) return;
		props.onClose();
		props.opener?.focus();
	};

	useInitialFocus();
	if (props.state.mode === "confirm-reset") {
		return (
			<sl-dialog
				label="Reset to the default arrangement"
				open
				on:sl-after-show={focusFirstField}
				on:sl-after-hide={closeAndReturnFocus}
			>
				<p class="text-sm text-slate-800">
					This replaces every widget with the default arrangement. This cannot be undone.
				</p>
				<div slot="footer" class="flex justify-end gap-1">
					<IconButton label="Cancel" icon="x-lg" onClick={(event) => closeAndReturnFocus(event)} />
					<IconButton
						label="Reset widgets"
						icon="arrow-counterclockwise"
						variant="danger"
						onClick={() => props.onConfirmReset()}
					/>
				</div>
			</sl-dialog>
		);
	}
	return (
		<WidgetForm
			mode={props.state.mode}
			initial={props.state.mode === "edit" ? props.state.widget : null}
			dashboard={props.dashboard}
			catalog={props.catalog}
			catalogState={props.catalogState}
			seriesById={props.seriesById}
			onSave={props.onSave}
			onClose={closeAndReturnFocus}
			onShown={focusFirstField}
			onHidden={closeAndReturnFocus}
		/>
	);
}

function WidgetForm(props: {
	readonly mode: "add" | "edit";
	readonly initial: HomeWidget | null;
	readonly dashboard: HomeDashboard;
	readonly catalog: readonly MarketCatalogEntry[] | null;
	readonly catalogState: "loading" | "ready" | "error";
	readonly seriesById: ReadonlyMap<string, MarketSeries>;
	readonly onSave: (widget: HomeWidget) => void;
	readonly onClose: () => void;
	readonly onShown: (event: Event) => void;
	readonly onHidden: (event: Event) => void;
}): JSX.Element {
	const [widgetType, setWidgetType] = createSignal<HomeWidgetType>(props.initial?.type ?? "metric");
	const [title, setTitle] = createSignal(props.initial?.title ?? "");
	const [size, setSize] = createSignal<HomeWidget["size"]>(props.initial?.size ?? "small");
	const [selected, setSelected] = createSignal<readonly string[]>(
		props.initial === null ? [] : [...widgetSeriesIds(props.initial)],
	);
	const [range, setRange] = createSignal<MarketRange>(
		props.initial !== null && props.initial.type === "line-chart" ? props.initial.range : "1y",
	);
	const [daysAhead, setDaysAhead] = createSignal<EarningsCalendarDaysAhead>(
		props.initial !== null && props.initial.type === "earnings-calendar"
			? props.initial.daysAhead
			: 90,
	);
	const [customProvider, setCustomProvider] = createSignal<MarketProviderId>("fred");
	const [customSymbol, setCustomSymbol] = createSignal("");
	const [customError, setCustomError] = createSignal<string | null>(null);
	const [customIds, setCustomIds] = createSignal<readonly string[]>([]);
	/** F3: true once the owner has changed any field (the problems list turns red). */
	const [dirty, setDirty] = createSignal(false);
	useInitialFocus();

	const info = () => WIDGET_REGISTRY[widgetType()];

	const optionGroups = createMemo((): readonly OptionGroup[] => {
		const groups = new Map<MarketCatalogEntry["category"], MarketCatalogEntry[]>();
		for (const entry of props.catalog ?? []) {
			const list = groups.get(entry.category) ?? [];
			list.push(entry);
			groups.set(entry.category, list);
		}
		const catalogGroups: OptionGroup[] = [...groups.entries()].map(([category, options]) => ({
			key: category,
			label: CATEGORY_LABELS[category],
			options,
		}));
		const fresh = customIds().flatMap((seriesId) => {
			if ((props.catalog ?? []).some((entry) => entry.seriesId === seriesId)) return [];
			const parsed = parseMarketSeriesId(seriesId);
			if (parsed === null) return [];
			const providerLabel = parsed.provider === "fred" ? "FRED" : "Twelve Data";
			return [
				{
					seriesId,
					label: `${parsed.symbol} (custom ${providerLabel})`,
					category: "equity" as const,
					description: "Custom series.",
				},
			];
		});
		return fresh.length === 0
			? catalogGroups
			: [{ key: "custom", label: "Custom", options: fresh }, ...catalogGroups];
	});

	const problems = createMemo((): readonly string[] => {
		const found: string[] = [];
		const trimmed = title().trim();
		if (trimmed === "") found.push("Enter a title.");
		if (trimmed.length > 80) found.push("Shorten the title to 80 characters or fewer.");
		const ids = selected();
		if (ids.length < info().minSeries) {
			found.push(
				info().minSeries === 1 ? "Choose a series." : `Choose at least ${info().minSeries} series.`,
			);
		}
		if (ids.length > info().maxSeries) {
			found.push(`This widget holds at most ${info().maxSeries} series.`);
		}
		if (new Set(ids).size !== ids.length) found.push("A widget must not repeat a series.");
		for (const id of ids) {
			if (parseMarketSeriesId(id) === null) found.push(`"${id}" is not a valid series id.`);
		}
		if (info().seriesKind === "multi-same-unit") {
			const known = ids.flatMap((id) => {
				const unit = props.seriesById.get(id)?.unit;
				return unit === undefined || unit === "" ? [] : [unit];
			});
			const distinct = [...new Set(known)];
			if (distinct.length > 1) {
				found.push(`Line-chart series must share one unit (found: ${distinct.join(", ")}).`);
			}
		}
		if (props.mode === "add") {
			if (props.dashboard.widgets.length >= 24) {
				found.push("The dashboard already holds 24 widgets; remove one first.");
			}
			const distinct = new Set<string>();
			for (const widget of props.dashboard.widgets) {
				for (const id of widgetSeriesIds(widget)) distinct.add(id);
			}
			for (const id of ids) distinct.add(id);
			if (distinct.size > 30) {
				found.push("The dashboard holds at most 30 distinct series; remove one first.");
			}
		}
		return found;
	});

	const unitNote = createMemo((): string | null => {
		if (info().seriesKind !== "multi-same-unit") return null;
		const unknown = selected().filter((id) => {
			const unit = props.seriesById.get(id)?.unit;
			return unit === undefined || unit === "";
		});
		if (unknown.length === 0) return null;
		return `Unit unknown until refreshed: ${unknown.join(", ")}. Units must match before saving with data.`;
	});

	const problemsId = `widget-problems-${props.mode}`;

	/** F3: the pristine lead names what to do; the dirty lead names what is wrong. */
	const problemsLead = () => {
		if (dirty()) return "Fix before saving:";
		return props.mode === "add" ? "To add this widget:" : "To save this widget:";
	};

	const addCustom = () => {
		const symbol = customSymbol().trim().toUpperCase();
		const candidate = `${customProvider()}:${symbol}`;
		if (parseMarketSeriesId(candidate) === null) {
			const providerLabel = customProvider() === "fred" ? "FRED" : "Twelve Data";
			setCustomError(`"${customSymbol().trim()}" is not a valid ${providerLabel} symbol id.`);
			return;
		}
		setDirty(true);
		setCustomError(null);
		if (!customIds().includes(candidate)) setCustomIds([...customIds(), candidate]);
		if (!selected().includes(candidate)) {
			setSelected(info().seriesKind === "single" ? [candidate] : [...selected(), candidate]);
		}
		setCustomSymbol("");
	};

	const save = () => {
		if (problems().length > 0) return;
		const base = {
			widgetId:
				props.initial?.widgetId ??
				`w-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`,
			title: title().trim(),
			size: size(),
		};
		const type = widgetType();
		if (type === "metric") {
			const [seriesId] = selected();
			if (seriesId === undefined) return;
			props.onSave({ ...base, type, seriesId });
		} else if (type === "line-chart") {
			props.onSave({ ...base, type, seriesIds: [...selected()], range: range() });
		} else if (type === "earnings-calendar") {
			props.onSave({ ...base, type, daysAhead: daysAhead() });
		} else {
			props.onSave({ ...base, type, seriesIds: [...selected()] });
		}
	};

	return (
		<sl-dialog
			label={props.mode === "add" ? "Add widget" : "Edit widget"}
			open
			on:sl-after-show={props.onShown}
			on:sl-after-hide={props.onHidden}
		>
			<div class="space-y-3">
				<Show when={problems().length > 0}>
					{/* F3: pristine (untouched) problems read as a neutral notice with a
					    "To add/save this widget:" lead; once any field has changed the
					    remaining problems turn red with a "Fix before saving:" lead, so
					    state is never colour alone. The save button keeps pointing at
					    the list via aria-describedby. */}
					<div
						class={
							dirty()
								? "rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900"
								: "rounded border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800"
						}
					>
						<p class="font-medium">{problemsLead()}</p>
						<ul
							aria-label="Before you can save this widget"
							id={problemsId}
							class="list-disc space-y-0.5 pl-5"
						>
							<For each={problems()}>{(problem) => <li>{problem}</li>}</For>
						</ul>
					</div>
				</Show>
				<Show when={props.mode === "add"}>
					<sl-select
						label="Widget type"
						value={widgetType()}
						size="small"
						hoist
						on:sl-change={(event) => {
							if (!isDirectShoelaceEvent(event)) return;
							const next = event.currentTarget.value;
							const value = Array.isArray(next) ? next[0] : next;
							const found = HOME_WIDGET_TYPES.find((entry) => entry === value);
							if (found === undefined) return;
							setDirty(true);
							setWidgetType(found);
							setSize(WIDGET_REGISTRY[found].defaultSize);
							setSelected([]);
						}}
					>
						<For each={HOME_WIDGET_TYPES}>
							{(type) => <sl-option value={type}>{WIDGET_REGISTRY[type].label}</sl-option>}
						</For>
					</sl-select>
					<p class="text-2xs text-slate-600">{info().description}</p>
				</Show>
				<sl-input
					label="Title"
					value={title()}
					size="small"
					maxlength={80}
					on:sl-input={(event) => {
						if (!isDirectShoelaceEvent(event)) return;
						setDirty(true);
						setTitle(event.currentTarget.value);
					}}
				/>
				<sl-select
					label="Size"
					value={size()}
					size="small"
					hoist
					attr:help-text={`Small is ${WIDGET_SIZE_SHAPES.small}, Medium is ${WIDGET_SIZE_SHAPES.medium}, Large is ${WIDGET_SIZE_SHAPES.large}.`}
					on:sl-change={(event) => {
						if (!isDirectShoelaceEvent(event)) return;
						const next = event.currentTarget.value;
						const value = Array.isArray(next) ? next[0] : next;
						if (value === "small" || value === "medium" || value === "large") {
							setDirty(true);
							setSize(value);
						}
					}}
				>
					<sl-option value="small">Small</sl-option>
					<sl-option value="medium">Medium</sl-option>
					<sl-option value="large">Large</sl-option>
				</sl-select>
				<Show when={info().hasDaysAhead}>
					<sl-select
						label="Days ahead"
						value={String(daysAhead())}
						size="small"
						hoist
						on:sl-change={(event) => {
							if (!isDirectShoelaceEvent(event)) return;
							const next = event.currentTarget.value;
							const raw = Array.isArray(next) ? next[0] : next;
							const found = DAYS_AHEAD_OPTIONS.find((entry) => entry === Number(raw));
							if (found !== undefined) {
								setDirty(true);
								setDaysAhead(found);
							}
						}}
					>
						<For each={DAYS_AHEAD_OPTIONS}>
							{(entry) => <sl-option value={String(entry)}>Next {entry} days</sl-option>}
						</For>
					</sl-select>
				</Show>
				<Show when={info().seriesKind !== "none"}>
					<div>
						<sl-select
							label="Series"
							value={info().seriesKind === "single" ? (selected()[0] ?? "") : [...selected()]}
							size="small"
							multiple={info().seriesKind !== "single"}
							hoist
							attr:aria-describedby={problems().length > 0 ? problemsId : undefined}
							on:sl-change={(event) => {
								if (!isDirectShoelaceEvent(event)) return;
								const next = event.currentTarget.value;
								setDirty(true);
								setSelected(
									info().seriesKind === "single"
										? Array.isArray(next)
											? next.slice(0, 1)
											: [next]
										: Array.isArray(next)
											? next
											: [next],
								);
							}}
						>
							<Show
								when={props.catalogState !== "error"}
								fallback={
									<sl-option value="" disabled={true}>
										Catalog unavailable
									</sl-option>
								}
							>
								<For each={optionGroups()}>
									{(group) => (
										<>
											<sl-option value={`__group-${group.key}`} disabled={true}>
												{group.label}
											</sl-option>
											<For each={group.options}>
												{(option) => (
													<sl-option value={option.seriesId}>
														{option.label} ({option.seriesId})
													</sl-option>
												)}
											</For>
										</>
									)}
								</For>
							</Show>
						</sl-select>
						<Show when={unitNote()}>
							{(note) => <p class="mt-0.5 text-2xs text-amber-900">{note()}</p>}
						</Show>
					</div>
				</Show>
				<Show when={info().seriesKind !== "none"}>
					<details class="group text-xs">
						<DisclosureSummary>Use a custom series id</DisclosureSummary>
						<div class="mt-1 flex flex-wrap items-end gap-2">
							<sl-select
								label="Provider"
								value={customProvider()}
								size="small"
								hoist
								on:sl-change={(event) => {
									if (!isDirectShoelaceEvent(event)) return;
									const next = event.currentTarget.value;
									const value = Array.isArray(next) ? next[0] : next;
									if (value === "fred" || value === "twelve-data") {
										setDirty(true);
										setCustomProvider(value);
									}
								}}
							>
								<For each={PROVIDERS}>
									{(provider) => (
										<sl-option value={provider}>
											{provider === "fred" ? "FRED" : "Twelve Data"}
										</sl-option>
									)}
								</For>
							</sl-select>
							<sl-input
								label="Symbol"
								placeholder={PROVIDER_SYMBOLS[customProvider()]}
								size="small"
								value={customSymbol()}
								on:sl-input={(event) => {
									if (!isDirectShoelaceEvent(event)) return;
									setDirty(true);
									setCustomSymbol(event.currentTarget.value);
								}}
							/>
							<IconButton label="Add series" icon="plus-lg" onClick={addCustom} />
						</div>
						<Show when={customError()}>
							{(error) => (
								<p role="alert" class="mt-1 text-xs text-red-900">
									{error()}
								</p>
							)}
						</Show>
					</details>
				</Show>
				<Show when={info().hasRange}>
					<sl-select
						label="Range"
						value={range()}
						size="small"
						hoist
						on:sl-change={(event) => {
							if (!isDirectShoelaceEvent(event)) return;
							const next = event.currentTarget.value;
							const value = Array.isArray(next) ? next[0] : next;
							const found = HOME_RANGES.find((entry) => entry === value);
							if (found !== undefined) {
								setDirty(true);
								setRange(found);
							}
						}}
					>
						<For each={HOME_RANGES}>
							{(entry) => <sl-option value={entry}>{HOME_RANGE_LABELS[entry]}</sl-option>}
						</For>
					</sl-select>
				</Show>
			</div>
			<div slot="footer" class="flex justify-end gap-1">
				<IconButton label="Cancel" icon="x-lg" onClick={() => props.onClose()} />
				<IconButton
					label={props.mode === "add" ? "Add widget" : "Save widget"}
					icon="check-lg"
					variant="primary"
					disabled={problems().length > 0}
					describedBy={problems().length > 0 ? problemsId : undefined}
					onClick={save}
				/>
			</div>
		</sl-dialog>
	);
}
