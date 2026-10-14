import { err, ok, type Result } from "../result.ts";
import { addDaysIso, isValidIsoDate } from "./civilDate.ts";
import { type EarningsCalendarEvent, earningsCalendarTexts } from "./ics.ts";

/**
 * Pure Google Calendar sync domain (FR-019 section 2.3). The domain stays
 * hash-free: the application hashes `stockId + "\n" + periodKey` with its
 * `Hasher` port (SHA-256) and passes the first 20 digest bytes here, so no
 * crypto lives in the pure core. Summary/description text is the ONE shared
 * ICS builder (`earningsCalendarTexts`), so the `.ics` writer and Google
 * bodies can never drift — the existing ICS vectors prove the output stays
 * byte-identical.
 */

const BASE32HEX_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

export type Base32HexError = "INVALID_BYTES";
export type GoogleEventIdError = "INVALID_DIGEST";
export type GoogleEventBodyError = "INVALID_EVENT" | "INVALID_DIGEST" | "INVALID_DATE";
export type GoogleSyncPlanError = "DUPLICATE_ID";

/**
 * Base32hex (lowercase `0-9a-v`, RFC 4648 §7) without padding: `bytes.length`
 * must be a multiple of 5, each byte an integer 0..255. 20 bytes → 32 chars,
 * which is the Google event id. Fails closed on any other input.
 */
export function encodeBase32Hex(bytes: readonly number[]): Result<string, Base32HexError> {
	if (bytes.length % 5 !== 0) return err("INVALID_BYTES");
	for (const byte of bytes) {
		if (!Number.isInteger(byte) || byte < 0 || byte > 255) return err("INVALID_BYTES");
	}
	// One 5-byte chunk at a time: a chunk is 40 bits (< 2^53, so every
	// intermediate value is an exact float64 integer) yielding 8 chars,
	// most significant first. Accumulating all bytes into one number would
	// exceed 2^53 and silently drop low-order bytes.
	let output = "";
	for (let offset = 0; offset < bytes.length; offset += 5) {
		let chunk = 0;
		for (let index = 0; index < 5; index += 1) {
			chunk = chunk * 256 + (bytes[offset + index] ?? 0);
		}
		for (let shift = 35; shift >= 0; shift -= 5) {
			output += BASE32HEX_ALPHABET[Math.trunc(chunk / 2 ** shift) % 32];
		}
	}
	return ok(output);
}

/**
 * Deterministic Google event id: base32hex of the first 20 SHA-256 digest
 * bytes (32 chars of `0-9a-v`, within Google's 5–1024 base32hex id rule), so
 * a re-sync never duplicates an event. Takes the digest bytes — not the
 * stock/period — so the domain never hashes.
 */
export function googleEventId(digest20: readonly number[]): Result<string, GoogleEventIdError> {
	if (digest20.length !== 20) return err("INVALID_DIGEST");
	for (const byte of digest20) {
		if (!Number.isInteger(byte) || byte < 0 || byte > 255) return err("INVALID_DIGEST");
	}
	const encoded = encodeBase32Hex(digest20);
	if (!encoded.ok) return err("INVALID_DIGEST");
	return ok(encoded.value);
}

export interface GoogleEventBody {
	readonly id: string;
	readonly summary: string;
	readonly description: string;
	readonly startDate: string;
	/** Next civil day (Google all-day `end.date` is exclusive). */
	readonly endDate: string;
	readonly privateProperties: {
		readonly researchWorkspace: "earnings";
		readonly stockId: string;
		readonly periodKey: string;
	};
	readonly sourceTitle: string;
	readonly sourceUrl: string;
}

/**
 * Full Google event body for one dated earnings announcement. The id comes
 * from `digest20` (see `googleEventId`); summary/description are the shared
 * ICS text builder's output without its retrieval date. Undecided or malformed dates fail instead of
 * guessing.
 */
