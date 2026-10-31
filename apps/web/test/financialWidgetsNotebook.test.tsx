import {
	type NotebookWidget,
	notebookWidgetSchema,
	putNotebookRequestSchema,
} from "@research/contracts";
import { createBaselineUiRegistry } from "@research/ui-registry";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotebookPanel } from "../src/notebook/NotebookPanel.tsx";
import { notebookSessionMessages } from "../src/notebook/notebook.messages.ts";
import { createNotebookSession, type NotebookSession } from "../src/notebook/notebookSession.ts";
import {
	createWidgetClipboardStore,
	type WidgetClipboardStore,
} from "../src/widgets/widgetClipboard.ts";
import { APPLE_ID, createEquitiesServer, type EquitiesServer } from "./equitiesHarness.ts";
import { ALWAYS_VISIBLE } from "./fakeBackend.ts";
import { WORKSPACE_VIEW } from "./fixtures.ts";
import {
	createNotebookBackend,
	type NotebookServerState,
	WORKSPACE_ID,
} from "./notebook/notebookHarness.ts";
import { lastOpenMenu } from "./openMenu.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

/**
 * The two financial widgets in the Notebook (ADR-0024, ADR-0048 §8): placed
 * there, they read the equities API like on Home, save their statement or
 * metric through the Notebook session (one compare-and-set PUT), Undo
 * restores the earlier choice, and cut / copy / paste / duplicate carry
 * their company, statement or metric and years.
 */

const registry = createBaselineUiRegistry();
const NOTEBOOK_PUT = /^\/api\/v1\/workspaces\/([^/?]+)\/notebook$/;
const NOTEBOOK_UNDO = /^\/api\/v1\/workspaces\/([^/?]+)\/notebook\/undo$/;
const OWNER = { kind: "owner", messageId: null, runId: null, componentId: null } as const;
const STAMP = {
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: "2026-10-01T00:00:00Z",
	revision: 1,
	origin: OWNER,
} as const;

function statementWidget(): NotebookWidget {
	return notebookWidgetSchema.parse({
		widgetId: "nb-fs",
		type: "financial-statement",
		title: "Apple Inc. (AAPL)",
		size: "large",
		companyId: APPLE_ID,
		statement: "income-statement",
		years: 5,
		...STAMP,
	});
}

function historyWidget(): NotebookWidget {
	return notebookWidgetSchema.parse({
		widgetId: "nb-fh",
		type: "financial-history",
		title: "Apple Inc. (AAPL)",
		size: "medium",
		companyId: APPLE_ID,
		metric: "revenue",
		years: 5,
		...STAMP,
	});
}

let server: NotebookServerState;
let equities: EquitiesServer;
const rootDisposers: (() => void)[] = [];

/** A memory clipboard, so no test leaks through `localStorage`. */
function memoryClipboard(): WidgetClipboardStore {
	const map = new Map<string, string>();
	let store: WidgetClipboardStore | undefined;
	rootDisposers.push(
		createRoot((dispose) => {
			store = createWidgetClipboardStore({
				getItem: (key) => map.get(key) ?? null,
				setItem: (key, value) => {
					map.set(key, value);
				},
				removeItem: (key) => {
					map.delete(key);
				},
			});
			return dispose;
		}),
	);
	if (store === undefined) throw new Error("no clipboard");
	return store;
}

/** A Notebook panel on one fake backend serving the notebook and the equities API. */
function mountNotebook(clipboard?: WidgetClipboardStore): void {
	const created = createNotebookBackend([statementWidget(), historyWidget()]);
	server = created.server;
	equities = createEquitiesServer({ backend: created.backend });
	let session: NotebookSession | undefined;
	rootDisposers.push(
		createRoot((dispose) => {
			session = createNotebookSession(
				equities.api,
				WORKSPACE_ID,
				ALWAYS_VISIBLE,
				() => notebookSessionMessages.en,
			);
			return dispose;
		}),
	);
	const mounted = session;
	if (mounted === undefined) throw new Error("no session");
	render(() => (
		<NotebookPanel
			session={mounted}
			api={equities.api}
			registry={registry}
			view={WORKSPACE_VIEW}
			mode="notebook"
			clipboard={clipboard}
			onAskAssistant={() => {}}
		/>
	));
}

