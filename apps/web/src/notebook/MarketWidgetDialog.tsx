import {
	type HomeWidget,
	homeWidgetAsNotebookWidget,
	isNotebookMarketWidget,
	type MarketCatalogEntry,
	type MarketSeries,
	NOTEBOOK_LIMITS,
	NOTEBOOK_MARKET_HOME_TYPE,
	type NotebookMarketWidgetCore,
	type NotebookMarketWidgetType,
	type NotebookWidget,
	notebookMarketSeriesIds,
	notebookWidgetAsHomeWidget,
} from "@research/contracts";
import { type JSX, Show } from "solid-js";
import { isDirectShoelaceEvent, WidgetForm, type WidgetFormLimits } from "../home/WidgetDialog.tsx";
import { newNotebookWidgetId } from "./notebookModel.ts";

export type NotebookMarketDialogState =
	| { readonly mode: "add"; readonly notebookType: NotebookMarketWidgetType }
	| { readonly mode: "edit"; readonly widget: NotebookWidget };

/**
 * Add / edit dialog for the notebook's market widgets (ADR-0021): Home's
 * own widget form (`WidgetForm` in `home/WidgetDialog.tsx`) with the
 * notebook's series limits and a preset type, converting back through
 * `homeWidgetAsNotebookWidget` on save. Home keeps using the same form
 * with its dashboard, unchanged.
 */
export function NotebookMarketDialog(props: {
	readonly state: NotebookMarketDialogState | null;
	/** Element that opened the dialog; focus returns to it on close. */
	readonly opener: HTMLElement | null;
	readonly widgets: readonly NotebookWidget[];
	readonly catalog: readonly MarketCatalogEntry[] | null;
	readonly catalogState: "loading" | "ready" | "error";
	readonly seriesById: ReadonlyMap<string, MarketSeries>;
	readonly onSave: (core: NotebookMarketWidgetCore) => void;
	readonly onClose: () => void;
}): JSX.Element {
	const closeAndReturnFocus = (event?: Event) => {
		// H1: a bubbled sl-after-hide from a nested sl-select listbox must not
		// close the dialog (nor steal focus handling).
		if (event !== undefined && !isDirectShoelaceEvent(event)) return;
		props.onClose();
		props.opener?.focus();
	};

	const focusFirstField = (event: Event): void => {
		if (event.target !== event.currentTarget) return;
		const root = event.currentTarget;
		if (root instanceof HTMLElement) {
			const field = root.querySelector("sl-input, sl-select");
			if (field instanceof HTMLElement) field.focus({ preventScroll: true });
		}
	};

	return (
		<Show when={props.state} fallback={null}>
			{(state) => {
				const current = state();
				const limits: WidgetFormLimits = {
					maxWidgets: NOTEBOOK_LIMITS.maxWidgets,
					maxSeries: NOTEBOOK_LIMITS.maxMarketSeries,
					existingCount: props.widgets.length,
					existingSeries: [...notebookMarketSeriesIds(props.widgets)],
					scope: "notebook",
				};
				// "Edit…" opens only on market widgets (the panel routes the
				// other types to the notebook editor), narrowed without a cast.
				const editing =
					current.mode === "edit" && isNotebookMarketWidget(current.widget) ? current.widget : null;
				const initial: HomeWidget | null =
					editing === null ? null : notebookWidgetAsHomeWidget(editing);
				return (
					<WidgetForm
						mode={current.mode}
						initial={initial}
						initialType={
							current.mode === "add" ? NOTEBOOK_MARKET_HOME_TYPE[current.notebookType] : undefined
						}
						limits={limits}
						catalog={props.catalog}
						catalogState={props.catalogState}
						seriesById={props.seriesById}
						onSave={(widget) =>
							props.onSave(
								homeWidgetAsNotebookWidget({
									...widget,
									widgetId: initial?.widgetId ?? newNotebookWidgetId(),
								}),
							)
						}
						onClose={() => closeAndReturnFocus()}
						onShown={focusFirstField}
						onHidden={closeAndReturnFocus}
					/>
				);
			}}
		</Show>
	);
}
