import { describe, expect, it } from "vitest";
import {
	canonicalGoogleSyncDigestInput,
	encodeBase32Hex,
	type GoogleEventBody,
	googleEventBody,
	googleEventId,
	type ManagedGoogleEvent,
	planGoogleSync,
} from "../../src/calendar/googleSync.ts";
import { buildEarningsCalendar, type EarningsCalendarEvent } from "../../src/calendar/ics.ts";

const EVENT: EarningsCalendarEvent = {
	stockId: "us:AAPL",
	symbol: "AAPL",
	name: "Apple Inc",
	periodKey: "2026-q4",
	announcementDate: "2026-10-29",
	fiscalPeriodLabel: "Q4 2026",
	fiscalPeriodEnd: null,
	timing: "after-close",
	publisher: "Finnhub",
	sourceUrl: "https://finnhub.io/",
	retrievedAt: "2026-10-11T03:00:00.000Z",
};

/** Pinned 20-byte digest used across the tests (the application supplies the
 * real first-20-SHA-256 bytes; the domain only encodes — determinism is what
 * matters here). */
const DIGEST_20 = [
	123, 45, 200, 9, 31, 77, 250, 2, 88, 19, 140, 61, 99, 210, 44, 171, 5, 66, 19, 74,
];

function body(overrides: Partial<GoogleEventBody> = {}, id = "a".repeat(32)): GoogleEventBody {
	return {
		id,
		summary: "summary",
		description: "description",
		startDate: "2026-10-29",
		endDate: "2026-10-30",
		privateProperties: { researchWorkspace: "earnings", stockId: "us:AAPL", periodKey: "2026-q4" },
		sourceTitle: "Finnhub",
		sourceUrl: "https://finnhub.io/",
		...overrides,
	};
}

function managed(
	overrides: Partial<ManagedGoogleEvent> = {},
	id = "a".repeat(32),
): ManagedGoogleEvent {
	return {
		id,
		status: "confirmed",
		startDate: "2026-10-29",
		endDate: "2026-10-30",
		summary: "summary",
		description: "description",
		transparency: "transparent",
		...overrides,
	};
}

describe("encodeBase32Hex", () => {
	it("encodes five zero bytes as eight zeros and 0xff bytes deterministically", () => {
		expect(encodeBase32Hex([0, 0, 0, 0, 0])).toEqual({ ok: true, value: "00000000" });
		// 0xFF 0xFF 0xFF 0xFF 0xFF = 40 one-bits = eight groups of 11111 = "vvvvvvvv".
		expect(encodeBase32Hex([255, 255, 255, 255, 255])).toEqual({ ok: true, value: "vvvvvvvv" });
	});

	it("uses only lowercase 0-9a-v and fails closed", () => {
		const encoded = encodeBase32Hex(DIGEST_20);
		expect(encoded.ok).toBe(true);
		if (!encoded.ok) return;
		expect(encoded.value).toMatch(/^[0-9a-v]{32}$/);
		expect(encodeBase32Hex([0, 1, 2])).toEqual({ ok: false, error: "INVALID_BYTES" });
		expect(encodeBase32Hex([0, 0, 0, 0, 256])).toEqual({ ok: false, error: "INVALID_BYTES" });
		expect(encodeBase32Hex([0, 0, 0, 0, 1.5])).toEqual({ ok: false, error: "INVALID_BYTES" });
	});
});

describe("googleEventId", () => {
	it("is deterministic and exactly 32 base32hex chars", () => {
		const first = googleEventId(DIGEST_20);
		const second = googleEventId(DIGEST_20);
		expect(first).toEqual(second);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value).toMatch(/^[0-9a-v]{32}$/);
	});

	it("differs when the digest differs and fails closed on bad input", () => {
		const first = googleEventId(DIGEST_20);
		const altered = googleEventId([...DIGEST_20.slice(0, 19), (DIGEST_20[19] ?? 0) ^ 1]);
		expect(first.ok && altered.ok && first.value !== altered.value).toBe(true);
		expect(googleEventId(DIGEST_20.slice(0, 19))).toEqual({ ok: false, error: "INVALID_DIGEST" });
		expect(googleEventId([...DIGEST_20, 0])).toEqual({ ok: false, error: "INVALID_DIGEST" });
	});
});

