import { type RunRecords, runRecordsResponseSchema } from "@research/contracts";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { RecordsDrawer } from "../src/chat/RecordsDrawer.tsx";
import { createFakeBackend, errorResponse, jsonResponse } from "./fakeBackend.ts";

afterEach(cleanup);

function evidence(evidenceId: string, title: string) {
	return {
		evidenceId,
		sourceUrl: `https://example.com/${evidenceId}`,
		title,
		publisher: "Example Publisher",
		publishedAt: "2026-09-01T00:00:00Z",
		retrievedAt: "2026-10-01T00:00:00Z",
		effectiveAt: null,
		excerpt: null,
		checksum: "a".repeat(64),
		sourceClass: "news",
	};
}

const PERIOD = {
	fiscalYear: 2025,
	fiscalPeriod: "FY",
	periodStart: "2025-04-01",
	periodEnd: "2026-03-31",
};

const RECORDS: RunRecords = runRecordsResponseSchema.parse({
	evidence: [
		evidence("ev_support", "Tender volumes report"),
		evidence("ev_contra", "Analyst note doubting demand"),
		evidence("ev_filing", "Form 13F-HR Q2 2026"),
		evidence("ev_jpx", "JPX margin statistics"),
		evidence("ev_finra", "FINRA short interest file"),
	],
	claims: [
		{
			claimId: "claim_s",
			text: "Tender volumes rose 30%.",
			claimType: "observation",
			status: "supported",
			links: [{ evidenceId: "ev_support", relation: "supports", quote: "rose 30%" }],
			issues: [],
		},
		{
			claimId: "claim_c",
			text: "Demand growth will continue.",
			claimType: "inference",
			status: "conflicting",
			links: [
				{ evidenceId: "ev_support", relation: "supports", quote: null },
				{ evidenceId: "ev_contra", relation: "contradicts", quote: null },
			],
			issues: [],
		},
		{
			claimId: "claim_u",
			text: "The market will reach 900 GWh.",
			claimType: "forecast",
			status: "unsupported",
			links: [],
			issues: [
				{ code: "NO_SUPPORTING_EVIDENCE" },
				{ code: "NUMBER_NOT_IN_EVIDENCE", numberText: "900" },
				{ code: "NOT_INDEPENDENTLY_VERIFIED" },
				{ code: "QUOTE_TOO_SHORT", evidenceId: "ev_support" },
			],
		},
	],
	scenarios: [
		{
			scenarioId: "sc_1",
			productOrService: "Grid-scale batteries",
			quantityKind: "unit-demand",
			unit: "GWh",
			baseYear: 2025,
			targetYear: 2030,
			baselineValue: 100,
			bear: { targetValue: 150, assumptions: ["subsidies end"] },
			base: { targetValue: 250, assumptions: ["tenders continue"] },
			bull: { targetValue: 400, assumptions: [] },
			drivers: ["renewables build-out"],
			barriers: ["grid connection queues"],
			falsifiers: ["tender cancellations"],
			methodology: "Baseline from stored statistics; targets from stated assumptions.",
			// (150/100)^(1/5) - 1 = 0.08447 and (250/100)^(1/5) - 1 = 0.20112, computed by hand.
			derivedCagr: { bear: 0.08447, base: 0.20112, bull: null },
			baselineEvidenceId: "ev_support",
			baselineQuote: "installed demand reached 100 GWh in 2025",
			supportingEvidenceIds: ["ev_support"],
			contraryEvidenceIds: ["ev_contra"],
		},
	],
	securities: [
		{
			securityId: "sec_jp",
			country: "JP",
			ticker: "6501",
			exchange: "TSE",
			issuerName: "Example Electric",
			issuerIdentifier: null,
			listingCurrency: "JPY",
			reportingCurrency: "JPY",
			listingVerification: "source-verified",
			formerTickers: [],
		},
		{
			securityId: "sec_us",
			country: "US",
			ticker: "EXB",
			exchange: "NASDAQ",
			issuerName: "Example Batteries Inc",
			issuerIdentifier: null,
			listingCurrency: "USD",
			reportingCurrency: "USD",
			listingVerification: "unverified",
			formerTickers: [],
		},
	],
	supplierLinks: [
		{
			supplierLinkId: "sl_1",
			scenarioId: "sc_1",
			securityId: "sec_jp",
			productsOrServices: ["Inverters"],
			businessExposure: "A fifth of segment revenue.",
			evidenceIds: ["ev_support"],
			relationshipQuote: null,
		},
	],
	financialObservations: [
		{
			observationId: "fo_1",
			securityId: "sec_jp",
			metricCode: "trailing-per",
			value: 18.5,
			unavailableReason: null,
			unit: "ratio",
			currency: null,
			accountingStandard: "IFRS",
			period: PERIOD,
			actualOrEstimate: "actual",
			marketDataAsOf: "2026-09-30T06:00:00Z",
			formula: "share price / trailing diluted EPS",
			sourceEvidenceId: "ev_support",
		},
		{
			observationId: "fo_2",
			securityId: "sec_us",
			metricCode: "trailing-per",
			value: null,
			unavailableReason: "EPS is not positive",
			unit: "ratio",
			currency: null,
			accountingStandard: "US-GAAP",
			period: PERIOD,
			actualOrEstimate: "actual",
			marketDataAsOf: null,
			formula: "share price / trailing diluted EPS",
			sourceEvidenceId: null,
		},
		{
			observationId: "fo_3",
			securityId: "sec_us",
			metricCode: "revenue",
			value: 0,
			unavailableReason: null,
			unit: "currency",
			currency: "USD",
			accountingStandard: "US-GAAP",
			period: PERIOD,
			actualOrEstimate: "actual",
			marketDataAsOf: null,
			formula: null,
			sourceEvidenceId: "ev_filing",
		},
	],
	positionObservations: [
		{
			observationId: "po_jp",
			securityId: "sec_jp",
			jurisdiction: "JP",
			metric: "jp-margin-balance",
			figures: {
				jurisdiction: "JP",
				metric: "jp-margin-balance",
				marginBuyBalanceShares: 1200000,
				marginSellBalanceShares: 300000,
			},
			unavailableReason: null,
			metricDefinition: "Exchange-reported margin trading balances.",
			unit: "shares",
			asOfDate: "2026-09-26",
			disseminatedAt: "2026-09-30T07:00:00Z",
			sourceEvidenceId: "ev_jpx",
		},
		{
			observationId: "po_us",
			securityId: "sec_us",
			jurisdiction: "US",
			metric: "us-short-interest",
			figures: {
				jurisdiction: "US",
				metric: "us-short-interest",
				reportedShortInterestShares: 4500000,
				averageDailyVolumeShares: null,
			},
			unavailableReason: null,
			metricDefinition: "Short interest reported for the settlement date.",
			unit: "shares",
			asOfDate: "2026-09-15",
			disseminatedAt: null,
			sourceEvidenceId: "ev_finra",
		},
	],
	investorFilings: [
		{
			filingId: "if_1",
			investorName: "Example Capital",
			reportingEntityIdentifier: { scheme: "CIK", value: "0001234567" },
			form: "13F-HR",
			reportPeriodEnd: "2026-06-30",
			filedAt: "2026-08-14",
			filingUrl: "https://www.sec.gov/Archives/edgar/data/1234567/filing.htm",
			holdings: [
				{
					issuerName: "Example Batteries Inc",
					cusip: null,
					securityId: "sec_us",
					reportedShares: 250000,
					reportedValueUsd: null,
					changeFromPriorFiling: "newly-reported-holding",
				},
			],
			sourceEvidenceId: "ev_filing",
		},
	],
	pricingPower: [],
});

