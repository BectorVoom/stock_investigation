import {
	type HomeWidget,
	parseStockId,
	putHomeDashboardRequestSchema,
	type StockProfileResponse,
} from "@research/contracts";
import { stockPriceSeriesId } from "@research/domain";
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type HomeServerState,
	initialHomeServerState,
	initialServerState,
	installHomeRoutes,
	mountApp,
} from "./appHarness.tsx";
import { createEquitiesServer, type EquitiesServer } from "./equitiesHarness.ts";
import {
	createFakeBackend,
	deferred,
	errorResponse,
	type FakeBackend,
	jsonResponse,
} from "./fakeBackend.ts";
import { lastOpenMenu } from "./openMenu.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";
import {
	type DirectoryServer,
	freshDirectory,
	installDirectoryRoutes,
} from "./watchlistHarness.ts";

let backend: FakeBackend;
let home: HomeServerState;
let equities: EquitiesServer;
let directory: DirectoryServer;

/**
 * Home over the fake API with the stock lists (Apple, Microsoft, Toyota…
 * and Nintendo) and each stock's profile, whose company is the equities
 * server's company of that listing (tracked companies: Apple and Nintendo,
 * or none).
 */
function freshBackend(tracked = true): void {
	backend = createFakeBackend();
	home = initialHomeServerState(false);
	installHomeRoutes(backend, initialServerState(), home);
	equities = createEquitiesServer({ backend, ...(tracked ? {} : { companies: [] }) });
	directory = freshDirectory();
	directory.rows.push({
		market: "JP",
		symbol: "7974",
		name: "NINTENDO CO.,LTD.",
		localName: "任天堂",
		listing: "tse-prime",
	});
	installDirectoryRoutes(
		backend,
		() => directory,
		() => [],
	);
	backend.on("GET", /^\/api\/v1\/stocks\/([^/?]+)$/, (_request, match) =>
		profileResponse(decodeURIComponent(match[1] ?? "")),
	);
	window.location.hash = "#/home";
}

/** The stock's profile as the API answers it now (the stored list and companies at request time). */
function profileResponse(stockId: string): Response {
	const parsed = parseStockId(stockId);
	if (parsed === null) return errorResponse(400, "VALIDATION_FAILED", "bad id");
	const row = directory.rows.find(
		(entry) => entry.market === parsed.market && entry.symbol === parsed.symbol,
	);
	const body: StockProfileResponse = {
		stockId,
		market: parsed.market,
		symbol: parsed.symbol,
		priceSeriesId: stockPriceSeriesId(parsed.market, parsed.symbol),
		directory:
			row === undefined ? null : { name: row.name, localName: row.localName, listing: row.listing },
		business: parsed.market === "JP" ? { status: "not-provided" } : { status: "pending" },
		companyProfile: null,
		summary: null,
		company:
			equities.companies.find(
				(company) => company.market === parsed.market && company.symbol === parsed.symbol,
			) ?? null,
	};
	return jsonResponse(body, { headers: { ETag: `"profile-${stockId}"` } });
}

const profileReads = () => backend.requestsTo("GET", /^\/api\/v1\/stocks\/[^/?]+$/);

/** Types `text` into the dialog's stock search and answers the hit of `stockId`. */
async function searchFor(dialog: HTMLElement, text: string, stockId: string): Promise<HTMLElement> {
	const box = within(dialog).getByRole("combobox", { name: "Search stocks" });
	fireEvent.input(box, { target: { value: text } });
	const list = await within(dialog).findByRole("listbox", { name: "Matching stocks" });
	return waitFor(() => {
		const found = list.querySelector(`[role="option"][data-stock-id="${stockId}"]`);
		if (!(found instanceof HTMLElement)) throw new Error(`no hit ${stockId} yet`);
		return found;
	});
}

async function pickStock(dialog: HTMLElement, text: string, stockId: string): Promise<void> {
	fireEvent.click(await searchFor(dialog, text, stockId));
}

/** The picked stock's line once its company is read. */
async function pickedCompany(dialog: HTMLElement): Promise<string> {
	return waitFor(() => {
		const line = dialog.querySelector('[data-field="financial-picked"]');
		const text = line?.textContent ?? "";
		if (!text.startsWith("Company:")) throw new Error(`not resolved yet: ${text}`);
		return text;
	});
}

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:00:00Z"));
	resetGlobalFetchCalls();
});

