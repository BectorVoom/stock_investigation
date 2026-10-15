import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionMenu } from "../src/components/ui.tsx";

afterEach(() => {
	cleanup();
});

function openMenu(buttonName: string) {
	fireEvent.click(screen.getByRole("button", { name: buttonName }));
	return screen.getByRole("menu", { name: "Test menu" });
}

describe("ActionMenu without checked items", () => {
	it("renders plain menuitems with no aria-checked, below the button's trailing edge", () => {
		const onSelect = vi.fn();
		render(() => (
			<ActionMenu
				buttonLabel="Open"
				menuLabel="Test menu"
				items={[
					{ label: "Rename", onSelect },
					{ label: "Delete", onSelect },
				]}
			/>
		));
		const menu = openMenu("Open");
		for (const name of ["Rename", "Delete"]) {
			const item = within(menu).getByRole("menuitem", { name });
			expect(item.getAttribute("aria-checked")).toBeNull();
		}
		// No radio anywhere: no check glyph beyond the trigger's own.
		expect(menu.querySelector("svg")).toBeNull();
		expect(menu.className).toContain("right-0");
		expect(menu.className).not.toContain("bottom-full");

		fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("menu", { name: "Test menu" })).toBeNull();
	});
});

describe("ActionMenu radio items (ADR-0023)", () => {
	it("renders every item as menuitemradio with aria-checked when any item defines checked", () => {
		render(() => (
			<ActionMenu
				buttonLabel="Choose mode"
				menuLabel="Test menu"
				iconTrigger={{ icon: "plus-lg" }}
				items={[
					{ label: "Research", icon: "search", checked: true, onSelect: () => undefined },
					{ label: "Notebook", icon: "journal-text", checked: false, onSelect: () => undefined },
				]}
			/>
		));
		const menu = openMenu("Choose mode");
		const research = within(menu).getByRole("menuitemradio", { name: "Research" });
		const notebook = within(menu).getByRole("menuitemradio", { name: "Notebook" });
		expect(research.getAttribute("aria-checked")).toBe("true");
		expect(notebook.getAttribute("aria-checked")).toBe("false");
		// The checked item carries a trailing check glyph (leading icon plus
		// check); the unchecked one only its leading icon.
		expect(research.querySelectorAll("svg")).toHaveLength(2);
		expect(notebook.querySelectorAll("svg")).toHaveLength(1);
	});

	it("radios the whole menu even when only one item defines checked", () => {
		render(() => (
			<ActionMenu
				buttonLabel="Choose mode"
				menuLabel="Test menu"
				items={[
					{ label: "Research", checked: true, onSelect: () => undefined },
					{ label: "Notebook", onSelect: () => undefined },
				]}
			/>
		));
		const menu = openMenu("Choose mode");
		expect(
			within(menu).getByRole("menuitemradio", { name: "Research" }).getAttribute("aria-checked"),
		).toBe("true");
		expect(
			within(menu).getByRole("menuitemradio", { name: "Notebook" }).getAttribute("aria-checked"),
		).toBe("false");
	});
});

describe("ActionMenu placement", () => {
	it("opens above the button's leading edge with placement above-start", () => {
		render(() => (
			<ActionMenu
				buttonLabel="Choose mode"
				menuLabel="Test menu"
				placement="above-start"
				iconTrigger={{ icon: "plus-lg" }}
				items={[{ label: "Research", icon: "search", onSelect: () => undefined }]}
			/>
		));
		const menu = openMenu("Choose mode");
		expect(menu.className).toContain("bottom-full");
		expect(menu.className).toContain("left-0");
		expect(menu.className).not.toContain("right-0");
	});
});
