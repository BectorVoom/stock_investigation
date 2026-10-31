import { For, type JSX } from "solid-js";

/**
 * A segmented control (Apple HIG): a few mutually exclusive choices side by
 * side, the chosen one filled. Native buttons in a named group, each with
 * `aria-pressed`, like the Chat page's focus control — so each choice is
 * reached with Tab and chosen with Enter or Space, and a screen reader hears
 * which one is on. The pressed state uses the interactive blue with white
 * text (6.8:1), the others the default grey button fill.
 *
 * `disabled` is for a choice that can never be made here (nothing can save
 * it). `pending` is for a moment's wait (a save on its way): the buttons stay
 * focusable and announced as unavailable (`aria-disabled`), and a press is
 * ignored — a native `disabled` would drop the keyboard focus to the page.
 */
export function SegmentedControl<T extends string | number>(props: {
	/** The group's name (a visually hidden legend). */
	readonly label: string;
	readonly options: readonly T[];
	readonly selected: T;
	readonly optionLabel: (option: T) => string;
	readonly disabled?: boolean;
	/** A save is on its way: presses are ignored, focus stays. */
	readonly pending?: boolean;
	readonly onSelect: (option: T) => void;
	/** A stable hook for tests and reviews (`data-segmented`). */
	readonly name: string;
}): JSX.Element {
	return (
		<fieldset
			class="m-0 inline-flex min-w-0 flex-wrap gap-0.5 rounded bg-slate-200 p-0.5"
			data-segmented={props.name}
		>
			<legend class="sr-only">{props.label}</legend>
			<For each={props.options}>
				{(option) => {
					const pressed = () => option === props.selected;
					return (
						<button
							type="button"
							class="min-h-6 rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 pointer-coarse:min-h-11"
							classList={{
								"bg-blue-700 text-white": pressed(),
								"text-slate-900 hover:bg-slate-300": !pressed(),
							}}
							aria-pressed={pressed()}
							disabled={props.disabled}
							aria-disabled={props.pending === true ? "true" : undefined}
							data-option={String(option)}
							onClick={() => {
								if (props.pending !== true && !pressed()) props.onSelect(option);
							}}
						>
							{props.optionLabel(option)}
						</button>
					);
				}}
			</For>
		</fieldset>
	);
}
