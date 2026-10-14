import { afterEach, describe, expect, it, vi } from "vitest";
import {
	dismissNotebookSuggest,
	isKeptRemoval,
	isNotebookSuggestDismissed,
	readKeptRemovals,
	readWorkspaceMode,
	rememberKeptRemoval,
	writeWorkspaceMode,
} from "../../src/notebook/workspaceMode.ts";

afterEach(() => {
	vi.restoreAllMocks();
	window.localStorage.clear();
});

describe("workspace mode store", () => {
	it("opens a conversation never seen in Chat-first", () => {
		expect(readWorkspaceMode("ws_unseen")).toBe("chat");
	});

	it("remembers the mode per workspace id", () => {
		writeWorkspaceMode("ws_a", "notebook");
		expect(readWorkspaceMode("ws_a")).toBe("notebook");
		expect(readWorkspaceMode("ws_b")).toBe("chat");
		writeWorkspaceMode("ws_a", "chat");
		expect(readWorkspaceMode("ws_a")).toBe("chat");
	});

	it("falls back to Chat-first when storage fails", () => {
		const fail = (): never => {
			throw new Error("denied");
		};
		const broken: Storage = {
			get length(): number {
				return 0;
			},
			clear: fail,
			getItem: fail,
			key: fail,
			removeItem: fail,
			setItem: fail,
		};
		const original = window.localStorage;
		Object.defineProperty(window, "localStorage", { value: broken, configurable: true });
		try {
			expect(readWorkspaceMode("ws_storage_fail")).toBe("chat");
			// Writing must not throw either: the mode still holds for this visit.
			expect(() => writeWorkspaceMode("ws_storage_fail", "notebook")).not.toThrow();
			expect(readWorkspaceMode("ws_storage_fail")).toBe("chat");
		} finally {
			Object.defineProperty(window, "localStorage", { value: original, configurable: true });
		}
	});

	it("treats an unknown stored value as Chat-first", () => {
		window.localStorage.setItem("research.workspace-mode.ws_a", "hybrid");
		expect(readWorkspaceMode("ws_a")).toBe("chat");
	});
});

describe("notebook suggestion dismissal", () => {
	it("is remembered per workspace", () => {
		expect(isNotebookSuggestDismissed("ws_a")).toBe(false);
		dismissNotebookSuggest("ws_a");
		expect(isNotebookSuggestDismissed("ws_a")).toBe(true);
		expect(isNotebookSuggestDismissed("ws_b")).toBe(false);
	});
});

describe("kept removals", () => {
	it("remembers kept proposals per workspace and survives invalid stored JSON", () => {
		expect(isKeptRemoval(readKeptRemovals("ws_a"), "run_1", "nb_1")).toBe(false);
		const next = rememberKeptRemoval("ws_a", readKeptRemovals("ws_a"), "run_1", "nb_1");
		expect(isKeptRemoval(next, "run_1", "nb_1")).toBe(true);
		expect(isKeptRemoval(readKeptRemovals("ws_a"), "run_1", "nb_1")).toBe(true);
		expect(isKeptRemoval(readKeptRemovals("ws_a"), "run_1", "nb_2")).toBe(false);
		expect(isKeptRemoval(readKeptRemovals("ws_b"), "run_1", "nb_1")).toBe(false);

		window.localStorage.setItem("research.notebook-kept-removals.ws_a", "not json");
		expect(readKeptRemovals("ws_a")).toEqual({});
	});
});
