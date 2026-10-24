import { NOTEBOOK_LIMITS, type NotebookWidgetOrigin, type WidgetCore } from "@research/contracts";
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { widgetClipboardMessages } from "../../src/widgets/widgetClipboard.messages.ts";
import {
	clipboardCountText,
	createWidgetClipboardStore,
	HOME_CLIPBOARD_SCOPE,
	parseWidgetClipboard,
	parseWidgetClipboardJson,
	resetWidgetClipboard,
	resolveClipboardPaste,
	skippedResearchNoticeText,
	WIDGET_CLIPBOARD_STORAGE_KEY,
	type WidgetClipboardEntry,
	type WidgetClipboardStorage,
	widgetClipboard,
} from "../../src/widgets/widgetClipboard.ts";

const OWNER: NotebookWidgetOrigin = {
	kind: "owner",
	messageId: null,
	runId: null,
	componentId: null,
};
const CHAT: NotebookWidgetOrigin = {
	kind: "chat",
	messageId: "msg_1",
	runId: null,
	componentId: null,
};

function textCore(widgetId = "nb-text"): WidgetCore {
	return { widgetId, type: "text", title: "Notes", size: "small", text: "Hello" };
}

function chartCore(widgetId = "nb-chart"): WidgetCore {
	return {
		widgetId,
		type: "chart",
		title: "Demand",
		size: "medium",
		chartType: "line",
		unit: "GWh",
		series: [{ name: "Base", points: [{ x: "2026", y: 120 }] }],
	};
}

function researchCore(widgetId = "nb-research"): WidgetCore {
	return {
		widgetId,
		type: "research",
		title: "Demand scenarios",
		size: "large",
		componentId: "run_1_table",
	};
}

function entry(core: WidgetCore, origin: NotebookWidgetOrigin): WidgetClipboardEntry {
	return { core, origin };
}

function storedJson(sourceWorkspaceId: string, entries: readonly WidgetClipboardEntry[]): string {
	return JSON.stringify({
		version: 1,
		sourceWorkspaceId,
		entries: entries.map((item) => ({ core: item.core, origin: item.origin })),
	});
}

/** A `Storage`-like object backed by a plain map (another tab in E2E terms). */
function memoryStorage(initial: Record<string, string> = {}): {
	readonly storage: WidgetClipboardStorage;
	readonly map: Map<string, string>;
} {
	const map = new Map(Object.entries(initial));
	return {
		map,
		storage: {
			getItem: (key) => map.get(key) ?? null,
			setItem: (key, value) => {
				map.set(key, value);
			},
			removeItem: (key) => {
				map.delete(key);
			},
		},
	};
}

const roots: (() => void)[] = [];

function createStore(storage: WidgetClipboardStorage | null) {
	let store!: ReturnType<typeof createWidgetClipboardStore>;
	const dispose = createRoot((release) => {
		store = createWidgetClipboardStore(storage);
		return release;
	});
	roots.push(dispose);
	return store;
}

afterEach(() => {
	while (roots.length > 0) roots.pop()?.();
	window.localStorage.clear();
	resetWidgetClipboard();
});

describe("widget clipboard parse", () => {
	it("reads valid content", () => {
		const content = parseWidgetClipboard({
			version: 1,
			sourceWorkspaceId: "ws_1",
			entries: [entry(textCore(), OWNER)],
		});
		expect(content).toEqual({ sourceWorkspaceId: "ws_1", entries: [entry(textCore(), OWNER)] });
	});

	it("reads stored JSON", () => {
		const content = parseWidgetClipboardJson(storedJson("ws_1", [entry(textCore(), OWNER)]));
		expect(content?.sourceWorkspaceId).toBe("ws_1");
		expect(content?.entries).toHaveLength(1);
	});

	it("treats absent or invalid JSON as an empty clipboard", () => {
		expect(parseWidgetClipboardJson(null)).toBeNull();
		expect(parseWidgetClipboardJson("")).toBeNull();
		expect(parseWidgetClipboardJson("{oops")).toBeNull();
		expect(parseWidgetClipboardJson("42")).toBeNull();
	});

	it("treats the wrong shape as an empty clipboard", () => {
		expect(parseWidgetClipboard(null)).toBeNull();
		expect(parseWidgetClipboard({})).toBeNull();
		expect(parseWidgetClipboard({ version: 2, sourceWorkspaceId: "ws_1", entries: [] })).toBeNull();
		expect(parseWidgetClipboard({ version: 1, sourceWorkspaceId: "", entries: [] })).toBeNull();
		expect(
			parseWidgetClipboard({
				version: 1,
				sourceWorkspaceId: "ws_1",
				entries: [{ core: { type: "nope" }, origin: OWNER }],
			}),
		).toBeNull();
		expect(parseWidgetClipboard({ version: 1, sourceWorkspaceId: "ws_1", entries: [] })).toBeNull();
	});

	it("bounds the entry count by the notebook widget limit", () => {
		const many = Array.from({ length: NOTEBOOK_LIMITS.maxWidgets + 1 }, (_, index) =>
			entry(textCore(`nb-${index}`), OWNER),
		);
		expect(
			parseWidgetClipboard({ version: 1, sourceWorkspaceId: "ws_1", entries: many }),
		).toBeNull();
		const maxed = Array.from({ length: NOTEBOOK_LIMITS.maxWidgets }, (_, index) =>
			entry(textCore(`nb-${index}`), OWNER),
		);
		expect(
			parseWidgetClipboard({ version: 1, sourceWorkspaceId: "ws_1", entries: maxed })?.entries,
		).toHaveLength(NOTEBOOK_LIMITS.maxWidgets);
	});
});