afterEach(() => {
	cleanup();
	window.location.hash = "";
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

const homePuts = () => backend.requestsTo("PUT", /\/home\/dashboard$/);

function lastSavedWidgets(): readonly HomeWidget[] {
	const put = homePuts().at(-1);
	if (put === undefined) throw new Error("nothing was saved");
	return putHomeDashboardRequestSchema.parse(put.body).dashboard.widgets;
}

function frames(): HTMLElement[] {
	return [...document.querySelectorAll("article[data-widget-id]")].filter(
		(article): article is HTMLElement => article instanceof HTMLElement,
	);
}

async function openDialog(type: "Financial statement" | "Financial history"): Promise<HTMLElement> {
	await waitFor(() => expect(frames()).toHaveLength(7), { timeout: 10_000 });
	fireEvent.click(screen.getByRole("button", { name: "Add widget" }));
	fireEvent.click(within(lastOpenMenu()).getByRole("menuitem", { name: type }));
	return screen.findByRole("dialog", {
		name:
			type === "Financial statement"
				? "Add a financial statement"
				: "Add a financial history chart",
	});
}

function select(dialog: HTMLElement, label: string, value: string): void {
	const element = within(dialog).getByLabelText(label);
	if (!(element instanceof HTMLSelectElement)) throw new Error(`${label} is not a select`);
	element.value = value;
	fireEvent.change(element);
}

describe("adding a financial widget (ADR-0048 §8)", () => {
	it("places a Financial statement for the picked stock's company, statement and years, with no Edit…", async () => {
		freshBackend();
		mountApp(backend);
		const dialog = await openDialog("Financial statement");
		// Focus lands in the stock search; nothing is listed or read until the owner types.
		const box = within(dialog).getByRole("combobox", { name: "Search stocks" });
		await waitFor(() => expect(document.activeElement).toBe(box));
		expect(equities.requests("GET", /\/equities\/companies$/)).toHaveLength(0);
		const add = within(dialog).getByRole("button", { name: "Add widget" });
		expect(add.hasAttribute("disabled")).toBe(true);
		await pickStock(dialog, "apple", "us:AAPL");
		expect(await pickedCompany(dialog)).toBe("Company: Apple Inc. (AAPL)");
		expect(profileReads()).toHaveLength(1);
		// The box is cleared for another search.
		expect(box).toHaveProperty("value", "");
		select(dialog, "Statement", "balance-sheet");
		select(dialog, "Fiscal years", "10");
		fireEvent.click(within(dialog).getByRole("button", { name: "Add widget" }));
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		expect(lastSavedWidgets().at(-1)).toMatchObject({
			type: "financial-statement",
			companyId: "eqc_apple",
			statement: "balance-sheet",
			years: 10,
			title: "Apple Inc. (AAPL)",
			size: "large",
		});
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add widget" }));
		await waitFor(() => expect(frames()).toHaveLength(8));
		const frame = frames().at(-1);
		if (frame === undefined) throw new Error("expected the new widget");
		await waitFor(() =>
			expect(frame.querySelector("table[data-statement]")?.getAttribute("data-statement")).toBe(
				"balance-sheet",
			),
		);
		const actions = frame.querySelector("button[data-widget-actions]");
		if (!(actions instanceof HTMLElement)) throw new Error("no widget actions button");
		fireEvent.click(actions);
		const names = within(lastOpenMenu())
			.getAllByRole("menuitem")
			.map((item) => item.textContent?.trim());
		expect(names).not.toContain("Edit…");
		// A statement table needs a medium frame at least: no Small size.
		expect(names).not.toContain("Size: Small");
		expect(
			equities.requests("GET", /\/statements\/balance-sheet\?years=10$/).length,
		).toBeGreaterThan(0);
	});

	it("saves the statement switched in the widget through Home's save", async () => {
		freshBackend();
		mountApp(backend);
		const dialog = await openDialog("Financial statement");
		await pickStock(dialog, "AAPL", "us:AAPL");
		await pickedCompany(dialog);
		fireEvent.click(within(dialog).getByRole("button", { name: "Add widget" }));
		await waitFor(() => expect(frames()).toHaveLength(8));
		const frame = frames().at(-1);
		if (frame === undefined) throw new Error("expected the new widget");
		const control = await waitFor(() => {
			const element = frame.querySelector('[data-segmented="statement"]');
			if (!(element instanceof HTMLElement)) throw new Error("no switch yet");
			return element;
		});
		fireEvent.click(within(control).getByRole("button", { name: "Cash flow" }));
		await waitFor(() => expect(homePuts()).toHaveLength(2));
		expect(lastSavedWidgets().at(-1)).toMatchObject({
			type: "financial-statement",
			statement: "cash-flow",
		});
	});

	it("places a Financial history for the chosen metric", async () => {
		freshBackend();
		mountApp(backend);
		const dialog = await openDialog("Financial history");
		await pickStock(dialog, "任天堂", "jp:7974");
		expect(await pickedCompany(dialog)).toBe("Company: 任天堂株式会社 (7974)");
		// Another pick replaces the first.
		await pickStock(dialog, "apple", "us:AAPL");
		await waitFor(() =>
			expect(dialog.querySelector('[data-field="financial-picked"]')?.textContent).toBe(
				"Company: Apple Inc. (AAPL)",
			),
		);
		select(dialog, "Metric", "net-cash-from-operating-activities");
		fireEvent.click(within(dialog).getByRole("button", { name: "Add widget" }));
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		expect(lastSavedWidgets().at(-1)).toMatchObject({
			type: "financial-history",
			companyId: "eqc_apple",
			metric: "net-cash-from-operating-activities",
			years: 10,
			size: "medium",
		});
	});

	it("says why a listed stock with no stored company yet cannot be added, and offers no Watchlist step", async () => {
		freshBackend(false);
		mountApp(backend);
		const dialog = await openDialog("Financial statement");
		await pickStock(dialog, "microsoft", "us:MSFT");
		const none = await waitFor(() => {
			const found = dialog.querySelector('[data-field="financial-picked-none"]');
			if (!(found instanceof HTMLElement)) throw new Error("no answer yet");
			return found;
		});
		expect(none.textContent).toBe(
			"The server has not started on this stock's statements yet; it fetches those of every listed stock. Pick it again later.",
		);
		expect(dialog.textContent).not.toContain("Watchlist");
		expect(within(dialog).queryByRole("link")).toBeNull();
		expect(
			within(dialog).getByRole("button", { name: "Add widget" }).hasAttribute("disabled"),
		).toBe(true);
		fireEvent.keyDown(dialog, { key: "Escape" });
		fireEvent(dialog, new Event("cancel"));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(homePuts()).toHaveLength(0);
	});

	it("says a stock outside the stored stock lists has no statements", async () => {
		freshBackend();
		mountApp(backend);
		const dialog = await openDialog("Financial statement");
		const hit = await searchFor(dialog, "microsoft", "us:MSFT");
		// MSFT leaves the stored list between the search and the pick: its profile has no listing.
		directory.rows = directory.rows.filter((row) => row.symbol !== "MSFT");
		fireEvent.click(hit);
		await waitFor(() =>
			expect(dialog.querySelector('[data-field="financial-picked-none"]')?.textContent).toBe(
				"No statements are stored for this stock: it is not in the stored stock lists.",
			),
		);
	});

	it("states a failed company read with Try again, which reads again and resolves", async () => {
		freshBackend();
		const held = deferred<void>();
		let failNext = true;
		backend.on("GET", /^\/api\/v1\/stocks\/us%3AAAPL$/, async () => {
			if (!failNext) return profileResponse("us:AAPL");
			failNext = false;
			await held.promise;
			return errorResponse(500, "INTERNAL", "The API failed.");
		});
		mountApp(backend);
		const dialog = await openDialog("Financial statement");
		await pickStock(dialog, "apple", "us:AAPL");
		await waitFor(() =>
			expect(dialog.querySelector('[data-field="financial-picked"]')?.textContent).toContain(
				"Loading",
			),
		);
		held.resolve();
		const alert = await within(dialog).findByRole("alert");
		expect(alert.textContent).toContain("Could not load the stock's stored company.");
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		expect(await pickedCompany(dialog)).toBe("Company: Apple Inc. (AAPL)");
		expect(profileReads()).toHaveLength(2);
	});
});
