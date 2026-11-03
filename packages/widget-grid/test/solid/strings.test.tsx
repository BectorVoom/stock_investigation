import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import {
	ENGLISH_WIDGET_GRID_STRINGS,
	type WidgetGridStrings,
	WidgetGridStringsProvider,
	WidgetSizePicker,
} from "../../src/solid/index.ts";

afterEach(cleanup);

const french: WidgetGridStrings = {
	moveAnnouncement: (title, position, total) => `« ${title} » déplacé en ${position}/${total}.`,
	sizeOptionName: (size) => `taille ${size}`,
	sizeOptionShort: (size) => size.slice(0, 1).toUpperCase(),
};

describe("WidgetGridStrings", () => {
	it("speaks English without a provider", () => {
		render(() => <WidgetSizePicker value="small" label="Size" onChange={() => {}} />);
		expect(screen.getByRole("radio", { name: "medium (2 × 2)" }).textContent).toBe("M");
		expect(ENGLISH_WIDGET_GRID_STRINGS.sizeOptionName("large")).toBe("large (full width × 2)");
	});

	it("uses the host's strings and follows a change without remounting", () => {
		const [strings, setStrings] = createSignal<WidgetGridStrings>(ENGLISH_WIDGET_GRID_STRINGS);
		render(() => (
			<WidgetGridStringsProvider strings={strings()}>
				<WidgetSizePicker value="small" label="Size" onChange={() => {}} />
			</WidgetGridStringsProvider>
		));
		const medium = screen.getByRole("radio", { name: "medium (2 × 2)" });
		setStrings(french);
		expect(medium.getAttribute("aria-label")).toBe("taille medium");
		expect(screen.getByRole("radio", { name: "taille medium" }).textContent).toBe("M");
	});
});
