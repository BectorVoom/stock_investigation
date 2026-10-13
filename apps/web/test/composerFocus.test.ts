import { describe, expect, it } from "vitest";
import { focusComposerBox, mayFocusComposer } from "../src/chat/composerFocus.ts";

describe("mayFocusComposer", () => {
	it("allows focus from a neutral target", () => {
		expect(mayFocusComposer(null)).toBe(true);
		expect(mayFocusComposer(document.body)).toBe(true);
		const button = document.createElement("button");
		document.body.append(button);
		try {
			expect(mayFocusComposer(button)).toBe(true);
		} finally {
			button.remove();
		}
	});

	it("refuses to steal focus from a text control", () => {
		for (const element of [
			document.createElement("input"),
			document.createElement("textarea"),
			document.createElement("select"),
		]) {
			document.body.append(element);
			try {
				expect(mayFocusComposer(element)).toBe(false);
			} finally {
				element.remove();
			}
		}
		const editable = document.createElement("div");
		editable.contentEditable = "true";
		document.body.append(editable);
		try {
			expect(mayFocusComposer(editable)).toBe(false);
		} finally {
			editable.remove();
		}
	});

	it("refuses to steal focus from an open menu or dialog", () => {
		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		const item = document.createElement("button");
		item.setAttribute("role", "menuitem");
		menu.append(item);
		document.body.append(menu);
		try {
			expect(mayFocusComposer(item)).toBe(false);
		} finally {
			menu.remove();
		}
		const dialog = document.createElement("dialog");
		const confirm = document.createElement("button");
		dialog.append(confirm);
		document.body.append(dialog);
		try {
			expect(mayFocusComposer(confirm)).toBe(false);
		} finally {
			dialog.remove();
		}
	});
});

describe("focusComposerBox", () => {
	it("does nothing without a composer on the page", () => {
		expect(document.querySelector('form[aria-label="Research composer"]')).toBeNull();
		expect(focusComposerBox()).toBe(false);
	});
});
