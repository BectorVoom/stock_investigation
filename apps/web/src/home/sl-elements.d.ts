import type { JSX } from "solid-js";

/**
 * Typed light-DOM declarations for the Shoelace custom elements the Home page
 * uses (no `any`: every prop is a concrete type). Shoelace renders into its
 * shadow roots; tests and callers only touch these light-DOM attributes,
 * properties and `on:sl-*` events. Custom-element events do not bubble through
 * Solid's delegation, hence the explicit `on:sl-*` props.
 */

interface SlCommon {
	readonly class?: string;
	readonly slot?: string;
	readonly children?: JSX.Element;
	/** Stable test hooks and widget wiring pass through untouched. */
	readonly [dataAttribute: `data-${string}`]: string | undefined;
}

export interface SlButtonProps extends SlCommon {
	readonly variant?: "default" | "primary" | "success" | "neutral" | "warning" | "danger" | "text";
	readonly size?: "small" | "medium" | "large";
	readonly caret?: boolean;
	readonly disabled?: boolean;
	readonly loading?: boolean;
	readonly type?: "button" | "submit" | "reset";
	readonly name?: string;
	readonly value?: string;
	readonly autofocus?: boolean;
	/**
	 * Solid sets hyphenated props on custom elements as camelCase JS
	 * properties (never the attribute, so assistive tech never sees them):
	 * `attr:` forces the real attribute (F3: the problems list describes the
	 * save button). No `any`: the value type is exact.
	 */
	readonly "attr:aria-describedby"?: string;
	readonly "on:sl-focus"?: (event: Event) => void;
	readonly "on:sl-blur"?: (event: Event) => void;
	readonly onClick?: (event: MouseEvent & { readonly currentTarget: HTMLElement }) => void;
}

export interface SlCardProps extends SlCommon {
	readonly "on:sl-show"?: (event: Event) => void;
}

export interface SlSkeletonProps extends SlCommon {
	readonly effect?: "none" | "sheen" | "pulse";
}

export interface SlDropdownProps extends SlCommon {
	readonly placement?:
		| "top"
		| "top-start"
		| "top-end"
		| "bottom"
		| "bottom-start"
		| "bottom-end"
		| "left"
		| "left-start"
		| "left-end"
		| "right"
		| "right-start"
		| "right-end";
	readonly hoist?: boolean;
	readonly open?: boolean;
	readonly "on:sl-show"?: (event: Event) => void;
	readonly "on:sl-hide"?: (event: Event) => void;
}

export interface SlMenuProps extends SlCommon {
	readonly label?: string;
	readonly "on:sl-select"?: (
		event: Event & { readonly detail: { readonly item: SlMenuItemElement } },
	) => void;
}

export interface SlMenuItemElement extends HTMLElement {
	readonly value: string;
}

export interface SlMenuItemProps extends SlCommon {
	readonly value?: string;
	readonly checked?: boolean;
	readonly disabled?: boolean;
	readonly type?: "normal" | "checkbox";
}

export interface SlSelectProps extends SlCommon {
	readonly label?: string;
	readonly value?: string | readonly string[];
	readonly size?: "small" | "medium" | "large";
	readonly placeholder?: string;
	readonly hoist?: boolean;
	readonly disabled?: boolean;
	readonly required?: boolean;
	readonly multiple?: boolean;
	readonly maxOptionsVisible?: number;
	readonly helpText?: string;
	readonly name?: string;
	readonly "aria-describedby"?: string;
	/** `attr:` forces the real attribute on the custom element (see SlButtonProps). */
	readonly "attr:aria-describedby"?: string;
	readonly "on:sl-change"?: (event: Event & { readonly currentTarget: SlSelectElement }) => void;
	readonly "on:sl-input"?: (event: Event & { readonly currentTarget: SlSelectElement }) => void;
}

export interface SlOptionProps extends SlCommon {
	readonly value: string;
	readonly disabled?: boolean;
}

export interface SlInputProps extends SlCommon {
	readonly label?: string;
	readonly value?: string;
	readonly size?: "small" | "medium" | "large";
	readonly placeholder?: string;
	readonly type?: "text" | "number" | "url" | "search";
	readonly maxlength?: number;
	readonly minlength?: number;
	readonly disabled?: boolean;
	readonly required?: boolean;
	readonly helpText?: string;
	readonly name?: string;
	readonly "aria-describedby"?: string;
	readonly "on:sl-input"?: (event: Event & { readonly currentTarget: SlInputElement }) => void;
	readonly "on:sl-change"?: (event: Event & { readonly currentTarget: SlInputElement }) => void;
}

export interface SlDialogProps extends SlCommon {
	readonly label: string;
	readonly open?: boolean;
	readonly "on:sl-show"?: (event: Event) => void;
	readonly "on:sl-after-show"?: (event: Event) => void;
	readonly "on:sl-hide"?: (event: Event) => void;
	readonly "on:sl-after-hide"?: (event: Event) => void;
	readonly "on:sl-request-close"?: (event: Event) => void;
}

/** The imperative handle of an `sl-dialog` (open/close + focus return). */
export interface SlDialogElement extends HTMLElement {
	readonly dialog: HTMLDivElement;
	show(): Promise<void>;
	hide(): Promise<void>;
}

/** The imperative handle of an `sl-select` (its current value). */
export interface SlSelectElement extends HTMLElement {
	value: string | readonly string[];
}

/** The imperative handle of an `sl-input` (its current value). */
export interface SlInputElement extends HTMLElement {
	value: string;
}

declare module "solid-js" {
	namespace JSX {
		interface IntrinsicElements {
			"sl-button": SlButtonProps;
			"sl-card": SlCardProps;
			"sl-skeleton": SlSkeletonProps;
			"sl-dropdown": SlDropdownProps;
			"sl-menu": SlMenuProps;
			"sl-menu-item": SlMenuItemProps;
			"sl-select": SlSelectProps;
			"sl-option": SlOptionProps;
			"sl-input": SlInputProps;
			"sl-dialog": SlDialogProps;
		}
	}
}
