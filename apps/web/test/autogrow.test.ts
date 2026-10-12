import { afterEach, describe, expect, it } from "vitest";
import { fitTextarea, supportsFieldSizing } from "../src/chat/autogrow.ts";

afterEach(() => {
	document.body.innerHTML = "";
});

/** happy-dom reports no layout, so the content height is injected directly. */
function boxWithScrollHeight(scrollHeight: number): HTMLTextAreaElement {
	const box = document.createElement("textarea");
	document.body.append(box);
	Object.defineProperty(box, "scrollHeight", { value: scrollHeight, configurable: true });
	return box;
}

describe("composer autogrow fallback", () => {
	it("reports CSS field-sizing support as a boolean without throwing", () => {
		expect(typeof supportsFieldSizing()).toBe("boolean");
	});

	it("sets the height from the content height through the CSSOM", () => {
		const box = boxWithScrollHeight(120);
		fitTextarea(box);
		expect(box.style.height).toBe("120px");
	});

	it("caps the height at the element's own CSS maximum", () => {
		const box = boxWithScrollHeight(500);
		box.style.maxHeight = "100px";
		fitTextarea(box);
		expect(box.style.height).toBe("100px");
	});

	it("falls back to the max-h-48 cap when no CSS maximum is set", () => {
		const box = boxWithScrollHeight(500);
		fitTextarea(box);
		expect(box.style.height).toBe("192px");
	});

	it("shrinks back when the text is cleared", () => {
		const box = boxWithScrollHeight(150);
		fitTextarea(box);
		expect(box.style.height).toBe("150px");
		Object.defineProperty(box, "scrollHeight", { value: 24, configurable: true });
		fitTextarea(box);
		expect(box.style.height).toBe("24px");
	});
});