function articles(): HTMLElement[] {
	return [...document.querySelectorAll("article[data-widget-id]")].filter(
		(article): article is HTMLElement => article instanceof HTMLElement,
	);
}

function articleById(id: string): HTMLElement {
	const article = document.querySelector(`article[data-widget-id="${id}"]`);
	if (!(article instanceof HTMLElement)) throw new Error(`widget ${id} is missing`);
	return article;
}

async function chooseMenuItem(widgetId: string, itemName: string): Promise<void> {
	const button = articleById(widgetId).querySelector("button[data-widget-actions]");
	if (!(button instanceof HTMLElement)) throw new Error("no widget actions button");
	fireEvent.click(button);
	const item = await waitFor(() =>
		within(lastOpenMenu()).getByRole("menuitem", { name: itemName }),
	);
	fireEvent.click(item);
}

const puts = () => equities.backend.requestsTo("PUT", NOTEBOOK_PUT);

/** The widgets the last notebook PUT stored. */
function lastPutWidgets(): readonly NotebookWidget[] {
	const put = puts().at(-1);
	if (put === undefined) throw new Error("nothing was saved");
	return putNotebookRequestSchema.parse(put.body).notebook.widgets;
}

function shownStatement(): string | null {
	return (
		articleById("nb-fs").querySelector("table[data-statement]")?.getAttribute("data-statement") ??
		null
	);
}

async function bothShown(): Promise<void> {
	await waitFor(() => expect(articles()).toHaveLength(2), { timeout: 10_000 });
	await waitFor(() => expect(shownStatement()).toBe("income-statement"), { timeout: 10_000 });
	await waitFor(() =>
		expect(articleById("nb-fh").querySelectorAll("path[data-bar]")).toHaveLength(5),
	);
}

beforeEach(() => resetGlobalFetchCalls());
afterEach(() => {
	cleanup();
	while (rootDisposers.length > 0) rootDisposers.pop()?.();
	assertOnlyIconFetches();
});

