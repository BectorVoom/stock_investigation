import { For, type JSX } from "solid-js";
import { WIDGET_SIZE_SHAPES, WIDGET_SIZES } from "../core/sizes.ts";
import type { WidgetSize } from "../core/types.ts";

export interface WidgetSizePickerProps {
	readonly value: WidgetSize;
	/** Sizes the widget's type allows (default: all three). */
	readonly sizes?: readonly WidgetSize[];
	readonly onChange: (size: WidgetSize) => void;
	/** Accessible name of the group, e.g. `Size of “Revenue”`. */
	readonly label: string;
	readonly disabled?: boolean;
}

const SHORT: { readonly [S in WidgetSize]: string } = { small: "S", medium: "M", large: "L" };

/**
 * The standard S / M / L size control: one compact segmented group, the same
 * for every widget type, so resizing looks and works alike everywhere. A
 * radiogroup with roving tabindex (only the checked option is in the tab
 * order), Arrow keys, Home and End; disabled sizes are skipped.
 */
export function WidgetSizePicker(props: WidgetSizePickerProps): JSX.Element {
	const allowed = () => props.sizes ?? WIDGET_SIZES;
	const isDisabled = (size: WidgetSize): boolean =>
		props.disabled === true || !allowed().includes(size);
	/** Live option buttons by size, for moving focus on Arrow/Home/End. */
	const buttons = new Map<WidgetSize, HTMLButtonElement>();

	const enabledSizes = (): WidgetSize[] => WIDGET_SIZES.filter((size) => !isDisabled(size));

	const choose = (size: WidgetSize): void => {
		buttons.get(size)?.focus();
		if (props.value !== size) props.onChange(size);
	};

	const onKeyDown = (event: KeyboardEvent): void => {
		const options = enabledSizes();
		if (options.length === 0) return;
		const current = options.indexOf(props.value);
		switch (event.key) {
			case "ArrowRight":
			case "ArrowDown": {
				event.preventDefault();
				const next = options[(current + 1 + options.length) % options.length];
				if (next !== undefined) choose(next);
				break;
			}
			case "ArrowLeft":
			case "ArrowUp": {
				event.preventDefault();
				const previous = options[(current - 1 + options.length) % options.length];
				if (previous !== undefined) choose(previous);
				break;
			}
			case "Home": {
				event.preventDefault();
				const first = options[0];
				if (first !== undefined) choose(first);
				break;
			}
			case "End": {
				event.preventDefault();
				const last = options[options.length - 1];
				if (last !== undefined) choose(last);
				break;
			}
		}
	};

	return (
		<div role="radiogroup" aria-label={props.label} class="wg-size-picker" onKeyDown={onKeyDown}>
			<For each={WIDGET_SIZES}>
				{(size) => (
					// biome-ignore lint/a11y/useSemanticElements: a segmented control of buttons with radio semantics.
					<button
						type="button"
						role="radio"
						aria-checked={props.value === size}
						aria-label={`${size} (${WIDGET_SIZE_SHAPES[size]})`}
						title={`${size} (${WIDGET_SIZE_SHAPES[size]})`}
						tabindex={props.value === size ? 0 : -1}
						disabled={isDisabled(size)}
						data-widget-size-option={size}
						class="wg-size-option"
						ref={(element) => {
							buttons.set(size, element);
						}}
						onClick={() => {
							if (!isDisabled(size) && props.value !== size) props.onChange(size);
						}}
					>
						{SHORT[size]}
					</button>
				)}
			</For>
		</div>
	);
}
