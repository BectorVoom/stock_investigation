import {
	distinctWidgetSeriesIds,
	type EarningsCalendarDaysAhead,
	type MarketCatalogEntry,
	type MarketProviderId,
	type MarketRange,
	type MarketSeries,
	type MarketWidgetCore,
	type MarketWidgetType,
	parseMarketSeriesId,
	WIDGET_LIMITS,
	WIDGET_TYPE_META,
	type WidgetCore,
	type WidgetSize,
	widgetSeriesIds,
} from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createMemo, createSignal, For, type JSX, onMount, Show } from "solid-js";
import { DisclosureSummary, IconButton } from "../components/ui.tsx";
import { HOME_RANGES } from "../home/homeModel.ts";
import "../home/shoelace.ts";
import { WIDGET_REGISTRY } from "../home/widgetRegistry.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { marketRangeMessages } from "./marketRange.messages.ts";
import { marketWidgetDialogMessages } from "./marketWidgetDialog.messages.ts";
import { newWidgetId } from "./widgetModel.ts";
import { widgetTypeMessages } from "./widgetTypes.messages.ts";

/**
 * Add / edit dialog of the live market widgets, the same on Home and in the
 * Notebook (ADR-0024): series (catalog or custom id), range, days ahead,
 * title and size. The type is chosen in the page's add menu before the
 * dialog opens. Problems are listed the way other forms do it
 * (`ul[aria-label="Before you can …"]`, save described by it). Focus moves
 * into the dialog on open and returns to the explicit opener on close
 * (Safari never focuses the clicked button itself, guideline 9a — hence the
 * explicit opener, never `document.activeElement`).
 */
export type MarketWidgetDialogState =
	| { readonly mode: "add"; readonly type: MarketWidgetType }
	| { readonly mode: "edit"; readonly widget: MarketWidgetCore };

/** The page's own bounds: Home's dashboard or one notebook. */
export interface MarketWidgetLimits {
	readonly scope: "dashboard" | "notebook";
	readonly maxWidgets: number;
	readonly maxSeries: number;
}

const PROVIDERS: readonly MarketProviderId[] = ["fred", "twelve-data"];

/** Days-ahead choices for the earnings calendar (contract `daysAhead` union). */
const DAYS_AHEAD_OPTIONS: readonly EarningsCalendarDaysAhead[] = [30, 60, 90, 180];