describe("resolveClipboardPaste", () => {
	it("resolves an empty clipboard to nothing", () => {
		expect(resolveClipboardPaste(null, "ws_1")).toEqual({ entries: [], skippedResearch: 0 });
	});

	it("pastes in the same workspace under fresh unique ids with the origin kept", () => {
		const clipboard = parseWidgetClipboard({
			version: 1,
			sourceWorkspaceId: "ws_1",
			entries: [entry(chartCore(), CHAT), entry(chartCore("nb-chart-2"), CHAT)],
		});
		if (clipboard === null) throw new Error("fixture clipboard is invalid");
		const resolved = resolveClipboardPaste(clipboard, "ws_1");
		expect(resolved.skippedResearch).toBe(0);
		expect(resolved.entries).toHaveLength(2);
		const ids = resolved.entries.map((item) => item.core.widgetId);
		expect(new Set(ids).size).toBe(2);
		expect(ids).not.toContain("nb-chart");
		expect(ids).not.toContain("nb-chart-2");
		expect(resolved.entries.map((item) => item.origin)).toEqual([CHAT, CHAT]);
	});

	it("deep-copies content, so editing the paste leaves the clipboard alone", () => {
		const clipboard = parseWidgetClipboard({
			version: 1,
			sourceWorkspaceId: "ws_1",
			entries: [entry(chartCore(), OWNER)],
		});
		if (clipboard === null) throw new Error("fixture clipboard is invalid");
		const resolved = resolveClipboardPaste(clipboard, "ws_1");
		const pasted = resolved.entries[0]?.core;
		if (pasted?.type !== "chart") throw new Error("expected a chart paste");
		pasted.series[0]?.points.push({ x: "2027", y: 140 });
		const stored = clipboard.entries[0]?.core;
		if (stored?.type !== "chart") throw new Error("expected a chart entry");
		expect(stored.series[0]?.points).toHaveLength(1);
	});

	it("makes pasted widgets owner-made in another workspace", () => {
		const clipboard = parseWidgetClipboard({
			version: 1,
			sourceWorkspaceId: "ws_1",
			entries: [entry(textCore(), CHAT)],
		});
		if (clipboard === null) throw new Error("fixture clipboard is invalid");
		const resolved = resolveClipboardPaste(clipboard, "ws_2");
		expect(resolved.entries).toHaveLength(1);
		expect(resolved.entries[0]?.origin).toEqual(OWNER);
		expect(resolved.skippedResearch).toBe(0);
	});

	it("skips research widgets outside their own chat", () => {
		const clipboard = parseWidgetClipboard({
			version: 1,
			sourceWorkspaceId: "ws_1",
			entries: [entry(textCore(), CHAT), entry(researchCore(), CHAT)],
		});
		if (clipboard === null) throw new Error("fixture clipboard is invalid");
		const resolved = resolveClipboardPaste(clipboard, "ws_2");
		expect(resolved.entries.map((item) => item.core.type)).toEqual(["text"]);
		expect(resolved.skippedResearch).toBe(1);
		// Within the same chat the research widget pastes with its origin.
		const same = resolveClipboardPaste(clipboard, "ws_1");
		expect(same.entries.map((item) => item.core.type)).toEqual(["text", "research"]);
		expect(same.entries[1]?.origin).toEqual(CHAT);
		expect(same.skippedResearch).toBe(0);
	});

	it("moves widgets between Home and a chat (ADR-0024), never a research result to Home", () => {
		const fromChat = parseWidgetClipboard({
			version: 1,
			sourceWorkspaceId: "ws_1",
			entries: [entry(textCore(), CHAT), entry(researchCore(), CHAT)],
		});
		if (fromChat === null) throw new Error("fixture clipboard is invalid");
		const onHome = resolveClipboardPaste(fromChat, HOME_CLIPBOARD_SCOPE);
		expect(onHome.entries.map((item) => item.core.type)).toEqual(["text"]);
		expect(onHome.entries[0]?.origin).toEqual(OWNER);
		expect(onHome.skippedResearch).toBe(1);

		const fromHome = parseWidgetClipboard({
			version: 1,
			sourceWorkspaceId: HOME_CLIPBOARD_SCOPE,
			entries: [entry(chartCore(), OWNER)],
		});
		if (fromHome === null) throw new Error("fixture clipboard is invalid");
		const inChat = resolveClipboardPaste(fromHome, "ws_1");
		expect(inChat.entries.map((item) => item.core.type)).toEqual(["chart"]);
		expect(inChat.entries[0]?.core.widgetId).not.toBe("nb-chart");
	});

	it("words the announcements and the skipped notice", () => {
		expect(clipboardCountText(1, "Copied", widgetClipboardMessages.en)).toBe("Copied 1 widget.");
		expect(clipboardCountText(2, "Cut", widgetClipboardMessages.en)).toBe("Cut 2 widgets.");
		expect(clipboardCountText(3, "Pasted", widgetClipboardMessages.en)).toBe("Pasted 3 widgets.");
		expect(skippedResearchNoticeText(1, widgetClipboardMessages.en)).toBe(
			"1 research result stays in its own chat and was not pasted.",
		);
		expect(skippedResearchNoticeText(2, widgetClipboardMessages.en)).toBe(
			"2 research results stay in their own chat and were not pasted.",
		);
	});
});

