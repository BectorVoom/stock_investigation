import type { Claim, Evidence } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerClaims } from "../src/chat/Citations.tsx";

afterEach(cleanup);

function evidence(evidenceId: string, overrides: Partial<Evidence> = {}): Evidence {
	return {
		evidenceId,
		sourceUrl: `https://example.com/reports/${evidenceId}`,
		title: `Report ${evidenceId}`,
		publisher: "Example Publisher",
		publishedAt: "2026-09-01T00:00:00Z",
		retrievedAt: "2026-10-01T00:00:00Z",
		effectiveAt: null,
		excerpt: `Excerpt for ${evidenceId}.`,
		checksum: "a".repeat(64),
		sourceClass: "news",
		...overrides,
	};
}

function claim(claimId: string, overrides: Partial<Claim> = {}): Claim {
	return {
		claimId,
		text: `Claim ${claimId}.`,
		claimType: "observation",
		status: "supported",
		links: [],
		issues: [],
		...overrides,
	};
}

function renderAnswer(options: {
	readonly claimIds?: readonly string[];
	readonly claims?: readonly Claim[];
	readonly evidence?: readonly Evidence[];
	readonly variant?: "news" | "investigation";
}) {
	const claims = new Map((options.claims ?? []).map((entry) => [entry.claimId, entry] as const));
	const sources = new Map(
		(options.evidence ?? []).map((entry) => [entry.evidenceId, entry] as const),
	);
	render(() => (
		<AnswerClaims
			variant={options.variant}
			claimIds={options.claimIds ?? [...claims.keys()]}
			claims={claims}
			evidence={sources}
		/>
	));
}

