import { addDaysIso, isValidIsoDate } from "./civilDate.ts";

export type EarningsTiming = "before-open" | "after-close" | "during-session" | "unknown";

/**
 * One dated-or-undecided earnings announcement with the stored context the
 * calendar document needs. `retrievedAt` is the ISO datetime the owning stock
 * was last successfully refreshed; it stamps every VEVENT deterministically
 * (ARCH-011: the same stored data yields byte-identical output).
 */
export interface EarningsCalendarEvent {
	readonly stockId: string;
	readonly symbol: string;
	readonly name: string | null;
	readonly periodKey: string;
	readonly announcementDate: string | null;
	readonly fiscalPeriodLabel: string;
	readonly fiscalPeriodEnd: string | null;
	readonly timing: EarningsTiming;
	readonly publisher: string;
	readonly sourceUrl: string;
	readonly retrievedAt: string;
}

const PRODID = "-//stock-investigation//Earnings Calendar//EN";
const CALENDAR_DOMAIN = "research-workspace";

/**
 * RFC 5545 TEXT escaping: `\` -> `\\`, `;` -> `\;`, `,` -> `\,`,
 * CR/LF/CRLF -> `\n`; every other control character is removed. The backslash
 * pass runs first so the `\n` introduced for newlines is not escaped twice.
 */
export function escapeIcsText(text: string): string {
	return stripControlChars(
		text
			.replace(/\\/g, "\\\\")
			.replace(/\r\n|\r|\n/g, "\\n")
			.replace(/;/g, "\\;")
			.replace(/,/g, "\\,"),
	);
}

/** Removes C0 controls, DEL and C1 controls; everything else passes through. */
function stripControlChars(text: string): string {
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20) continue;
		if (code === 0x7f) continue;
		if (code >= 0x80 && code <= 0x9f) continue;
		out += char;
	}
	return out;
}

/**
 * RFC 5545 URI escaping for `URL` (and any other URI-valued property): a URI
 * is NOT TEXT, so the backslash/semicolon/comma/newline escapes of
 * `escapeIcsText` must NOT apply (they would corrupt the address) — control
 * characters are stripped and nothing else changes.
 */
export function escapeIcsUri(uri: string): string {
	return stripControlChars(uri);
}

