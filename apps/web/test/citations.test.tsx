import type { Claim, Evidence } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerClaims } from "../src/chat/Citations.tsx";
import {
	chipLabel,
	numberEvidence,
	numbersForClaim,
	sourceHost,
	titleOrHost,
} from "../src/chat/citationModel.ts";

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

describe("citation numbering (per answer, first appearance wins)", () => {
	it("numbers distinct evidence in order of first appearance starting at 1", () => {
		const numbering = numberEvidence([
			{
				claimId: "claim_1",
				links: [{ evidenceId: "ev_b" }, { evidenceId: "ev_a" }],
			},
			{ claimId: "claim_2", links: [{ evidenceId: "ev_a" }, { evidenceId: "ev_c" }] },
		]);
		expect([...numbering.numberByEvidenceId]).toEqual([
			["ev_b", 1],
			["ev_a", 2],
			["ev_c", 3],
		]);
		expect(numbering.evidenceIdsInOrder).toEqual(["ev_b", "ev_a", "ev_c"]);
	});

	it("gives shared evidence the same number in every claim", () => {
		const numbering = numberEvidence([
			{ claimId: "claim_1", links: [{ evidenceId: "ev_a" }] },
			{ claimId: "claim_2", links: [{ evidenceId: "ev_a" }] },
		]);
		expect(numbering.numberByEvidenceId.get("ev_a")).toBe(1);
		expect(
			numbersForClaim({ claimId: "claim_1", links: [{ evidenceId: "ev_a" }] }, numbering),
		).toEqual([1]);
		expect(
			numbersForClaim({ claimId: "claim_2", links: [{ evidenceId: "ev_a" }] }, numbering),
		).toEqual([1]);
	});

	it("keeps link order within a claim and skips unknown ids", () => {
		const numbering = numberEvidence([
			{ claimId: "claim_1", links: [{ evidenceId: "ev_a" }, { evidenceId: "ev_b" }] },
		]);
		expect(
			numbersForClaim(
				{ claimId: "claim_1", links: [{ evidenceId: "ev_b" }, { evidenceId: "ev_a" }] },
				numbering,
			),
		).toEqual([2, 1]);
		expect(
			numbersForClaim({ claimId: "claim_1", links: [{ evidenceId: "ev_missing" }] }, numbering),
		).toEqual([]);
	});

	it("names hosts, titles and chip labels", () => {
		expect(sourceHost("https://news.example.org/a/1?utm=x")).toBe("news.example.org");
		expect(sourceHost("not a url")).toBeNull();
		expect(titleOrHost("  ", "https://news.example.org/a")).toBe("news.example.org");
		expect(titleOrHost("Grid outlook", "https://news.example.org/a")).toBe("Grid outlook");
		expect(chipLabel(2, "Grid outlook", "https://news.example.org/a")).toBe(
			"Source 2: Grid outlook",
		);
	});
});

function renderAnswer(options: {
	readonly claimIds?: readonly string[];
	readonly claims?: readonly Claim[];
	readonly evidence?: readonly Evidence[];
}) {
	const claims = new Map((options.claims ?? []).map((entry) => [entry.claimId, entry] as const));
	const sources = new Map(
		(options.evidence ?? []).map((entry) => [entry.evidenceId, entry] as const),
	);
	render(() => (
		<AnswerClaims
			claimIds={options.claimIds ?? [...claims.keys()]}
			claims={claims}
			evidence={sources}
		/>
	));
}

describe("citation chips and source cards", () => {
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

	it("opens the card on focus with title, publisher, date, excerpt and an Open source link", async () => {
		renderAnswer({
			claims: [
				claim("claim_1", {
					links: [{ evidenceId: "ev_a", relation: "supports", quote: "Orders rose." }],
				}),
			],
			evidence: [evidence("ev_a", { title: "Alpha", excerpt: "Stored excerpt." })],
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
		const open = inCard.getByRole("link", { name: "Open source" });
		expect(open.getAttribute("href")).toBe("https://example.com/reports/ev_a");
		expect(open.getAttribute("target")).toBe("_blank");
		// Plain support needs no extra word.
		expect(inCard.queryByText("Contradicts")).toBeNull();
		expect(inCard.queryByText("Context")).toBeNull();
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