describe("citation chips and source cards", () => {
	it("omits forecast and hypothesis badges in news while keeping the statements and sources", () => {
		renderAnswer({
			variant: "news",
			claims: [
				claim("forecast", {
					claimType: "forecast",
					links: [{ evidenceId: "ev_a", relation: "supports", quote: "Source passage." }],
				}),
				claim("hypothesis", { claimType: "hypothesis" }),
			],
			evidence: [evidence("ev_a")],
		});
		expect(screen.getByText("Claim forecast.")).toBeTruthy();
		expect(screen.getByText("Claim hypothesis.")).toBeTruthy();
		expect(document.querySelector("[data-claim-type]")).toBeNull();
		expect(screen.getByRole("button", { name: "Source 1: Report ev_a" })).toBeTruthy();
	});

	it.each([
		"news",
		"investigation",
	] as const)("omits observation/inference labels in %s while retaining warnings and references", (variant) => {
		renderAnswer({
			variant,
			claims: [
				claim("observed", {
					status: "unsupported",
					links: [{ evidenceId: "ev_a", relation: "supports", quote: "Source passage." }],
				}),
				claim("inferred", {
					claimType: "inference",
					status: "conflicting",
					links: [
						{ evidenceId: "ev_b", relation: "supports", quote: "A conflicting source passage." },
					],
				}),
			],
			evidence: [evidence("ev_a"), evidence("ev_b")],
		});
		expect(document.querySelector("[data-claim-type]")).toBeNull();
		expect(screen.queryByText("Unsupported")).toBeNull();
		expect(screen.queryByText("Claim observed.")).toBeNull();
		expect(screen.getByText("Conflicting evidence")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Source 1: Report ev_b" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Report ev_a/ })).toBeNull();
	});

	it("presents News as prose and combines a source's date and fact quotations", async () => {
		renderAnswer({
			variant: "news",
			claims: [
				claim("lead", {
					text: "EIA reported a production change.",
					links: [
						{ evidenceId: "ev_a", relation: "supports", quote: "November 5, 2026" },
						{
							evidenceId: "ev_a",
							relation: "supports",
							quote: "Refineries changed their production mix.",
						},
					],
				}),
				claim("detail"),
			],
			evidence: [evidence("ev_a")],
		});
		expect(screen.queryByRole("heading", { name: "Claims in this answer" })).toBeNull();
		expect(screen.queryByText("Observation")).toBeNull();
		expect(screen.queryByRole("heading", { name: "Summary" })).toBeNull();
		const chip = screen.getByRole("button", { name: "Source 1: Report ev_a" });
		expect(screen.getAllByRole("button", { name: "Source 1: Report ev_a" })).toHaveLength(1);
		fireEvent.click(chip);
		await waitFor(() =>
			expect(document.querySelector("[data-citation-card]")?.textContent).toContain(
				"November 5, 2026",
			),
		);
		expect(document.querySelector("[data-citation-card]")?.textContent).toContain(
			"Refineries changed their production mix.",
		);
	});

	it("organises an investigation and keeps unverified claims out of its findings", () => {
		renderAnswer({
			variant: "investigation",
			claims: [
				claim("summary"),
				claim("finding"),
				claim("analysis", { claimType: "hypothesis" }),
				claim("outlook", { claimType: "forecast" }),
				claim("conclusion", { claimType: "inference" }),
				claim("uncertain", { status: "unsupported" }),
			],
		});
		for (const heading of ["Summary", "Findings", "Analysis and outlook", "Conclusion"]) {
			expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
		}
		expect(screen.getByText("Claim analysis.")).toBeTruthy();
		expect(screen.getByText("Claim outlook.")).toBeTruthy();
		expect(document.querySelector("[data-claim-type]")).toBeNull();
		const findings = screen.getByRole("list", { name: "Findings" });
		expect(findings.textContent).toContain("Claim finding.");
		expect(findings.textContent).not.toContain("Claim uncertain.");
		expect(screen.queryByText("Claim uncertain.")).toBeNull();
	});

	it("shows an honest empty report when no statements pass verification", () => {
		renderAnswer({ variant: "news", claims: [claim("unsupported", { status: "unsupported" })] });
		expect(screen.getByText("No verified findings are available for this report.")).toBeTruthy();
		expect(screen.queryByText("Claim unsupported.")).toBeNull();
	});

	it("shares one number for shared evidence and lists every source once", async () => {
		renderAnswer({
			claims: [
				claim("claim_1", {
					links: [
						{ evidenceId: "ev_a", relation: "supports", quote: null },
						{ evidenceId: "ev_b", relation: "supports", quote: null },
					],
				}),
				claim("claim_2", {
					links: [{ evidenceId: "ev_a", relation: "supports", quote: null }],
				}),
			],
			evidence: [evidence("ev_a", { title: "Alpha" }), evidence("ev_b", { title: "Beta" })],
		});
		const claims = await screen.findByRole("list", { name: "Claims" });
		const chips = within(claims).getAllByRole("button");
		expect(chips.map((chip) => chip.textContent)).toEqual(["1", "2", "1"]);
		expect(chips[0]?.getAttribute("aria-label")).toBe("Source 1: Alpha");
		expect(chips[2]?.getAttribute("aria-label")).toBe("Source 1: Alpha");
		const sources = await screen.findByRole("list", { name: "Sources" });
		expect(within(sources).getAllByRole("listitem")).toHaveLength(2);
		expect(sources.textContent).toContain("Alpha");
		expect(sources.textContent).toContain("example.com");
	});

	it("opens the card on focus with title, publisher, dates, excerpt and an Open source link", async () => {
		renderAnswer({
			claims: [
				claim("claim_1", {
					links: [{ evidenceId: "ev_a", relation: "supports", quote: "Orders rose." }],
				}),
			],
			evidence: [
				evidence("ev_a", {
					title: "Alpha",
					excerpt: "Stored excerpt.",
					effectiveAt: "2026-06-30T00:00:00Z",
				}),
			],
		});
		const chip = await screen.findByRole("button", { name: "Source 1: Alpha" });
		expect(screen.queryByText("Orders rose.")).toBeNull();
		fireEvent.focus(chip);
		const quote = await screen.findByText("Orders rose.");
		const card = quote.closest("[data-citation-card]");
		expect(card).not.toBeNull();
		const inCard = within(card as HTMLElement);
		expect(inCard.getByText("Alpha")).toBeDefined();
		expect(inCard.getByText("Example Publisher")).toBeDefined();
		// Published, retrieved and data-as-of dates are each labelled (DATA-002).
		const cardText = card?.textContent ?? "";
		expect(cardText).toContain("published");
		expect(cardText).toContain("2026-09-01");
		expect(cardText).toContain("retrieved");
		expect(cardText).toContain("2026-10-01");
		expect(cardText).toContain("data as of");
		expect(cardText).toContain("2026-06-30");
		const open = inCard.getByRole("link", { name: "Open source" });
		expect(open.getAttribute("href")).toBe("https://example.com/reports/ev_a");
		expect(open.getAttribute("target")).toBe("_blank");
		// Plain support needs no extra word.
		expect(inCard.queryByText("Contradicts")).toBeNull();
		expect(inCard.queryByText("Context")).toBeNull();
	});

	it("says date not stated for a missing published date", async () => {
		renderAnswer({
			claims: [
				claim("claim_1", {
					links: [{ evidenceId: "ev_a", relation: "supports", quote: null }],
				}),
			],
			evidence: [evidence("ev_a", { publishedAt: null })],
		});
		fireEvent.focus(await screen.findByRole("button", { name: "Source 1: Report ev_a" }));
		const open = await screen.findByRole("link", { name: "Open source" });
		const card = open.closest("[data-citation-card]");
		expect(card?.textContent).toContain("date not stated");
	});

	it("shows the relation word when the link is not plain support", async () => {
		renderAnswer({
			claims: [
				claim("claim_1", {
					links: [{ evidenceId: "ev_a", relation: "contradicts", quote: "Orders fell." }],
				}),
				claim("claim_2", {
					links: [{ evidenceId: "ev_b", relation: "context", quote: "Background." }],
				}),
			],
			evidence: [evidence("ev_a"), evidence("ev_b")],
		});
		fireEvent.focus(await screen.findByRole("button", { name: "Source 1: Report ev_a" }));
		await screen.findByText("Contradicts");
		fireEvent.focus(await screen.findByRole("button", { name: "Source 2: Report ev_b" }));
		await screen.findByText("Context");
	});

	it("pins the card on click, keeps one card open, and Escape closes it back on the chip", async () => {
		renderAnswer({
			claims: [
				claim("claim_1", {
					links: [{ evidenceId: "ev_a", relation: "supports", quote: "First." }],
				}),
				claim("claim_2", {
					links: [{ evidenceId: "ev_b", relation: "supports", quote: "Second." }],
				}),
			],
			evidence: [evidence("ev_a"), evidence("ev_b")],
		});
		const first = await screen.findByRole("button", { name: "Source 1: Report ev_a" });
		fireEvent.click(first);
		await screen.findByText("First.");
		const second = await screen.findByRole("button", { name: "Source 2: Report ev_b" });
		fireEvent.click(second);
		await screen.findByText("Second.");
		// Only one card is open at a time.
		expect(screen.queryByText("First.")).toBeNull();
		fireEvent.keyDown(second, { key: "Escape" });
		await waitFor(() => expect(screen.queryByText("Second.")).toBeNull());
		expect(document.activeElement).toBe(second);
	});

	it("closes a pinned card on a click outside the citation groups", async () => {
		renderAnswer({
			claims: [
				claim("claim_1", {
					links: [{ evidenceId: "ev_a", relation: "supports", quote: "First." }],
				}),
			],
			evidence: [evidence("ev_a")],
		});
		fireEvent.click(await screen.findByRole("button", { name: /Source 1/ }));
		await screen.findByText("First.");
		fireEvent.pointerDown(document.body);
		expect(screen.queryByText("First.")).toBeNull();
	});

	it("never links an unsafe URL, and names unavailable claims and empty evidence", async () => {
		renderAnswer({
			claimIds: ["claim_1", "claim_missing", "claim_2"],
			claims: [
				claim("claim_1", {
					links: [{ evidenceId: "ev_bad", relation: "supports", quote: "Quoted." }],
				}),
				claim("claim_2", { links: [] }),
			],
			evidence: [evidence("ev_bad", { sourceUrl: "javascript:alert(1)" })],
		});
		expect(await screen.findByText("Claim unavailable (id claim_missing)")).toBeDefined();
		expect(await screen.findByText("No evidence linked to this claim.")).toBeDefined();
		fireEvent.focus(await screen.findByRole("button", { name: /Source 1/ }));
		const quote = await screen.findByText("Quoted.");
		const card = quote.closest("[data-citation-card]");
		expect(card).not.toBeNull();
		const inCard = within(card as HTMLElement);
		expect(inCard.queryByRole("link", { name: "Open source" })).toBeNull();
		expect(inCard.getByText("(link unavailable)")).toBeDefined();
	});
});
