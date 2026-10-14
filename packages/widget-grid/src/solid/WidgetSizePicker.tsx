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
 * for every widget type, so resizing looks and works alike everywhere.
 */
export function WidgetSizePicker(props: WidgetSizePickerProps): JSX.Element {
	const allowed = () => props.sizes ?? WIDGET_SIZES;
	return (
		<div role="radiogroup" aria-label={props.label} class="wg-size-picker">
			<For each={WIDGET_SIZES}>
				{(size) => (
					// biome-ignore lint/a11y/useSemanticElements: a segmented control of buttons with radio semantics.
					<button
						type="button"
						role="radio"
						aria-checked={props.value === size}
						aria-label={`${size} (${WIDGET_SIZE_SHAPES[size]})`}
						title={`${size} (${WIDGET_SIZE_SHAPES[size]})`}
						disabled={props.disabled === true || !allowed().includes(size)}
						data-widget-size-option={size}
						class="wg-size-option"
						onClick={() => {
							if (props.value !== size) props.onChange(size);
						}}
					>
						{SHORT[size]}
					</button>
				)}
			</For>
		</div>
	);
}