interface OptionGroup {
	readonly key: string;
	readonly label: string;
	readonly options: readonly MarketCatalogEntry[];
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

export function MarketWidgetDialog(props: {
	readonly state: MarketWidgetDialogState | null;
	/** Element that opened the dialog; focus returns to it on close. */
	readonly opener: HTMLElement | null;
	/** The page's widgets now: the add limits and the series bound read them. */
	readonly widgets: readonly WidgetCore[];
	readonly limits: MarketWidgetLimits;
	readonly catalog: readonly MarketCatalogEntry[] | null;
	readonly catalogState: "loading" | "ready" | "error";
	readonly seriesById: ReadonlyMap<string, MarketSeries>;
	readonly onSave: (widget: MarketWidgetCore) => void;
	readonly onClose: () => void;
}): JSX.Element {
	const closeAndReturnFocus = (event?: Event) => {
		// H1: a bubbled sl-after-hide from a nested sl-select listbox must not
		// close the dialog (nor steal focus handling).
		if (event !== undefined && !isDirectShoelaceEvent(event)) return;
		props.onClose();
		props.opener?.focus();
	};
	return (
		<Show when={props.state} keyed fallback={null}>
			{(state) => (
				<MarketWidgetForm
					mode={state.mode}
					type={state.mode === "add" ? state.type : state.widget.type}
					initial={state.mode === "edit" ? state.widget : null}
					widgets={props.widgets}
					limits={props.limits}
					catalog={props.catalog}
					catalogState={props.catalogState}
					seriesById={props.seriesById}
					onSave={props.onSave}
					onClose={() => closeAndReturnFocus()}
					onShown={focusFirstField}
					onHidden={closeAndReturnFocus}
				/>
			)}
		</Show>
	);
}

interface MarketWidgetFormProps {
	readonly mode: "add" | "edit";
	readonly type: MarketWidgetType;
	readonly initial: MarketWidgetCore | null;
	readonly widgets: readonly WidgetCore[];
	readonly limits: MarketWidgetLimits;
	readonly catalog: readonly MarketCatalogEntry[] | null;
	readonly catalogState: "loading" | "ready" | "error";
	readonly seriesById: ReadonlyMap<string, MarketSeries>;
	readonly onSave: (widget: MarketWidgetCore) => void;
	readonly onClose: () => void;
	readonly onShown: (event: Event) => void;
	readonly onHidden: (event: Event) => void;
}

function MarketWidgetForm(props: MarketWidgetFormProps): JSX.Element {
	const m = useMessages(marketWidgetDialogMessages);
	const rangeNames = useMessages(marketRangeMessages);
	const common = useMessages(commonMessages);
	const typeWords = useMessages(widgetTypeMessages);
	/** The type is chosen before the form opens (the add menu) and never changes in it. */
	const widgetType = (): MarketWidgetType => props.initial?.type ?? props.type;
	const [title, setTitle] = createSignal(props.initial?.title ?? "");
	const [size, setSize] = createSignal<WidgetSize>(
		props.initial?.size ?? WIDGET_TYPE_META[props.type].defaultSize,
	);
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
			label: m().category(category),
			options,
		}));
		const fresh = customIds().flatMap((seriesId) => {
			if ((props.catalog ?? []).some((entry) => entry.seriesId === seriesId)) return [];
			const parsed = parseMarketSeriesId(seriesId);
			if (parsed === null) return [];
			return [
				{
					seriesId,
					label: m().customOption(parsed.symbol, parsed.provider),
					category: "equity" as const,
					description: m().customDescription,
				},
			];
		});
		return fresh.length === 0
			? catalogGroups
			: [{ key: "custom", label: m().customGroup, options: fresh }, ...catalogGroups];
	});

	const problems = createMemo((): readonly string[] => {
		const found: string[] = [];
		const trimmed = title().trim();
		const words = m();
		if (trimmed === "") found.push(words.enterTitle);
		if (trimmed.length > WIDGET_LIMITS.maxTitleChars) {
			found.push(words.shortenTitle(WIDGET_LIMITS.maxTitleChars));
		}
		const ids = selected();
		if (ids.length < info().minSeries) {
			found.push(words.chooseSeries(info().minSeries));
		}
		if (ids.length > info().maxSeries) {
			found.push(words.tooManySeries(info().maxSeries));
		}
		if (new Set(ids).size !== ids.length) found.push(words.repeatedSeries);
		for (const id of ids) {
			if (parseMarketSeriesId(id) === null) found.push(words.invalidSeriesId(id));
		}
		if (info().seriesKind === "multi-same-unit") {
			const known = ids.flatMap((id) => {
				const unit = props.seriesById.get(id)?.unit;
				return unit === undefined || unit === "" ? [] : [unit];
			});
			const distinct = [...new Set(known)];
			if (distinct.length > 1) {
				found.push(words.unitsDiffer(distinct.join(", ")));
			}
		}
		const { scope, maxWidgets, maxSeries } = props.limits;
		if (props.mode === "add" && props.widgets.length >= maxWidgets) {
			found.push(words.pageFull(scope, maxWidgets));
		}
		// The page's series without this widget's own, plus the chosen ones.
		const others = props.widgets.filter((widget) => widget.widgetId !== props.initial?.widgetId);
		const distinct = new Set<string>(distinctWidgetSeriesIds(others));
		for (const id of ids) distinct.add(id);
		if (distinct.size > maxSeries) {
			found.push(words.pageSeriesFull(scope, maxSeries));
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
		return m().unitUnknown(unknown.join(", "));
	});

	const problemsId = `widget-problems-${props.mode}`;

	/** F3: the pristine lead names what to do; the dirty lead names what is wrong. */
	const problemsLead = () => {
		if (dirty()) return m().fixBeforeSaving;
		return props.mode === "add" ? m().toAdd : m().toSave;
	};

	const addCustom = () => {
		const symbol = customSymbol().trim().toUpperCase();
		const candidate = `${customProvider()}:${symbol}`;
		if (parseMarketSeriesId(candidate) === null) {
			setCustomError(m().invalidSymbol(customSymbol().trim(), customProvider()));
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
			widgetId: props.initial?.widgetId ?? newWidgetId(),
			title: title().trim(),
			size: size(),
		};
		const type = widgetType();
		if (type === "market-metric") {
			const [seriesId] = selected();
			if (seriesId === undefined) return;
			props.onSave({ ...base, type, seriesId });
		} else if (type === "line-chart") {
			props.onSave({ ...base, type, seriesIds: [...selected()], range: range() });
		} else if (type === "earnings-calendar") {
			props.onSave({ ...base, type, daysAhead: daysAhead() });
		} else if (type === "watchlist-prices") {
			// Chosen when added, never edited here (ADR-0040 §5).
			return;
		} else {
			props.onSave({ ...base, type, seriesIds: [...selected()] });
		}
	};

	return (
		<sl-dialog
			label={
				props.mode === "add"
					? typeWords().addWidget(widgetType())
					: typeWords().editWidget(widgetType())
			}
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
						<ul aria-label={m().problemsList} id={problemsId} class="list-disc space-y-0.5 pl-5">
							<For each={problems()}>{(problem) => <li>{problem}</li>}</For>
						</ul>
					</div>
				</Show>
				<p class="text-2xs text-slate-600">{typeWords().typeDescription(widgetType())}</p>
				<sl-input
					attr:label={m().title}
					value={title()}
					size="small"
					maxlength={WIDGET_LIMITS.maxTitleChars}
					on:sl-input={(event) => {
						if (!isDirectShoelaceEvent(event)) return;
						setDirty(true);
						setTitle(event.currentTarget.value);
					}}
				/>
				<sl-select
					attr:label={m().size}
					value={size()}
					size="small"
					hoist
					attr:help-text={m().sizeHelp}
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
					<sl-option value="small">{m().small}</sl-option>
					<sl-option value="medium">{m().medium}</sl-option>
					<sl-option value="large">{m().large}</sl-option>
				</sl-select>
				<Show when={info().hasDaysAhead}>
					<sl-select
						attr:label={m().daysAhead}
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
							{(entry) => <sl-option value={String(entry)}>{m().nextDays(entry)}</sl-option>}
						</For>
					</sl-select>
				</Show>
				<Show when={info().seriesKind !== "none"}>
					<div>
						<sl-select
							attr:label={m().series}
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
										{m().catalogUnavailable}
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
						<DisclosureSummary>{m().customSeriesId}</DisclosureSummary>
						<div class="mt-1 flex flex-wrap items-end gap-2">
							<sl-select
								attr:label={m().provider}
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
										<sl-option value={provider}>{m().providerName(provider)}</sl-option>
									)}
								</For>
							</sl-select>
							<sl-input
								attr:label={m().symbol}
								placeholder={m().symbolExample(customProvider())}
								size="small"
								value={customSymbol()}
								on:sl-input={(event) => {
									if (!isDirectShoelaceEvent(event)) return;
									setDirty(true);
									setCustomSymbol(event.currentTarget.value);
								}}
							/>
							<IconButton label={m().addSeries} icon="plus-lg" onClick={addCustom} />
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
						attr:label={m().range}
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
							{(entry) => <sl-option value={entry}>{rangeNames()[entry]}</sl-option>}
						</For>
					</sl-select>
				</Show>
			</div>
			<div slot="footer" class="flex justify-end gap-1">
				<IconButton label={common().cancel} icon="x-lg" onClick={() => props.onClose()} />
				<IconButton
					label={props.mode === "add" ? m().addWidget : m().saveWidget}
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
