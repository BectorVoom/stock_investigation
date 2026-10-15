import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionMenu, placeActionMenu } from "../src/components/ui.tsx";

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

/** Gives the button a viewport rectangle (jsdom lays nothing out). */
function pinButton(
	name: string,
	rect: { left: number; top: number; right: number; bottom: number },
) {
	const button = screen.getByRole("button", { name });
	button.getBoundingClientRect = () =>
		DOMRect.fromRect({
			x: rect.left,
			y: rect.top,
			width: rect.right - rect.left,
			height: rect.bottom - rect.top,
		});
}

describe("ActionMenu placement", () => {
	it("renders the open menu on <body>, outside its owner, so no overflow container clips it", async () => {
		const { container } = render(() => (
			<ActionMenu
				buttonLabel="Open"
				menuLabel="Test menu"
				items={[{ label: "Rename", onSelect: () => undefined }]}
			/>
		));
		pinButton("Open", { left: 600, top: 100, right: 628, bottom: 128 });
		const menu = openMenu("Open");
		await Promise.resolve();
		expect(container.contains(menu)).toBe(false);
		expect(document.body.contains(menu)).toBe(true);
		// below-end: under the button, right edges aligned (jsdom menus are 0 wide).
		expect(menu.style.top).toBe("132px");
		expect(menu.style.left).toBe("628px");
	});

	it("Tab closes the menu and hands focus back to its button", async () => {
		render(() => (
			<ActionMenu
				buttonLabel="Open"
				menuLabel="Test menu"
				items={[{ label: "Rename", onSelect: () => undefined }]}
			/>
		));
		const menu = openMenu("Open");
		await Promise.resolve();
		fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Rename" }), { key: "Tab" });
		expect(screen.queryByRole("menu", { name: "Test menu" })).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" }));
	});

	it("opens above the button's leading edge with placement above-start", async () => {
		render(() => (
			<ActionMenu
				buttonLabel="Choose mode"
				menuLabel="Test menu"
				placement="above-start"
				iconTrigger={{ icon: "plus-lg" }}
				items={[{ label: "Research", icon: "search", onSelect: () => undefined }]}
			/>
		));
		pinButton("Choose mode", { left: 100, top: 500, right: 128, bottom: 528 });
		const menu = openMenu("Choose mode");
		await Promise.resolve();
		expect(menu.style.top).toBe("496px");
		expect(menu.style.left).toBe("100px");
	});
});

describe("placeActionMenu (fixed position in the viewport)", () => {
	const viewport = { width: 1440, height: 900 };
	const size = { width: 180, height: 300 };

	it("hangs below-end under the button with right edges aligned", () => {
		const anchor = { left: 1000, top: 100, right: 1028, bottom: 128 };
		expect(placeActionMenu(anchor, size, viewport, "below-end")).toEqual({ left: 848, top: 132 });
	});

	it("stands above-start on the button with left edges aligned", () => {
		const anchor = { left: 360, top: 780, right: 388, bottom: 808 };
		expect(placeActionMenu(anchor, size, viewport, "above-start")).toEqual({ left: 360, top: 476 });
	});

	it("flips below-end above the button when it does not fit below", () => {
		const anchor = { left: 1000, top: 800, right: 1028, bottom: 828 };
		expect(placeActionMenu(anchor, size, viewport, "below-end").top).toBe(496);
	});

	it("flips above-start below the button when it does not fit above", () => {
		const anchor = { left: 20, top: 40, right: 48, bottom: 68 };
		expect(placeActionMenu(anchor, size, viewport, "above-start").top).toBe(72);
	});

	it("stays inside the viewport when the button sits near the left edge (a narrow panel)", () => {
		const anchor = { left: 10, top: 100, right: 38, bottom: 128 };
		expect(placeActionMenu(anchor, size, viewport, "below-end").left).toBe(8);
	});

	it("stays inside a phone viewport when the menu is taller than the space on both sides", () => {
		const anchor = { left: 300, top: 300, right: 328, bottom: 328 };
		const spot = placeActionMenu(
			anchor,
			{ width: 180, height: 500 },
			{ width: 390, height: 600 },
			"below-end",
		);
		expect(spot.left).toBe(148);
		expect(spot.top).toBe(92);
	});
});