export function googleEventBody(
	event: EarningsCalendarEvent,
	digest20: readonly number[],
): Result<GoogleEventBody, GoogleEventBodyError> {
	const id = googleEventId(digest20);
	if (!id.ok) return err("INVALID_DIGEST");
	if (event.stockId.trim() === "" || event.periodKey.trim() === "") return err("INVALID_EVENT");
	if (event.publisher.trim() === "" || event.sourceUrl.trim() === "") return err("INVALID_EVENT");
	if (event.announcementDate === null || !isValidIsoDate(event.announcementDate)) {
		return err("INVALID_DATE");
	}
	const end = addDaysIso(event.announcementDate, 1);
	if (!end.ok) return err("INVALID_DATE");
	// No retrieval date in the text: the plan compares it with what Google
	// holds, and a date that moves with every refresh would turn each daily
	// refresh into an update of every event.
	const { summary, description } = earningsCalendarTexts(event, { stampRetrieved: false });
	return ok({
		id: id.value,
		summary,
		description,
		startDate: event.announcementDate,
		endDate: end.value,
		privateProperties: {
			researchWorkspace: "earnings",
			stockId: event.stockId,
			periodKey: event.periodKey,
		},
		sourceTitle: event.publisher,
		sourceUrl: event.sourceUrl,
	});
}

/** One managed event Google returned (`events.list` with `showDeleted=true`). */
export interface ManagedGoogleEvent {
	readonly id: string;
	readonly status: "confirmed" | "cancelled";
	readonly startDate: string;
	readonly endDate: string;
	readonly summary: string;
	readonly description: string;
}

export interface GoogleSyncPlan {
	/** Desired bodies to insert, by id ascending. */
	readonly inserts: readonly GoogleEventBody[];
	/** Desired bodies to upsert (PUT), by id ascending. */
	readonly updates: readonly GoogleEventBody[];
	/** Confirmed managed ids with no desired body, by id ascending. */
	readonly deletes: readonly string[];
	/** Desired ids already confirmed and identical, by id ascending. */
	readonly unchanged: readonly string[];
}

function bodiesEqual(desired: GoogleEventBody, existing: ManagedGoogleEvent): boolean {
	return (
		desired.startDate === existing.startDate &&
		desired.endDate === existing.endDate &&
		desired.summary === existing.summary &&
		desired.description === existing.description
	);
}

/**
 * Sync plan: insert when the id is unknown; update when known and (cancelled
 * or any compared field — start/end/summary/description — differs); delete
 * when a confirmed managed event's id is not desired; a cancelled event that
 * is not desired is ignored (nothing to delete). Deterministic order (by id).
 * Uses maps, not nested scans, so 400 × 400 stays linear-ish.
 */
export function planGoogleSync(
	desired: readonly GoogleEventBody[],
	existing: readonly ManagedGoogleEvent[],
): Result<GoogleSyncPlan, GoogleSyncPlanError> {
	const desiredIds = new Set<string>();
	for (const body of desired) {
		if (desiredIds.has(body.id)) return err("DUPLICATE_ID");
		desiredIds.add(body.id);
	}
	const existingIds = new Set<string>();
	for (const event of existing) {
		if (existingIds.has(event.id)) return err("DUPLICATE_ID");
		existingIds.add(event.id);
	}
	const existingById = new Map(existing.map((event) => [event.id, event] as const));
	const inserts: GoogleEventBody[] = [];
	const updates: GoogleEventBody[] = [];
	const unchanged: string[] = [];
	const ordered = [...desired].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	for (const body of ordered) {
		const known = existingById.get(body.id);
		if (known === undefined) {
			inserts.push(body);
		} else if (known.status === "cancelled" || !bodiesEqual(body, known)) {
			updates.push(body);
		} else {
			unchanged.push(body.id);
		}
	}
	const deletes = [...existing]
		.filter((event) => event.status === "confirmed" && !desiredIds.has(event.id))
		.map((event) => event.id)
		.sort();
	return ok({ inserts, updates, deletes, unchanged });
}

/**
 * Canonical digest input over the desired bodies sorted by id (fixed key
 * order, `JSON.stringify`): the application hashes this with its `Hasher`
 * (`googleSyncDigest`). Removing a stock or a refresh that changes dates
 * therefore changes the digest with no extra write.
 */
export function canonicalGoogleSyncDigestInput(bodies: readonly GoogleEventBody[]): string {
	const ordered = [...bodies].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return JSON.stringify(
		ordered.map((body) => ({
			id: body.id,
			summary: body.summary,
			description: body.description,
			startDate: body.startDate,
			endDate: body.endDate,
			stockId: body.privateProperties.stockId,
			periodKey: body.privateProperties.periodKey,
			sourceTitle: body.sourceTitle,
			sourceUrl: body.sourceUrl,
		})),
	);
}
