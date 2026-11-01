import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planSyncDays } from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Conformance between the day planner of the per-date syncs
 * (`packages/domain/src/sync/syncDays.ts`, ADR-0058 §2, §4, §8) and its
 * Lean 4 model, `formal/ResearchFormal/SyncDays.lean`.
 *
 * `formal/Export.lean` evaluates the verified `planSyncDays` over every
 * weekday as the newest day × window lengths −2 … 15 (empty windows,
 * single days, weekend-only windows) × five known sets (none; the newest day
 * final; every outcome — final, retry passed, retry exactly now, retry to
 * come; a day listed twice, blocking and due in both orders; entries outside
 * the window only) × caps −1 … 100: 2,205 vectors; 30 windows across
 * 1 January 1970 (negative day numbers); and 600 random windows, known sets
 * and caps. The model's dates are day numbers since 1970-01-01 and become
 * ISO dates here through `Date` — independently of the code's own
 * conversion, so the model's weekday arithmetic is checked against the real
 * calendar too.
 */
const day = z.number().int();
const vectorFile = z.object({
	syncDays: z
		.array(
			z.object({
				newest: day,
				oldest: day,
				known: z.array(z.object({ day, final: z.boolean(), retryAtMs: z.number().int() })),
				nowMs: z.number().int(),
				max: z.number().int(),
				days: z.array(day),
			}),
		)
		.min(1),
});

const { syncDays } = vectorFile.parse(
	JSON.parse(
		readFileSync(fileURLToPath(new URL("../../formal/vectors.json", import.meta.url)), "utf8"),
	),
);

const DAY_MS = 86_400_000;

function isoOf(dayNumber: number): string {
	return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

describe("planSyncDays matches the Lean model (ADR-0058 §8)", () => {
	it("on every exported window, known set and cap", () => {
		expect(syncDays).toHaveLength(2835);
		for (const vector of syncDays) {
			const input = {
				newest: isoOf(vector.newest),
				oldest: isoOf(vector.oldest),
				known: vector.known.map((entry) => ({ ...entry, day: isoOf(entry.day) })),
				nowMs: vector.nowMs,
				max: vector.max,
			};
			expect(planSyncDays(input), JSON.stringify(vector)).toEqual(vector.days.map(isoOf));
		}
	});

	it("the vectors reach the edge cases the brief names", () => {
		const weekday = (dayNumber: number) => new Date(dayNumber * DAY_MS).getUTCDay();
		const isWeekend = (dayNumber: number) => weekday(dayNumber) === 0 || weekday(dayNumber) === 6;
		const weekendOnly = syncDays.filter(
			(v) =>
				v.newest >= v.oldest &&
				v.max > 0 &&
				Array.from({ length: v.newest - v.oldest + 1 }, (_, k) => v.oldest + k).every(isWeekend),
		);
		expect(weekendOnly.length).toBeGreaterThan(0);
		expect(weekendOnly.every((v) => v.days.length === 0)).toBe(true);
		expect(syncDays.some((v) => v.newest === v.oldest && v.days.length === 1)).toBe(true);
		expect(syncDays.some((v) => v.newest < v.oldest)).toBe(true);
		expect(syncDays.some((v) => v.max <= 0)).toBe(true);
		expect(syncDays.some((v) => new Set(v.known.map((k) => k.day)).size < v.known.length)).toBe(
			true,
		);
		expect(syncDays.some((v) => v.known.some((k) => !k.final && k.retryAtMs === v.nowMs))).toBe(
			true,
		);
		expect(syncDays.some((v) => v.oldest < 0)).toBe(true);
		expect(syncDays.some((v) => v.days.length === v.max && v.max > 0)).toBe(true);
	});
});