function utf8Width(codePoint: number): number {
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

/**
 * Folds one content line to at most 75 octets (UTF-8) per line per RFC 5545:
 * the first line carries up to 75 octets, each continuation line starts with
 * one space (which counts toward its 75, so 74 content octets). A multi-byte
 * character is never split across lines. Joining the pieces after removing
 * each `CRLF + space` yields the input exactly.
 */
export function foldIcsLine(line: string): string {
	const chunks: string[] = [];
	let current = "";
	let used = 0;
	let budget = 75;
	for (const char of line) {
		const width = utf8Width(char.codePointAt(0) ?? 0);
		if (current !== "" && used + width > budget) {
			chunks.push(current);
			current = "";
			used = 0;
			budget = 74;
		}
		current += char;
		used += width;
	}
	chunks.push(current);
	return chunks.join("\r\n ");
}

const TIMING_LABELS: { readonly [T in Exclude<EarningsTiming, "unknown">]: string } = {
	"before-open": "before market open",
	"after-close": "after market close",
	"during-session": "during the trading session",
};

/**
 * The ONE summary/description text builder (SPEC section 3): the ICS writer
 * and the Google/Outlook link builders share it, so the three never drift.
 * The description states the date is scheduled and can change, names the
 * timing when known, and cites the publisher with the retrieved date.
 */
export function earningsCalendarTexts(
	event: {
		readonly symbol: string;
		readonly name: string | null;
		readonly fiscalPeriodLabel: string;
		readonly timing: EarningsTiming;
		readonly publisher: string;
		readonly retrievedAt: string;
	},
	/**
	 * `stampRetrieved: false` leaves the retrieval date out of the source
	 * line. A calendar document is a snapshot, so it states when its data was
	 * retrieved; text that is COMPARED against a stored copy (the Google
	 * sync) must not, or every event would count as changed after each daily
	 * refresh although no date moved.
	 */
	options: { readonly stampRetrieved: boolean } = { stampRetrieved: true },
): { readonly summary: string; readonly description: string } {
	const displayName =
		event.name === null || event.name.trim() === "" ? event.symbol : event.name.trim();
	const summary = `${event.symbol} ${displayName} earnings (${event.fiscalPeriodLabel})`;
	const lines = [
		`Scheduled earnings announcement for ${event.symbol} (${event.fiscalPeriodLabel}).`,
		"The date can change; check the source before acting on it.",
	];
	if (event.timing !== "unknown") {
		lines.push(`Expected timing: ${TIMING_LABELS[event.timing]}.`);
	}
	lines.push(
		options.stampRetrieved
			? `Source: ${event.publisher}, retrieved ${event.retrievedAt.slice(0, 10)}.`
			: `Source: ${event.publisher}.`,
	);
	return { summary, description: lines.join("\n") };
}

export interface EarningsDateForms {
	readonly hyphen: string;
	readonly compact: string;
	readonly nextHyphen: string;
	readonly nextCompact: string;
}

/** Both spellings of a valid announcement date plus the following day, or null. */
export function earningsDateForms(announcementDate: string | null): EarningsDateForms | null {
	if (announcementDate === null || !isValidIsoDate(announcementDate)) return null;
	const next = addDaysIso(announcementDate, 1);
	if (!next.ok) return null;
	return {
		hyphen: announcementDate,
		compact: announcementDate.replaceAll("-", ""),
		nextHyphen: next.value,
		nextCompact: next.value.replaceAll("-", ""),
	};
}

const DTSTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

/** `retrievedAt` in `YYYYMMDDTHHMMSSZ`, or null when it is not a usable instant. */
function toDtStamp(retrievedAt: string): string | null {
	const match = DTSTAMP_PATTERN.exec(retrievedAt);
	if (match === null) return null;
	const [, year, month, day, hour, minute, second] = match;
	const date = `${year}-${month}-${day}`;
	if (!isValidIsoDate(date)) return null;
	if (
		year === undefined ||
		month === undefined ||
		day === undefined ||
		hour === undefined ||
		minute === undefined ||
		second === undefined
	) {
		return null;
	}
	if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) return null;
	return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

function toVEvent(event: EarningsCalendarEvent): string | null {
	const forms = earningsDateForms(event.announcementDate);
	const stamp = toDtStamp(event.retrievedAt);
	// Undecided events are omitted (there is no date to put on a calendar);
	// an event without a usable stamp is omitted rather than stamped with a guess.
	if (forms === null || stamp === null) return null;
	const { summary, description } = earningsCalendarTexts(event);
	const uid = `earnings-${event.stockId.replaceAll(":", "-")}-${event.periodKey}@${CALENDAR_DOMAIN}`;
	const lines = [
		"BEGIN:VEVENT",
		`UID:${uid}`,
		`DTSTAMP:${stamp}`,
		`DTSTART;VALUE=DATE:${forms.compact}`,
		`DTEND;VALUE=DATE:${forms.nextCompact}`,
		`SUMMARY:${escapeIcsText(summary)}`,
		`DESCRIPTION:${escapeIcsText(description)}`,
		`URL:${escapeIcsUri(event.sourceUrl)}`,
		"TRANSP:TRANSPARENT",
		"END:VEVENT",
	];
	return lines.map(foldIcsLine).join("\r\n");
}

/**
 * The whole calendar document (RFC 5545, CRLF line endings): `VERSION:2.0`,
 * `PRODID`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, `X-WR-CALNAME`, then one
 * all-day `VEVENT` per dated event ordered by date then stockId. Deterministic
 * (ARCH-011): the same stored data yields byte-identical output.
 */
export function buildEarningsCalendar(input: {
	readonly calendarName: string;
	readonly events: readonly EarningsCalendarEvent[];
}): string {
	const dated = input.events.filter((event) => event.announcementDate !== null);
	dated.sort((a, b) => {
		const dateA = a.announcementDate ?? "";
		const dateB = b.announcementDate ?? "";
		if (dateA !== dateB) return dateA < dateB ? -1 : 1;
		return a.stockId < b.stockId ? -1 : a.stockId > b.stockId ? 1 : 0;
	});
	const header = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		`PRODID:${PRODID}`,
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		`X-WR-CALNAME:${escapeIcsText(input.calendarName)}`,
	].map(foldIcsLine);
	const parts = [...header];
	for (const event of dated) {
		const vevent = toVEvent(event);
		if (vevent !== null) parts.push(vevent);
	}
	parts.push("END:VCALENDAR");
	return `${parts.join("\r\n")}\r\n`;
}