function mount(
	response: () => Response = () => jsonResponse(RECORDS),
	opener: HTMLElement | null = null,
) {
	const backend = createFakeBackend();
	backend.on("GET", /research-runs\/run_1\/records$/, response);
	const onClose = vi.fn();
	const view = render(() => (
		<RecordsDrawer
			api={createApiClient({ fetch: backend.fetch })}
			runId="run_1"
			startedAt="2026-10-04T00:00:00Z"
			opener={opener}
			onClose={onClose}
		/>
	));
	return { backend, onClose, view };
}

describe("Evidence & records drawer", () => {
	it("groups claims by status and shows supporting and contradicting evidence separately", async () => {
		mount();
		const supported = await screen.findByRole("region", { name: "Supported claims" });
		// Drawer sections are h4 under the drawer's h3 title (guideline section 7).
		expect(within(supported).getByRole("heading", { level: 4 }).textContent).toBe(
			"Supported claims (1)",
		);
		expect(supported.textContent).toContain("Tender volumes rose 30%.");

		const conflicting = screen.getByRole("region", { name: "Conflicting claims" });
		const supporting = within(conflicting).getByRole("list", { name: "Supporting evidence" });
		const contradicting = within(conflicting).getByRole("list", { name: "Contradicting evidence" });
		expect(supporting.textContent).toContain("Tender volumes report");
		expect(supporting.textContent).not.toContain("Analyst note doubting demand");
		expect(contradicting.textContent).toContain("Analyst note doubting demand");
		expect(within(contradicting).getByRole("link").getAttribute("href")).toBe(
			"https://example.com/ev_contra",
		);

		const unsupported = screen.getByRole("region", { name: "Unsupported claims" });
		expect(unsupported.textContent).toContain("The market will reach 900 GWh.");
		const issues = [
			...within(unsupported)
				.getByRole("list", { name: "Verification issues" })
				.querySelectorAll("li"),
		].map((item) => item.textContent ?? "");
		expect(issues).toEqual([
			"no supporting evidence",
			"the number 900 does not appear in the cited evidence",
			"not independently verified — the quotes matched, but no independent check confirmed the claim",
			"quoted passage from evidence ev_support is too short to verify",
		]);
		// Every issue has wording: none falls back to its raw machine code.
		for (const issue of issues) expect(issue).not.toMatch(/^[A-Z_]+$/);
		expect(unsupported.querySelector("[data-claim-status]")?.textContent).toContain("Unsupported");
	});

	it("shows bear/base/bull scenarios with years, unit and CAGR or 'not derivable'", async () => {
		mount();
		const scenarios = await screen.findByRole("region", { name: "Demand scenarios" });
		expect(scenarios.textContent).toContain("unit-demand in GWh; base year 2025, target year 2030");
		expect(scenarios.querySelector('[data-field="baseline"]')?.textContent).toBe("100 GWh");
		const cagr = (caseName: string) =>
			scenarios.querySelector(`tr[data-case="${caseName}"] [data-field="cagr"]`)?.textContent;
		expect(cagr("bear")).toBe("8.4% per year");
		expect(cagr("base")).toBe("20.1% per year");
		expect(cagr("bull")).toBe("not derivable");
		expect(
			within(scenarios).getByRole("list", { name: "Contrary evidence" }).textContent,
		).toContain("Analyst note doubting demand");
		expect(scenarios.textContent).toContain("tender cancellations");
		expect(scenarios.querySelector('[data-field="cited-passage"] q')?.textContent).toBe(
			"installed demand reached 100 GWh in 2025",
		);
	});

	it("lists supplier links with ticker and exchange", async () => {
		mount();
		const suppliers = await screen.findByRole("region", { name: "Supplier links" });
		expect(suppliers.querySelector('[data-security-id="sec_jp"]')?.textContent).toBe(
			"Example Electric — 6501 · TSE (JP)",
		);
		expect(suppliers.textContent).toContain("Supplies: Inverters");
		expect(suppliers.querySelector("[data-listing-verification]")?.textContent).toBe(
			"listing verified against an official directory",
		);
		// No passage was retained for this link: said explicitly, not left blank.
		expect(suppliers.querySelector('[data-field="cited-passage"]')?.textContent).toBe(
			"Cited passage naming the issuer: N/A — no passage retained",
		);
		expect(
			within(suppliers).getByRole("list", { name: "Evidence for the supplier relationship" })
				.textContent,
		).toContain("Tender volumes report");
	});

	it("shows financial observations with value or reason, period, as-of and formula", async () => {
		mount();
		const section = await screen.findByRole("region", { name: "Financial observations" });
		const value = (id: string) =>
			section.querySelector(`tr[data-observation-id="${id}"] [data-field="value"]`)?.textContent;
		expect(value("fo_1")).toBe("18.5");
		expect(value("fo_2")).toBe("N/A — EPS is not positive");
		// A sourced zero is a value, not "unavailable".
		expect(value("fo_3")).toBe("0 USD");
		const row = section.querySelector('tr[data-observation-id="fo_1"]');
		expect(row?.textContent).toContain("FY2025 FY (2025-04-01 to 2026-03-31); actual; IFRS");
		expect(row?.textContent).toContain("2026-09-30");
		expect(row?.textContent).toContain("share price / trailing diluted EPS");
		expect(row?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/ev_support");
	});

	it("keeps Japan margin balances and US short interest in separate labelled sections", async () => {
		mount();
		const japan = await screen.findByRole("region", {
			name: "Japan margin trading balances (信用取引残高)",
		});
		const us = screen.getByRole("region", { name: "US short interest" });

		expect(japan.querySelector('[data-field="jp-margin-buy"]')?.textContent).toBe(
			"1,200,000 shares",
		);
		expect(japan.querySelector('[data-field="jp-margin-sell"]')?.textContent).toBe(
			"300,000 shares",
		);
		expect(japan.textContent).toContain("Not comparable to US short interest.");
		expect(japan.textContent).not.toContain("Example Batteries Inc");

		expect(us.querySelector('[data-field="us-short-interest"]')?.textContent).toBe(
			"4,500,000 shares",
		);
		expect(us.textContent).toContain("no security-level US margin-buy balance exists");
		expect(us.textContent).toContain("N/A — not reported");
		// No US margin-buy figure is ever presented.
		expect(us.querySelector('[data-field="jp-margin-buy"]')).toBeNull();
		expect(us.textContent).not.toMatch(/margin buy balance/i);
		expect(us.textContent).toContain("As of 2026-09-15; disseminated date not stated");
		// A model-proposed listing is flagged as such wherever the security is named.
		expect(us.querySelector("[data-listing-verification]")?.textContent).toBe(
			"listing unverified — proposed by the model, format-checked only",
		);
	});

	it("words investor filings as reported holdings as of quarter end, never as purchases", async () => {
		mount();
		const filings = await screen.findByRole("region", {
			name: "Investor filings — reported holdings",
		});
		expect(filings.textContent).toContain(
			"Example Capital — reported holdings as of quarter end 2026-06-30 (13F-HR filed 2026-08-14).",
		);
		expect(within(filings).getByRole("link", { name: "View filing" }).getAttribute("href")).toBe(
			"https://www.sec.gov/Archives/edgar/data/1234567/filing.htm",
		);
		expect(filings.querySelector('[data-field="reported-change"]')?.textContent).toBe(
			"newly reported holding",
		);
		expect(filings.textContent).not.toMatch(/\b(bought|purchased|buys|acquired)\b/i);
		expect(filings.textContent).toContain("these are not dated transactions");
	});

	it("states empty sections explicitly and closes on request", async () => {
		const { onClose } = mount();
		const pricing = await screen.findByRole("region", { name: "Pricing power assessments" });
		expect(pricing.textContent).toContain("No pricing power assessments in this run.");
		fireEvent.click(screen.getByRole("button", { name: "Close records" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("shows the API error code when records cannot be loaded", async () => {
		mount(() => errorResponse(404, "NOT_FOUND", "run not found"));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("NOT_FOUND");
		expect(alert.textContent).toContain("run not found");
	});
});

describe("records drawer dialog behaviour", () => {
	it("is a labelled modal dialog over a backdrop", async () => {
		mount();
		const dialog = await screen.findByRole("dialog", { name: "Evidence & records" });
		expect(dialog.tagName).toBe("ASIDE");
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(document.querySelector("[data-drawer-backdrop]")).not.toBeNull();
	});

	it("moves focus into the drawer on open and back to the explicit opener on close", async () => {
		render(() => <button type="button">Opener</button>);
		const opener = screen.getByRole("button", { name: "Opener" });
		if (!(opener instanceof HTMLElement)) throw new Error("expected an opener element");
		opener.focus();
		const drawer = mount(undefined, opener);
		const close = await screen.findByRole("button", { name: "Close records" });
		expect(document.activeElement).toBe(close);
		drawer.view.unmount();
		expect(document.activeElement).toBe(opener);
	});

	it("returns focus to the opener even when it was never focused (Safari: clicks do not focus buttons)", async () => {
		render(() => <button type="button">Opener</button>);
		const opener = screen.getByRole("button", { name: "Opener" });
		if (!(opener instanceof HTMLElement)) throw new Error("expected an opener element");
		expect(document.activeElement).not.toBe(opener);
		const drawer = mount(undefined, opener);
		await screen.findByRole("button", { name: "Close records" });
		drawer.view.unmount();
		expect(document.activeElement).toBe(opener);
	});

	it("closes on Escape and on backdrop click", async () => {
		const first = mount();
		const dialog = await screen.findByRole("dialog", { name: "Evidence & records" });
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(first.onClose).toHaveBeenCalledTimes(1);
		cleanup();

		const second = mount();
		await screen.findByRole("button", { name: "Close records" });
		const backdrop = document.querySelector("[data-drawer-backdrop]");
		if (!(backdrop instanceof HTMLElement)) throw new Error("expected a backdrop element");
		fireEvent.click(backdrop);
		expect(second.onClose).toHaveBeenCalledTimes(1);
	});

	it("wraps Tab from the last control to the first, and Shift+Tab back", async () => {
		mount();
		await screen.findByRole("region", { name: "Supported claims" });
		const dialog = screen.getByRole("dialog", { name: "Evidence & records" });
		const controls = [...dialog.querySelectorAll("a[href], button:not([disabled])")].filter(
			(node): node is HTMLElement => node instanceof HTMLElement,
		);
		const first = controls[0];
		const last = controls[controls.length - 1];
		if (first === undefined || last === undefined || first === last) {
			throw new Error("expected several focusable controls in the drawer");
		}
		last.focus();
		fireEvent.keyDown(last, { key: "Tab", shiftKey: false });
		expect(document.activeElement).toBe(first);
		fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(last);
	});
});
