import { type HomeWidget, putHomeDashboardRequestSchema } from "@research/contracts";
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
import { createFakeBackend, type FakeBackend } from "./fakeBackend.ts";
import { lastOpenMenu } from "./openMenu.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

let backend: FakeBackend;
let home: HomeServerState;
let equities: EquitiesServer;

function freshBackend(tracked = true): void {
	backend = createFakeBackend();
	home = initialHomeServerState(false);
	installHomeRoutes(backend, initialServerState(), home);
	equities = createEquitiesServer({ backend, ...(tracked ? {} : { companies: [] }) });
	window.location.hash = "#/home";
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
	it("places a Financial statement for the chosen company, statement and years, with no Edit…", async () => {
		freshBackend();
		mountApp(backend);
		const dialog = await openDialog("Financial statement");
		const company = await within(dialog).findByLabelText("Company");
		await waitFor(() => expect(document.activeElement).toBe(company));
		expect([...company.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
			"Apple Inc. (AAPL)",
			"任天堂株式会社 (7974)",
		]);
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
		await within(dialog).findByLabelText("Company");
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
		await within(dialog).findByLabelText("Company");
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

	it("with no tracked company, says so and links to the Equities page", async () => {
		freshBackend(false);
		mountApp(backend);
		const dialog = await openDialog("Financial statement");
		expect(await within(dialog).findByText("No companies are tracked yet.")).toBeTruthy();
		expect(
			within(dialog)
				.getByRole("link", { name: "Track one on the Equities page" })
				.getAttribute("href"),
		).toBe("#/equities");
		expect(
			within(dialog).getByRole("button", { name: "Add widget" }).hasAttribute("disabled"),
		).toBe(true);
		fireEvent.keyDown(dialog, { key: "Escape" });
		fireEvent(dialog, new Event("cancel"));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
