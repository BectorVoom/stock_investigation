import type { HomeWidget, MarketSeries } from "@research/contracts";
import { SafeLink } from "@research/ui-registry";
import {
	type Accessor,
	createEffect,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { IconButton, type IconButtonName, IconGlyph } from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import { HOME_SIZE_SPAN, widgetSeriesIds } from "./homeModel.ts";

export interface WidgetFrameProps {
	readonly widget: HomeWidget;
	readonly position: number;
	readonly total: number;
	/** V8: while a save is in flight every menu action is impossible, not silently skipped. */
	readonly actionsDisabled: boolean;
	readonly onEdit: (widget: HomeWidget) => void;
	readonly onMove: (widget: HomeWidget, direction: "earlier" | "later") => void;
	readonly onRemove: (widget: HomeWidget) => void;
	readonly children: JSX.Element;
}

interface FrameMenuItem {
	readonly value: "edit" | "earlier" | "later" | "remove";
	readonly label: string;
	readonly icon: IconButtonName;
	readonly disabled: boolean;
}

/**
 * One widget on the grid: a native `article` frame (white on the grey page,
 * 1 px `slate-200` hairline, no shadow, `rounded-2xl`) that fills its grid
 * cell exactly. The header is a single clean strip (title + one icon-only
 * actions button, leaving room for a later drag handle); the body below it
 * scrolls INSIDE the frame when taller (`overflow-y-auto`, `min-h-0`) and is
 * keyboard-focusable (labelled by the widget title). Provenance is rendered
 * by each widget at the end of its own output (never as a frame prop: prop
 * elements snapshot once, while children stay live).
 */
export function WidgetFrame(props: WidgetFrameProps): JSX.Element {
	const titleId = createUniqueId();
	const span = () => HOME_SIZE_SPAN[props.widget.size];
	const [open, setOpen] = createSignal(false);
	let button: HTMLButtonElement | undefined;
	let menu: HTMLDivElement | undefined;
	const itemElements: (HTMLButtonElement | undefined)[] = [];

	const items = (): readonly FrameMenuItem[] => [
		{ value: "edit", label: "Edit widget", icon: "pencil", disabled: props.actionsDisabled },
		{
			value: "earlier",
			label: "Move earlier",
			icon: "arrow-left",
			disabled: props.actionsDisabled || props.position === 0,
		},
		{
			value: "later",
			label: "Move later",
			icon: "arrow-right",
			disabled: props.actionsDisabled || props.position === props.total - 1,
		},
		{ value: "remove", label: "Remove widget", icon: "trash", disabled: props.actionsDisabled },
	];

	const close = (returnFocus: boolean) => {
		setOpen(false);
		if (returnFocus) button?.focus();
	};

	const openAndFocus = (index: number) => {
		if (props.actionsDisabled) return;
		setOpen(true);
		queueMicrotask(() => {
			itemElements[index]?.focus();
		});
	};

	const select = (item: FrameMenuItem) => {
		setOpen(false);
		button?.focus();
		if (item.value === "edit") props.onEdit(props.widget);
		else if (item.value === "earlier" || item.value === "later") {
			props.onMove(props.widget, item.value);
		} else if (item.value === "remove") props.onRemove(props.widget);
	};

	const focusItem = (index: number) => {
		const list = items();
		if (list.length === 0) return;
		const wrapped = (index + list.length) % list.length;
		const start = wrapped;
		for (let step = 0; step < list.length; step += 1) {
			const candidate = (start + step) % list.length;
			const entry = list[candidate];
			const element = itemElements[candidate];
			if (entry !== undefined && !entry.disabled && element !== undefined) {
				element.focus();
				return;
			}
		}
	};

	const currentIndex = (): number => {
		const active = document.activeElement;
		return itemElements.indexOf(active as HTMLButtonElement | undefined);
	};

	const onButtonKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
			event.preventDefault();
			if (!open()) openAndFocus(0);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			if (!open()) openAndFocus(items().length - 1);
		}
	};

	const onMenuKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			close(true);
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			focusItem(currentIndex() + 1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			focusItem(currentIndex() - 1);
		} else if (event.key === "Home") {
			event.preventDefault();
			focusItem(0);
		} else if (event.key === "End") {
			event.preventDefault();
			focusItem(items().length - 1);
		} else if (event.key === "Tab") {
			setOpen(false);
		}
	};

	createEffect(() => {
		if (!open()) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (button?.contains(target) === true || menu?.contains(target) === true) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		onCleanup(() => document.removeEventListener("pointerdown", onPointerDown));
	});

	const actionsLabel = () => `${props.widget.title} actions`;
	return (
		<article
			aria-labelledby={titleId}
			data-widget-id={props.widget.widgetId}
			data-widget-type={props.widget.type}
			class={`flex h-full min-h-0 min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-4 ${span()}`}
		>
			<div class="flex min-h-7 items-center justify-between gap-2">
				<h3 id={titleId} class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
					{props.widget.title}
				</h3>
				<div class="relative inline-flex shrink-0">
					<IconButton
						label={actionsLabel()}
						icon="three-dots"
						disabled={props.actionsDisabled}
						expanded={open()}
						hasPopup="menu"
						widgetActions={props.widget.widgetId}
						ref={(element) => {
							button = element;
						}}
						onKeyDown={(event) => onButtonKeyDown(event)}
						onClick={() => {
							if (open()) close(false);
							else openAndFocus(0);
						}}
					/>
					<Show when={open()}>
						<div
							ref={(element) => {
								menu = element;
							}}
							role="menu"
							aria-label={actionsLabel()}
							class="absolute right-0 z-20 min-w-44 rounded border border-slate-200 bg-white p-1"
							onKeyDown={onMenuKeyDown}
						>
							<For each={items()}>
								{(item, index) => (
									<button
										ref={(element) => {
											itemElements[index()] = element;
										}}
										type="button"
										role="menuitem"
										data-menu-value={item.value}
										disabled={item.disabled}
										class="flex min-h-7 w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-slate-900 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
										onClick={() => select(item)}
									>
										<span aria-hidden="true" class="inline-flex shrink-0">
											<IconGlyph name={item.icon} />
										</span>
										<span>{item.label}</span>
									</button>
								)}
							</For>
						</div>
					</Show>
				</div>
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: the scrollable widget body is a named group (labelled by the widget title), not a form — fieldset does not apply. */}
			<div
				tabindex="0"
				role="group"
				aria-labelledby={titleId}
				class="mt-2 min-h-0 flex-1 overflow-y-auto"
			>
				{props.children}
			</div>
		</article>
	);
}

