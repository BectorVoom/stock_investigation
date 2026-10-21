import { describe, expect, it } from "vitest";
import {
	type KeyValueStorage,
	readStoredText,
	writeStoredText,
} from "../src/lib/browserStorage.ts";

function memoryStorage(): KeyValueStorage & { readonly items: Map<string, string> } {
	const items = new Map<string, string>();
	return {
		items,
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => {
			items.set(key, value);
		},
		removeItem: (key) => {
			items.delete(key);
		},
	};
}

/** Storage that refuses everything, as blocked or full storage does. */
const refusingStorage: KeyValueStorage = {
	getItem: () => {
		throw new DOMException("denied", "SecurityError");
	},
	setItem: () => {
		throw new DOMException("full", "QuotaExceededError");
	},
	removeItem: () => {
		throw new DOMException("denied", "SecurityError");
	},
};

describe("browser storage guard", () => {
	it("reads, writes and removes through working storage", () => {
		const storage = memoryStorage();
		expect(writeStoredText(storage, "k", "v")).toBe(true);
		expect(readStoredText(storage, "k")).toBe("v");
		expect(writeStoredText(storage, "k", null)).toBe(true);
		expect(readStoredText(storage, "k")).toBeNull();
	});

	it("treats missing storage as nothing remembered", () => {
		expect(readStoredText(null, "k")).toBeNull();
		expect(writeStoredText(null, "k", "v")).toBe(false);
	});

	it("never throws when storage refuses", () => {
		expect(readStoredText(refusingStorage, "k")).toBeNull();
		expect(writeStoredText(refusingStorage, "k", "v")).toBe(false);
		expect(writeStoredText(refusingStorage, "k", null)).toBe(false);
	});
});
