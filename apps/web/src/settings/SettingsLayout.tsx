import { type JSX, Show } from "solid-js";

/**
 * The parts of the Settings surface (guideline section 15, ADR-0052): one
 * category at a time in a pane, its settings as rows separated by hairlines —
 * the name and its explanation on the left, the control on the right — in the
 * manner of ChatGPT's settings. Below the `sm` breakpoint a row stacks the
 * control under its name.
 */

/**
 * One category's pane: a labelled region with the category title (`h3`), an
 * optional intro under it, then its rows. The region keeps the name the old
 * page section had, so links and assistive technology find it the same way.
 */
export function SettingsPane(props: {
	readonly title: string;
	readonly intro?: JSX.Element;
	readonly children: JSX.Element;
}): JSX.Element {
	return (
		<section aria-label={props.title}>
			<div class="border-b border-slate-200 pb-3">
				<h3 class="text-base font-semibold text-slate-900">{props.title}</h3>
				<Show when={props.intro}>
					{(intro) => <p class="mt-0.5 text-xs text-slate-600">{intro()}</p>}
				</Show>
			</div>
			<div class="divide-y divide-slate-200">{props.children}</div>
		</section>
	);
}

/** How a row's control column is laid out. */
export type SettingControlLayout =
	/** A field (select, text input): a fixed column, full width when stacked. */
	| "field"
	/** Buttons: as wide as they are, at the row's end (under the name when stacked). */
	| "actions"
	/** A switch: at the row's end at every width, never stacked under its name. */
	| "switch";

/**
 * One setting: its name (a `<label>` for the control when `labelFor` is set,
 * an `h4` when the row groups several controls, plain text otherwise), an
 * optional explanation, the control, and anything that needs the full width
 * of the pane (`below`: notices, a one-time token, a list).
 */
export function SettingRow(props: {
	readonly label: string;
	readonly labelFor?: string;
	readonly heading?: boolean;
	readonly description?: JSX.Element;
	readonly control?: JSX.Element;
	readonly controlLayout?: SettingControlLayout;
	readonly below?: JSX.Element;
	readonly field?: string;
}): JSX.Element {
	const name = (): JSX.Element => {
		const labelFor = props.labelFor;
		if (labelFor !== undefined) {
			return (
				<label for={labelFor} class="block text-sm font-medium text-slate-900">
					{props.label}
				</label>
			);
		}
		if (props.heading === true) {
			return <h4 class="text-sm font-medium text-slate-900">{props.label}</h4>;
		}
		return <p class="text-sm font-medium text-slate-900">{props.label}</p>;
	};
	const layout = (): SettingControlLayout => props.controlLayout ?? "field";
	const controlClass = (): string => {
		switch (layout()) {
			case "field":
				return "w-full sm:w-64 sm:shrink-0";
			case "actions":
				return "flex flex-wrap items-center gap-1 sm:max-w-xs sm:shrink-0 sm:justify-end";
			case "switch":
				return "shrink-0";
		}
	};
	return (
		<div class="py-3" data-setting-row={props.field ?? ""}>
			<div
				class={
					layout() === "switch"
						? "flex items-start justify-between gap-4 sm:gap-6"
						: "flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
				}
			>
				<div class="min-w-0 flex-1">
					{name()}
					<Show when={props.description}>
						{(description) => <div class="mt-0.5 text-xs text-slate-600">{description()}</div>}
					</Show>
				</div>
				<Show when={props.control}>
					{(control) => <div class={controlClass()}>{control()}</div>}
				</Show>
			</div>
			<Show when={props.below}>
				{(below) => <div class="mt-2 space-y-2 empty:hidden">{below()}</div>}
			</Show>
		</div>
	);
}

/**
 * An on/off setting drawn as a switch: a native checkbox with the `switch`
 * role (so it is named by its row's `<label>` and toggled by Space), laid
 * invisibly over its track so a click anywhere on the switch toggles it.
 * The track is blue when on and grey when off (slate-500, 4.8:1 against
 * white: a control's edge needs 3:1), and the knob moves; the state is also
 * the control's checked state, never colour alone. The focus ring is drawn
 * on the track because the input itself is transparent.
 */
export function SettingsSwitch(props: {
	readonly id: string;
	readonly checked: boolean;
	readonly describedBy?: string;
	readonly disabled?: boolean;
	readonly onChange: (checked: boolean) => void;
}): JSX.Element {
	return (
		<span class="relative inline-flex h-6 w-11 shrink-0">
			<input
				id={props.id}
				type="checkbox"
				// biome-ignore lint/a11y/useAriaPropsForRole: a native checkbox exposes its checked state to the switch role; ARIA in HTML forbids aria-checked on it.
				role="switch"
				class="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
				checked={props.checked}
				disabled={props.disabled}
				aria-describedby={props.describedBy}
				onChange={(event) => props.onChange(event.currentTarget.checked)}
			/>
			<span
				aria-hidden="true"
				class="pointer-events-none absolute inset-0 rounded-full bg-slate-500 peer-checked:bg-blue-700 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-700 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50 motion-safe:transition-colors"
			/>
			<span
				aria-hidden="true"
				class="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white peer-checked:translate-x-5 motion-safe:transition-transform"
			/>
		</span>
	);
}