/** "As of <date>" for one observation date. */
export function AsOf(props: { readonly date: string }): JSX.Element {
	return (
		<span>
			as of <time dateTime={props.date}>{props.date}</time>
		</span>
	);
}

/**
 * The footer line for a single-series widget: source link (publisher name as
 * text), as-of date and retrieved time. Every displayed number carries its
 * unit (in the body), as-of date and source (here), or an explicit
 * "unavailable (reason)".
 */
export function SingleSeriesFooter(props: {
	readonly series: MarketSeries;
	readonly asOf: string | null;
}): JSX.Element {
	return (
		<span class="flex flex-wrap gap-x-2">
			<SafeLink url={props.series.sourceUrl}>{props.series.publisher}</SafeLink>
			<Show when={props.asOf} fallback={<span class="italic">as-of date not stated</span>}>
				{(date) => <AsOf date={date()} />}
			</Show>
			<span>
				retrieved{" "}
				{props.series.retrievedAt === null ? (
					<span class="italic">not stated</span>
				) : (
					formatInstant(props.series.retrievedAt)
				)}
			</span>
		</span>
	);
}

/** Tables carry per-row provenance; their footer says so. */
export function TableFooter(): JSX.Element {
	return <span>Sources and as-of dates are in each row.</span>;
}

/**
 * D4: Twelve Data serves daily bars, and the newest bar can be a session
 * still in progress. Shown beside any stock table or metric widget that
 * includes a Twelve Data series; the "Last close" column keeps its name.
 */
export function TwelveDataSessionNote(props: {
	readonly seriesIds: readonly string[];
	readonly byId: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const show = () => props.seriesIds.some((id) => props.byId().get(id)?.provider === "twelve-data");
	return (
		<Show when={show()}>
			<p class="mt-1 text-2xs text-slate-600">
				Twelve Data daily bars: the newest daily bar can be an unfinished session.
			</p>
		</Show>
	);
}

/**
 * Provenance for one widget, rendered at the end of the widget's own output
 * (its tracked subtree) — never passed through a frame prop. Single-series
 * widgets get the source link, as-of date and retrieved time; line charts get
 * one line per series; tables point at their per-row provenance. The series
 * arrive through an accessor so the lines stay live across refreshes: no
 * early returns on props, no top-level prop reads — only `<Show>`/`<For>`
 * over memoized lookups.
 */
export function WidgetProvenance(props: {
	readonly widget: HomeWidget;
	readonly byId: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	return (
		<div
			data-field="widget-footer"
			class="mt-2 border-t border-slate-200 pt-1 text-2xs text-slate-600"
		>
			<WidgetProvenanceLines widget={props.widget} byId={props.byId} />
		</div>
	);
}

function WidgetProvenanceLines(props: {
	readonly widget: HomeWidget;
	readonly byId: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const metricSeries = () =>
		props.widget.type === "metric" ? (props.byId().get(props.widget.seriesId) ?? null) : null;
	const chartIds = () =>
		props.widget.type === "line-chart" ? [...widgetSeriesIds(props.widget)] : [];
	return (
		<Switch fallback={<TableFooter />}>
			<Match when={props.widget.type === "metric"}>
				<Show when={metricSeries()} fallback={<span class="italic">source not stated</span>}>
					{(series) => (
						<SingleSeriesFooter
							series={series()}
							asOf={series().observations.at(-1)?.[0] ?? null}
						/>
					)}
				</Show>
			</Match>
			<Match when={props.widget.type === "line-chart"}>
				<ul class="space-y-0.5">
					<For each={chartIds()}>{(id) => <ChartSeriesLine seriesId={id} byId={props.byId} />}</For>
				</ul>
			</Match>
		</Switch>
	);
}

function ChartSeriesLine(props: {
	readonly seriesId: string;
	readonly byId: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const series = () => props.byId().get(props.seriesId) ?? null;
	return (
		<Show when={series()} fallback={null}>
			{(entry) => (
				<li>
					{entry().title}:{" "}
					<SingleSeriesFooter series={entry()} asOf={entry().observations.at(-1)?.[0] ?? null} />
				</li>
			)}
		</Show>
	);
}