describe("widget clipboard store", () => {
	it("starts empty and fills through set", () => {
		const { storage } = memoryStorage();
		const store = createStore(storage);
		expect(store.content()).toBeNull();
		expect(store.isEmpty()).toBe(true);
		store.set("ws_1", [entry(textCore(), OWNER)]);
		expect(store.isEmpty()).toBe(false);
		expect(store.content()).toEqual({
			sourceWorkspaceId: "ws_1",
			entries: [entry(textCore(), OWNER)],
		});
	});

	it("persists through storage, so a paste after a reload works", () => {
		const { storage, map } = memoryStorage();
		const store = createStore(storage);
		store.set("ws_1", [entry(textCore(), CHAT)]);
		expect(map.get(WIDGET_CLIPBOARD_STORAGE_KEY)).toBe(
			storedJson("ws_1", [entry(textCore(), CHAT)]),
		);
		// A new store (a reloaded page) reads the persisted clipboard back.
		const reloaded = createStore(storage);
		expect(reloaded.content()).toEqual({
			sourceWorkspaceId: "ws_1",
			entries: [entry(textCore(), CHAT)],
		});
	});

	it("ignores stored garbage", () => {
		const { storage } = memoryStorage({ [WIDGET_CLIPBOARD_STORAGE_KEY]: "{oops" });
		expect(createStore(storage).content()).toBeNull();
	});

	it("re-reads through reload when another tab changes storage", () => {
		const { storage, map } = memoryStorage();
		const store = createStore(storage);
		expect(store.content()).toBeNull();
		map.set(WIDGET_CLIPBOARD_STORAGE_KEY, storedJson("ws_9", [entry(textCore(), OWNER)]));
		store.reload();
		expect(store.content()?.sourceWorkspaceId).toBe("ws_9");
	});

	it("keeps the in-memory copy when storage throws", () => {
		const throwing: WidgetClipboardStorage = {
			getItem: () => {
				throw new Error("storage blocked (fixture)");
			},
			setItem: () => {
				throw new Error("storage full (fixture)");
			},
			removeItem: () => {
				throw new Error("storage blocked (fixture)");
			},
		};
		const store = createStore(throwing);
		expect(store.content()).toBeNull();
		expect(() => store.set("ws_1", [entry(textCore(), OWNER)])).not.toThrow();
		expect(store.content()?.entries).toHaveLength(1);
	});

	it("works without any storage", () => {
		const store = createStore(null);
		store.set("ws_1", [entry(textCore(), OWNER)]);
		expect(store.content()?.entries).toHaveLength(1);
	});

	it("refreshes the singleton from the storage event", () => {
		const store = widgetClipboard();
		expect(store.content()).toBeNull();
		// Another tab writes directly, then the event arrives.
		window.localStorage.setItem(
			WIDGET_CLIPBOARD_STORAGE_KEY,
			storedJson("ws_7", [entry(textCore(), OWNER)]),
		);
		window.dispatchEvent(new StorageEvent("storage", { key: WIDGET_CLIPBOARD_STORAGE_KEY }));
		expect(store.content()?.sourceWorkspaceId).toBe("ws_7");
	});
});