describe("financial widgets in the Notebook (ADR-0024, ADR-0048 §8)", () => {
	it("shows both from the equities API and saves a statement switch through the session; Undo restores it", async () => {
		mountNotebook();
		await bothShown();
		expect(articleById("nb-fs").textContent).toContain("Apple Inc. (AAPL)");
		expect(
			equities.requests("GET", /\/equities\/companies\/eqc_apple\/statements\/income-statement/),
		).toHaveLength(1);

		const control = articleById("nb-fs").querySelector('[data-segmented="statement"]');
		if (!(control instanceof HTMLElement)) throw new Error("no statement switch");
		fireEvent.click(within(control).getByRole("button", { name: "Cash flow" }));
		await waitFor(() => expect(puts()).toHaveLength(1));
		expect(lastPutWidgets().find((widget) => widget.widgetId === "nb-fs")).toMatchObject({
			type: "financial-statement",
			statement: "cash-flow",
			companyId: APPLE_ID,
			years: 5,
		});
		await waitFor(() => expect(shownStatement()).toBe("cash-flow"));
		expect(server.widgets.find((widget) => widget.widgetId === "nb-fs")).toMatchObject({
			statement: "cash-flow",
		});

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false),
		);
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		await waitFor(() => expect(equities.backend.requestsTo("POST", NOTEBOOK_UNDO)).toHaveLength(1));
		await waitFor(() => expect(shownStatement()).toBe("income-statement"));
		const control2 = articleById("nb-fs").querySelector('[data-segmented="statement"]');
		if (!(control2 instanceof HTMLElement)) throw new Error("no statement switch");
		expect(
			within(control2).getByRole("button", { name: "Income" }).getAttribute("aria-pressed"),
		).toBe("true");
	});

	it("saves a metric switch through the session; Undo restores the earlier metric", async () => {
		mountNotebook();
		await bothShown();
		const picker = within(articleById("nb-fh")).getByLabelText("Metric");
		if (!(picker instanceof HTMLSelectElement)) throw new Error("no metric picker");
		picker.value = "net-cash-from-operating-activities";
		fireEvent.change(picker);
		await waitFor(() => expect(puts()).toHaveLength(1));
		expect(lastPutWidgets().find((widget) => widget.widgetId === "nb-fh")).toMatchObject({
			type: "financial-history",
			metric: "net-cash-from-operating-activities",
		});
		const label = () =>
			articleById("nb-fh").querySelector("svg[role='img']")?.getAttribute("aria-label") ?? "";
		await waitFor(() => expect(label()).toContain("Net cash from operating activities"));

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false),
		);
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		await waitFor(() => expect(label()).toContain("Revenue of Apple Inc."));
		const restored = within(articleById("nb-fh")).getByLabelText("Metric");
		if (!(restored instanceof HTMLSelectElement)) throw new Error("no metric picker");
		expect(restored.value).toBe("revenue");
	});

	it("duplicates each with its company, choice and years under a fresh id", async () => {
		mountNotebook();
		await bothShown();
		await chooseMenuItem("nb-fs", "Duplicate");
		await waitFor(() => expect(articles()).toHaveLength(3));
		await chooseMenuItem("nb-fh", "Duplicate");
		await waitFor(() => expect(articles()).toHaveLength(4));
		const stored = lastPutWidgets();
		expect(stored.map((widget) => widget.type)).toEqual([
			"financial-statement",
			"financial-statement",
			"financial-history",
			"financial-history",
		]);
		expect(new Set(stored.map((widget) => widget.widgetId)).size).toBe(4);
		expect(stored[1]).toMatchObject({
			type: "financial-statement",
			companyId: APPLE_ID,
			statement: "income-statement",
			years: 5,
			title: "Apple Inc. (AAPL)",
			size: "large",
		});
		expect(stored[3]).toMatchObject({
			type: "financial-history",
			companyId: APPLE_ID,
			metric: "revenue",
			years: 5,
			size: "medium",
		});
		// The copies read the same shared reads: no second request for the same statement.
		await waitFor(() =>
			expect(articles()[1]?.querySelector("table[data-statement]")).not.toBeNull(),
		);
		expect(equities.requests("GET", /\/statements\/income-statement/)).toHaveLength(1);
	});

	it("copies and pastes both after another widget, and a cut moves one", async () => {
		const clipboard = memoryClipboard();
		mountNotebook(clipboard);
		await bothShown();
		await chooseMenuItem("nb-fh", "Copy");
		expect(clipboard.content()?.entries.map((entry) => entry.core)).toEqual([
			{
				widgetId: "nb-fh",
				type: "financial-history",
				title: "Apple Inc. (AAPL)",
				size: "medium",
				companyId: APPLE_ID,
				metric: "revenue",
				years: 5,
			},
		]);
		await chooseMenuItem("nb-fs", "Paste after");
		await waitFor(() => expect(articles()).toHaveLength(3));
		const pasted = lastPutWidgets();
		expect(pasted.map((widget) => widget.type)).toEqual([
			"financial-statement",
			"financial-history",
			"financial-history",
		]);
		expect(pasted[1]?.widgetId).not.toBe("nb-fh");
		expect(pasted[1]).toMatchObject({ companyId: APPLE_ID, metric: "revenue", years: 5 });

		await chooseMenuItem("nb-fs", "Cut");
		await waitFor(() => expect(articles()).toHaveLength(2));
		expect(clipboard.content()?.entries.map((entry) => entry.core)).toEqual([
			{
				widgetId: "nb-fs",
				type: "financial-statement",
				title: "Apple Inc. (AAPL)",
				size: "large",
				companyId: APPLE_ID,
				statement: "income-statement",
				years: 5,
			},
		]);
		const last = articles().at(-1)?.getAttribute("data-widget-id");
		if (last === null || last === undefined) throw new Error("no last widget");
		await chooseMenuItem(last, "Paste after");
		await waitFor(() => expect(articles()).toHaveLength(3));
		const moved = lastPutWidgets().at(-1);
		expect(moved).toMatchObject({
			type: "financial-statement",
			companyId: APPLE_ID,
			statement: "income-statement",
			years: 5,
		});
		await waitFor(() =>
			expect(articles().at(-1)?.querySelector("table[data-statement]")).not.toBeNull(),
		);
	});
});
