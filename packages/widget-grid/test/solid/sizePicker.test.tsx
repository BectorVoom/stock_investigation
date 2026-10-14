import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { WidgetSize } from "../../src/core/types.ts";
import { WidgetSizePicker } from "../../src/solid/WidgetSizePicker.tsx";

afterEach(() => cleanup());

function options(): HTMLElement[] {
	const group = screen.getByRole("radiogroup", { name: "Size of “Revenue”" });
	return [...group.querySelectorAll('[role="radio"]')].filter(
		(node): node is HTMLElement => node instanceof HTMLElement,
	);
}

function tabIndexes(): (string | null)[] {
	return options().map((option) => option.getAttribute("tabindex"));
}

describe("WidgetSizePicker", () => {
	it("renders one segmented S/M/L group where only the checked option is in the tab order", () => {
		render(() => (
			<WidgetSizePicker value="medium" onChange={() => undefined} label="Size of “Revenue”" />
		));
		const group = screen.getByRole("radiogroup", { name: "Size of “Revenue”" });
		expect(group.className).toContain("wg-size-picker");
		expect(options()).toHaveLength(3);
		expect(options().map((option) => option.textContent)).toEqual(["S", "M", "L"]);
		for (const option of options()) {
			expect(option.className).toContain("wg-size-option");
		}
		expect(options().map((option) => option.getAttribute("aria-checked"))).toEqual([
			"false",
			"true",
			"false",
		]);
		expect(tabIndexes()).toEqual(["-1", "0", "-1"]);
	});

	it("clicks change the size and disabled sizes stay out", async () => {
		const [value, setValue] = createSignal<WidgetSize>("small");
		render(() => (
			<WidgetSizePicker
				value={value()}
				sizes={["small", "medium"]}
				onChange={setValue}
				label="Size of “Revenue”"
			/>
		));
		const [small, medium, large] = options();
		if (small === undefined || medium === undefined || large === undefined) {
			throw new Error("the size options are missing");
		}
		expect(large.hasAttribute("disabled")).toBe(true);

		medium.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await Promise.resolve();
		expect(value()).toBe("medium");
		expect(tabIndexes()).toEqual(["-1", "0", "-1"]);

		large.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await Promise.resolve();
		expect(value()).toBe("medium");
	});

	it("Arrow keys move and select, skipping disabled sizes with wrap-around", async () => {
		const [value, setValue] = createSignal<WidgetSize>("small");
		const seen: WidgetSize[] = [];
		render(() => (
			<WidgetSizePicker
				value={value()}
				sizes={["small", "large"]}
				onChange={(size) => {
					seen.push(size);
					setValue(size);
				}}
				label="Size of “Revenue”"
			/>
		));
		const group = screen.getByRole("radiogroup", { name: "Size of “Revenue”" });
		// Medium is disabled and skipped: right from small wraps to large.
		group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		await Promise.resolve();
		expect(value()).toBe("large");
		expect(seen).toEqual(["large"]);
		// Right from large wraps back to small.
		group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		await Promise.resolve();
		expect(value()).toBe("small");
		// Left from small wraps to large.
		group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
		await Promise.resolve();
		expect(value()).toBe("large");
	});

	it("Home and End jump to the first and last enabled size", async () => {
		const [value, setValue] = createSignal<WidgetSize>("medium");
		render(() => (
			<WidgetSizePicker value={value()} onChange={setValue} label="Size of “Revenue”" />
		));
		const group = screen.getByRole("radiogroup", { name: "Size of “Revenue”" });
		group.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
		await Promise.resolve();
		expect(value()).toBe("small");
		group.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
		await Promise.resolve();
		expect(value()).toBe("large");
	});

	it("moves focus with the selection", async () => {
		const [value, setValue] = createSignal<WidgetSize>("small");
		render(() => (
			<WidgetSizePicker value={value()} onChange={setValue} label="Size of “Revenue”" />
		));
		const [small] = options();
		if (small === undefined) throw new Error("the small option is missing");
		small.focus();
		expect(document.activeElement).toBe(small);
		const group = screen.getByRole("radiogroup", { name: "Size of “Revenue”" });
		group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		await Promise.resolve();
		expect(value()).toBe("medium");
		const [, medium] = options();
		expect(document.activeElement).toBe(medium);
	});

	it("disables the whole group when disabled", () => {
		render(() => (
			<WidgetSizePicker
				value="small"
				disabled={true}
				onChange={() => undefined}
				label="Size of “Revenue”"
			/>
		));
		for (const option of options()) {
			expect(option.hasAttribute("disabled")).toBe(true);
		}
	});
});
