import { equityFactsResponseSchema, equityIssuerListSchema } from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { equityFixture } from "../../../examples/equities/fixture.ts";
import { createApiClient } from "../src/api/client.ts";
import { EquitiesView } from "../src/equities/EquitiesView.tsx";
import { equityResearchSnapshot } from "../src/equities/researchSnapshot.ts";

function client() {
	const facts = equityFactsResponseSchema.parse({
		facts: [
			{
				...equityFixture.facts[0],
				issuerId: "issuer_example_us",
				statement: equityFixture.statements[0],
				metric: equityFixture.metrics[0],
				filing: equityFixture.filings[0],
				document: equityFixture.documents[0],
				committedAt: "2026-10-29T00:00:00.000Z",
			},
		],
		nextCursor: null,
	});
	const issuers = equityIssuerListSchema.parse({
		issuers: [{ ...equityFixture.issuers[0], symbols: ["US:EXAMPLE"], factCount: 1 }],
		nextCursor: null,
	});
	const calls: string[] = [];
	return {
		calls,
		api: createApiClient({
			fetch: async (input) => {
				calls.push(input);
				const url = new URL(input, "http://localhost");
				const data = url.pathname.endsWith("/facts")
					? url.searchParams.has("informationCutoff")
						? { facts: [], nextCursor: null }
						: facts
					: url.pathname.endsWith("/records")
						? { records: [], nextCursor: null }
						: url.pathname.endsWith("/imports")
							? { imports: [], nextCursor: null }
							: issuers;
				return new Response(JSON.stringify(data), {
					headers: { "Content-Type": "application/json" },
				});
			},
		}),
	};
}

describe("Equities page", () => {
	it("copies bounded, exact source-traceable facts that fit the Chat composer", () => {
		const fact = equityFactsResponseSchema.parse({
			facts: [
				{
					...equityFixture.facts[0],
					issuerId: "issuer_example_us",
					statement: equityFixture.statements[0],
					metric: equityFixture.metrics[0],
					filing: equityFixture.filings[0],
					document: equityFixture.documents[0],
					committedAt: "2026-10-29T00:00:00.000Z",
				},
			],
			nextCursor: null,
			ingestionVersion: 3,
		}).facts[0];
		if (fact === undefined) throw new Error("missing fixture");
		const copied = equityResearchSnapshot(
			"issuer_example_us",
			{
				facts: Array.from({ length: 200 }, (_, n) => ({ ...fact, factId: `fact_${n}` })),
				nextCursor: null,
				ingestionVersion: 3,
			},
			{},
		);
		expect(copied).not.toBeNull();
		expect(copied?.length).toBeLessThanOrEqual(1800);
		expect(copied).toContain('"valueDecimal":"9007199254740993.25"');
		expect(copied).toContain('"partial":true');
		expect(copied).toContain('"ingestionVersion":3');
		expect(copied).toContain("https://example.com/us");
	});
	it("shows exact amounts and provenance, and applies historical filters only on submit", async () => {
		const { api, calls } = client();
		render(() => (
			<LocaleProvider locale={() => "en"}>
				<EquitiesView api={api} />
			</LocaleProvider>
		));
		await fireEvent.click(await screen.findByRole("button", { name: /Example US Industries/ }));
		expect(await screen.findByText("9007199254740993.25")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Synthetic US annual statement" }).getAttribute("href"),
		).toBe("https://example.com/us");
		const cutoff = screen.getByLabelText("Public information cutoff (UTC, optional)");
		await fireEvent.input(cutoff, { target: { value: "2026-04-01T00:00:00.000Z" } });
		expect(calls.some((call) => call.includes("informationCutoff"))).toBe(false);
		await fireEvent.submit(cutoff.closest("form") ?? cutoff);
		await waitFor(() => expect(screen.queryByText("9007199254740993.25")).toBeNull());
		expect(
			await screen.findByText("No financial facts are available for these filters."),
		).toBeTruthy();
	});
	it("renders the Japanese page and a useful empty import history", async () => {
		const { api } = client();
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<EquitiesView api={api} />
			</LocaleProvider>
		));
		expect(await screen.findByRole("heading", { name: "株式データ" })).toBeTruthy();
		expect(await screen.findByText("取り込みはまだありません。")).toBeTruthy();
		expect(screen.getByRole("button", { name: "取り込む" }).hasAttribute("disabled")).toBe(true);
	});
});
