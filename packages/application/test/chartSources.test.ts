import type { Evidence } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { chartSourceProblem } from "../src/chartSources.ts";
import type { ReferenceLookup } from "../src/ports.ts";

const RECORD: Evidence = {
	evidenceId: "ev_1",
	sourceUrl: "https://example.com/a",
	title: "Outlook",
	publisher: "Example",
	publishedAt: null,
	retrievedAt: "2026-10-01T00:00:00.000Z",
	effectiveAt: null,
	excerpt: null,
	checksum: "b".repeat(64),
	sourceClass: "news",
};

/** A records port that counts its calls and resolves only `stored`. */
function store(stored: readonly Evidence[]) {
	const lookups: string[][] = [];
	return {
		lookups,
		records: {
			resolve: async (_ownerId: string, lookup: ReferenceLookup) => {
				lookups.push([...lookup.evidenceIds]);
				return {
					datasets: [],
					evidence: stored.filter((record) => lookup.evidenceIds.includes(record.evidenceId)),
					claims: [],
				};
			},
		},
	};
}

const chart = (title: string, sources: readonly Evidence[]) => ({ type: "chart", title, sources });

describe("chartSourceProblem (ADR-0026)", () => {
	it("accepts a copy equal to the stored record, whatever its key order", async () => {
		// The same fields in another order, as a row read back from storage may have them.
		const reordered: Evidence = {
			sourceClass: RECORD.sourceClass,
			checksum: RECORD.checksum,
			excerpt: RECORD.excerpt,
			effectiveAt: RECORD.effectiveAt,
			retrievedAt: RECORD.retrievedAt,
			publishedAt: RECORD.publishedAt,
			publisher: RECORD.publisher,
			title: RECORD.title,
			sourceUrl: RECORD.sourceUrl,
			evidenceId: RECORD.evidenceId,
		};
		expect(Object.keys(reordered)).not.toEqual(Object.keys(RECORD));
		const { records } = store([RECORD]);
		expect(await chartSourceProblem(records, "o", [chart("A", [reordered])], [])).toBeNull();
	});

	it("refuses an unknown id and an altered copy, naming the chart", async () => {
		const { records } = store([RECORD]);
		expect(
			await chartSourceProblem(
				records,
				"o",
				[chart("Made up", [{ ...RECORD, evidenceId: "ev_x" }])],
				[],
			),
		).toContain('Chart "Made up"');
		expect(
			await chartSourceProblem(
				records,
				"o",
				[chart("Edited", [{ ...RECORD, sourceUrl: "https://example.com/elsewhere" }])],
				[],
			),
		).toContain('Chart "Edited"');
	});

	it("looks nothing up for copies already stored unchanged, and batches the rest", async () => {
		const other: Evidence = { ...RECORD, evidenceId: "ev_2", title: "Second" };
		const { records, lookups } = store([RECORD, other]);
		expect(
			await chartSourceProblem(records, "o", [chart("Kept", [RECORD])], [chart("Kept", [RECORD])]),
		).toBeNull();
		expect(lookups).toEqual([]);
		expect(
			await chartSourceProblem(
				records,
				"o",
				[chart("A", [RECORD, other]), chart("B", [other])],
				[],
			),
		).toBeNull();
		expect(lookups).toEqual([["ev_1", "ev_2"]]);
	});

	it("ignores widgets that are not charts", async () => {
		const { records, lookups } = store([]);
		expect(await chartSourceProblem(records, "o", [{ type: "text", title: "T" }], [])).toBeNull();
		expect(lookups).toEqual([]);
	});
});
