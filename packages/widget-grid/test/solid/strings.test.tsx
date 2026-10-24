import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import {
	ENGLISH_WIDGET_GRID_STRINGS,
	WidgetFrame,
	type WidgetGridStrings,
	WidgetGridStringsProvider,
	WidgetSizePicker,
} from "../../src/solid/index.ts";

afterEach(cleanup);

const widget = { widgetId: "w1", type: "text", size: "small", title: "Revenue" } as const;

const french: WidgetGridStrings = {
	moveAnnouncement: (title, position, total) => `« ${title} » déplacé en ${position}/${total}.`,
	selectWidget: (title) => `Sélectionner « ${title} »`,
	sizeOptionName: (size) => `taille ${size}`,
	sizeOptionShort: (size) => size.slice(0, 1).toUpperCase(),
};

describe("WidgetGridStrings", () => {
	it("speaks English without a provider", () => {
		render(() => (
			<WidgetFrame widget={widget} onSelectChange={() => {}}>
				<p>body</p>
			</WidgetFrame>
		));
		expect(screen.getByRole("button", { name: "Select “Revenue”" })).toBeTruthy();
		expect(ENGLISH_WIDGET_GRID_STRINGS.sizeOptionName("large")).toBe("large (full width × 2)");
	});

	it("uses the host's strings and follows a change without remounting", () => {
		const [strings, setStrings] = createSignal<WidgetGridStrings>(ENGLISH_WIDGET_GRID_STRINGS);
		render(() => (
			<WidgetGridStringsProvider strings={strings()}>
				<WidgetFrame widget={widget} onSelectChange={() => {}}>
					<p>body</p>
				</WidgetFrame>
				<WidgetSizePicker value="small" label="Size" onChange={() => {}} />
			</WidgetGridStringsProvider>
		));
		const toggle = screen.getByRole("button", { name: "Select “Revenue”" });
		setStrings(french);
		expect(toggle.getAttribute("aria-label")).toBe("Sélectionner « Revenue »");
		expect(screen.getByRole("radio", { name: "taille medium" }).textContent).toBe("M");
	});
});
