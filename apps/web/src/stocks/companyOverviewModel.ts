import type { OverviewEvidence, OverviewSourceId } from "@research/contracts";
import type { Locale } from "@research/i18n";

/**
 * Pure helpers of the company overview (事業概要, ADR-0064): the fiscal year
 * end as a month, the day an instant falls on, and the source ids a field
 * cites.
 */

/** A stored fiscal year end "MM-DD" as its month ("September", "9月"); null when malformed. */
export function fiscalMonthText(monthDay: string, locale: Locale): string | null {
	const month = Number(monthDay.slice(0, 2));
	if (!Number.isInteger(month) || month < 1 || month > 12) return null;
	return new Date(Date.UTC(2000, month - 1, 1)).toLocaleString(
		locale === "ja" ? "ja-JP" : "en-US",
		{ month: "long", timeZone: "UTC" },
	);
}

/**
 * The day an ISO-8601 instant falls on in this browser's time zone,
 * "YYYY-MM-DD" (sv-SE formats dates that way): an overview written at
 * 08:25 in Tokyo on Nov 3 is dated Nov 3, not Nov 2 as its UTC date says.
 */
export function localDayOf(isoDateTime: string): string {
	return new Date(isoDateTime).toLocaleDateString("sv-SE");
}

/** The distinct source ids of a field's evidence, in id order (S1 before S2). */
export function sourceIdsOf(evidence: readonly OverviewEvidence[]): OverviewSourceId[] {
	return [...new Set(evidence.map((item) => item.source))].sort();
}

/**
 * A 事業内容 statement as a sentence of the summary paragraph: it ends with
 * 「。」 (Japanese) or a full stop (English) when it has no closing mark
 * already, so consecutive statements read as one paragraph.
 */
export function asSentence(text: string, locale: Locale): string {
	const trimmed = text.trim();
	if (/[。．.!?！？」）)]$/.test(trimmed)) return trimmed;
	return locale === "ja" ? `${trimmed}。` : `${trimmed}.`;
}
