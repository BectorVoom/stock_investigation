import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WidgetBody } from "../src/widgets/WidgetBody.tsx";
import { createEquitiesServer, NINTENDO_ID, nintendoSynced } from "./equitiesHarness.ts";
import { ALWAYS_VISIBLE } from "./fakeBackend.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

beforeEach(() => resetGlobalFetchCalls());
afterEach(() => {
	cleanup();
	assertOnlyIconFetches();
});

describe("a value's revision history (ADR-0048 §5)", () => {
	it("marks exactly one row Current when the current filing reports the concept in both scopes", async () => {
		const server = createEquitiesServer({ companies: [nintendoSynced()] });
		render(() => (
			<WidgetBody
				widget={{
					widgetId: "w-fs",
					type: "financial-statement",
					companyId: NINTENDO_ID,
					statement: "income-statement",
					years: 5,
					title: "任天堂株式会社 (7974)",
					size: "large",
				}}
				view={null}
				api={server.api}
				visibility={ALWAYS_VISIBLE}
				market={null}
				editingDisabled={false}
				onSaveText={async () => true}
				onSaveMarketWidget={() => {}}
			/>
		));
		const button = await waitFor(() => {
			const found = document.querySelector(
				'tr[data-metric="revenue"] td[data-fiscal-year="2024"] button[data-value-button]',
			);
			if (!(found instanceof HTMLButtonElement)) throw new Error("no revised value yet");
			return found;
		});
		expect(button.querySelector('[data-mark="revised"]')).not.toBeNull();
		fireEvent.click(button);
		const dialog = await screen.findByRole("dialog", { name: "Revenue, FY2024" });
		// The value's filing is the J-Quants record of the correction (ADR-0059 §2), named as such.
		const filing = within(dialog).getByRole("link", {
			name: "Open the J-Quants record of the Corrected earnings summary disclosed 2024-06-10 (needs a J-Quants API key)",
		});
		expect(filing.textContent).toBe(
			"Corrected earnings summary disclosed 2024-06-10 (J-Quants record)",
		);
		expect(filing.getAttribute("href")).toBe(
			"https://api.jquants.com/v2/fins/summary?code=79740&date=2024-06-10",
		);
		const history = await within(dialog).findByRole("table");
		const rows = [...history.querySelectorAll("tbody tr")];
		// The amendment and the original, each in both scopes.
		expect(rows).toHaveLength(4);
		const current = rows.filter((row) => row.getAttribute("data-current") === "true");
		expect(current).toHaveLength(1);
		expect(current[0]?.textContent).toContain("Corrected earnings summary");
		expect(current[0]?.textContent).toContain("Consolidated");
		expect(current[0]?.textContent).toContain("1,671,865,000,000 JPY");
		// The badge never breaks inside its word (「現在」 wrapped in a narrow column).
		const badge = [...(current[0]?.querySelectorAll("span") ?? [])].find(
			(span) => span.textContent === "Current",
		);
		expect(badge?.className).toContain("whitespace-nowrap");
		// The separate row of the same filing and concept is not the current value.
		expect(rows[1]?.textContent).toContain("Separate (parent only)");
		expect(rows[1]?.getAttribute("data-current")).toBeNull();
	});
});