describe("googleEventBody", () => {
	it("builds the same body whenever the data was retrieved (a refresh alone changes nothing)", () => {
		const monday = googleEventBody(EVENT, DIGEST_20);
		const tuesday = googleEventBody(
			{ ...EVENT, retrievedAt: "2026-10-12T03:00:00.000Z" },
			DIGEST_20,
		);
		expect(monday.ok).toBe(true);
		expect(tuesday).toEqual(monday);
		if (!monday.ok) return;
		expect(monday.value.description).toContain("Source: Finnhub.");
		expect(monday.value.description).not.toContain("retrieved");
		// So a second sync after a refresh that moved no date plans no write.
		const stored = {
			id: monday.value.id,
			status: "confirmed" as const,
			startDate: monday.value.startDate,
			endDate: monday.value.endDate,
			summary: monday.value.summary,
			description: monday.value.description,
			transparency: "transparent" as const,
		};
		if (!tuesday.ok) return;
		expect(planGoogleSync([tuesday.value], [stored])).toEqual({
			ok: true,
			value: { inserts: [], updates: [], deletes: [], unchanged: [monday.value.id] },
		});
	});

	it("shares the ICS summary/description text and sets the next-day end date", () => {
		const result = googleEventBody(EVENT, DIGEST_20);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.startDate).toBe("2026-10-29");
		expect(result.value.endDate).toBe("2026-10-30");
		expect(result.value.privateProperties).toEqual({
			researchWorkspace: "earnings",
			stockId: "us:AAPL",
			periodKey: "2026-q4",
		});
		expect(result.value.sourceTitle).toBe("Finnhub");
		expect(result.value.sourceUrl).toBe("https://finnhub.io/");
		// The SAME text the ICS writer uses (byte-identical ICS is proved by the existing vectors).
		const calendar = buildEarningsCalendar({ calendarName: "Earnings", events: [EVENT] });
		expect(calendar).toContain("SUMMARY:AAPL Apple Inc earnings (Q4 2026)");
		expect(result.value.summary).toBe("AAPL Apple Inc earnings (Q4 2026)");
		expect(result.value.description).toContain(
			"Scheduled earnings announcement for AAPL (Q4 2026).",
		);
	});

	it("fails closed on undecided dates and bad digests", () => {
		expect(googleEventBody({ ...EVENT, announcementDate: null }, DIGEST_20)).toEqual({
			ok: false,
			error: "INVALID_DATE",
		});
		expect(googleEventBody({ ...EVENT, announcementDate: "2026-02-30" }, DIGEST_20)).toEqual({
			ok: false,
			error: "INVALID_DATE",
		});
		expect(googleEventBody(EVENT, [1, 2, 3])).toEqual({ ok: false, error: "INVALID_DIGEST" });
		expect(googleEventBody({ ...EVENT, stockId: "  " }, DIGEST_20)).toEqual({
			ok: false,
			error: "INVALID_EVENT",
		});
	});
});

describe("planGoogleSync", () => {
	it("inserts unknown ids and leaves identical confirmed events unchanged, in id order", () => {
		const desired = [body({}, "b".repeat(32)), body({}, "a".repeat(32))];
		const existing = [managed({}, "a".repeat(32))];
		const plan = planGoogleSync(desired, existing);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.value.inserts.map((entry) => entry.id)).toEqual(["b".repeat(32)]);
		expect(plan.value.unchanged).toEqual(["a".repeat(32)]);
		expect(plan.value.updates).toEqual([]);
		expect(plan.value.deletes).toEqual([]);
	});

	it("updates cancelled events and changed fields, deletes confirmed-but-undesired ids", () => {
		const desired = [
			body({ summary: "new" }, "a".repeat(32)),
			body({}, "b".repeat(32)),
			body({}, "c".repeat(32)),
		];
		const existing = [
			managed({}, "a".repeat(32)),
			managed({ status: "cancelled" }, "b".repeat(32)),
			managed({}, "d".repeat(32)),
			managed({ status: "cancelled" }, "e".repeat(32)),
		];
		const plan = planGoogleSync(desired, existing);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.value.updates.map((entry) => entry.id)).toEqual(["a".repeat(32), "b".repeat(32)]);
		expect(plan.value.inserts.map((entry) => entry.id)).toEqual(["c".repeat(32)]);
		// Confirmed-and-not-desired is deleted; cancelled-and-not-desired is ignored.
		expect(plan.value.deletes).toEqual(["d".repeat(32)]);
		expect(plan.value.unchanged).toEqual([]);
	});

	it("updates a busy (opaque) event that is otherwise unchanged, so it becomes free", () => {
		const desired = [body({}, "a".repeat(32)), body({}, "b".repeat(32))];
		const existing = [
			managed({ transparency: "opaque" }, "a".repeat(32)),
			managed({}, "b".repeat(32)),
		];
		const plan = planGoogleSync(desired, existing);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.value.updates.map((entry) => entry.id)).toEqual(["a".repeat(32)]);
		expect(plan.value.unchanged).toEqual(["b".repeat(32)]);
		// A busy event that is no longer desired is deleted like any other.
		const gone = planGoogleSync([], [managed({ transparency: "opaque" }, "c".repeat(32))]);
		expect(gone.ok && gone.value.deletes).toEqual(["c".repeat(32)]);
	});

	it("rejects duplicate ids instead of double-writing", () => {
		expect(planGoogleSync([body({}, "a".repeat(32)), body({}, "a".repeat(32))], [])).toEqual({
			ok: false,
			error: "DUPLICATE_ID",
		});
		expect(planGoogleSync([], [managed({}, "a".repeat(32)), managed({}, "a".repeat(32))])).toEqual({
			ok: false,
			error: "DUPLICATE_ID",
		});
	});
});

describe("canonicalGoogleSyncDigestInput", () => {
	it("is order-independent and changes when any compared field changes", () => {
		const first = body({}, "b".repeat(32));
		const second = body({}, "a".repeat(32));
		expect(canonicalGoogleSyncDigestInput([first, second])).toBe(
			canonicalGoogleSyncDigestInput([second, first]),
		);
		expect(canonicalGoogleSyncDigestInput([first])).not.toBe(
			canonicalGoogleSyncDigestInput([{ ...first, summary: "changed" }]),
		);
		expect(canonicalGoogleSyncDigestInput([])).toBe("[]");
		// The written transparency is part of the digest input.
		expect(JSON.parse(canonicalGoogleSyncDigestInput([first]))[0].transparency).toBe("transparent");
	});
});
