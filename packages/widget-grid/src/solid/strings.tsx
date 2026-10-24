import { createContext, type JSX, useContext } from "solid-js";
import { WIDGET_SIZE_SHAPES } from "../core/sizes.ts";
import type { WidgetSize } from "../core/types.ts";

/**
 * Every word the grid's own controls show or announce. The package stays
 * free of any translation library (ADR-0019): a host in another language
 * passes its own strings through `WidgetGridStringsProvider`; without one the
 * English defaults apply.
 */
export interface WidgetGridStrings {
	/** The polite announcement after a completed move (1-based position). */
	readonly moveAnnouncement: (title: string, position: number, total: number) => string;
	/** Accessible name and tooltip of a frame's select toggle. */
	readonly selectWidget: (title: string) => string;
	/** Accessible name and tooltip of a size option, e.g. "medium (2 × 2)". */
	readonly sizeOptionName: (size: WidgetSize) => string;
	/** The size option's visible letter. */
	readonly sizeOptionShort: (size: WidgetSize) => string;
}

const SHORT: { readonly [S in WidgetSize]: string } = { small: "S", medium: "M", large: "L" };

export const ENGLISH_WIDGET_GRID_STRINGS: WidgetGridStrings = {
	moveAnnouncement: (title, position, total) =>
		`Moved “${title}” to position ${position} of ${total}.`,
	selectWidget: (title) => `Select “${title}”`,
	sizeOptionName: (size) => `${size} (${WIDGET_SIZE_SHAPES[size]})`,
	sizeOptionShort: (size) => SHORT[size],
};

/** A getter, so a host can switch language without remounting the grid. */
const StringsContext = createContext<() => WidgetGridStrings>(() => ENGLISH_WIDGET_GRID_STRINGS);

export function WidgetGridStringsProvider(props: {
	readonly strings: WidgetGridStrings;
	readonly children: JSX.Element;
}): JSX.Element {
	return (
		<StringsContext.Provider value={() => props.strings}>{props.children}</StringsContext.Provider>
	);
}

/** The current strings; read the getter inside JSX or a callback so it stays live. */
export function useWidgetGridStrings(): () => WidgetGridStrings {
	return useContext(StringsContext);
}
