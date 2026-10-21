/**
 * Guarded `localStorage` access for per-visitor conveniences (a remembered
 * mode, a dismissed hint, the widget clipboard). Storage can be missing
 * (server render, tests), blocked (cookies off, private mode) or full, and
 * every one of those means "not remembered", never a throw — so each access
 * goes through here instead of its own try/catch
 * (docs/rule/error_handling.md, "Best-effort conveniences").
 *
 * Nothing that must persist reliably belongs in browser storage; that state
 * lives on the server.
 */

/** The part of `Storage` the app uses, so tests can pass an in-memory stand-in. */
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `window.localStorage`, or `null` when there is none or reading it throws. */
export function browserLocalStorage(): KeyValueStorage | null {
	try {
		if (typeof window === "undefined" || typeof window.localStorage === "undefined") return null;
		return window.localStorage;
	} catch {
		// Blocked storage throws on access to the property itself.
		return null;
	}
}

/** The stored text, or `null` when absent or unreadable. */
export function readStoredText(storage: KeyValueStorage | null, key: string): string | null {
	if (storage === null) return null;
	try {
		return storage.getItem(key);
	} catch {
		// Unreadable means "not remembered".
		return null;
	}
}

/** Stores `value` (or removes the key for `null`); `false` when storage refused. */
export function writeStoredText(
	storage: KeyValueStorage | null,
	key: string,
	value: string | null,
): boolean {
	if (storage === null) return false;
	try {
		if (value === null) storage.removeItem(key);
		else storage.setItem(key, value);
		return true;
	} catch {
		// Full or blocked: the in-memory state still holds for this visit.
		return false;
	}
}
