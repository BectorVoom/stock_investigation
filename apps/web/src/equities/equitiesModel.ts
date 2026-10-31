import type { EquityCompanyView } from "@research/contracts";
import { formatStockId } from "@research/domain";
import type { Locale, MessagesOf } from "@research/i18n";
import type { PollSignal } from "../lib/polling.ts";
import type { equitiesMessages } from "./equities.messages.ts";

export { isWordedSyncFailure, type WordedSyncFailureCode } from "./syncFailureCodes.ts";

/**
 * Pure helpers of the Equities page (ADR-0048 §8): what a company is called,
 * how its sync status reads, and how the page polls.
 */

type EquitiesText = MessagesOf<typeof equitiesMessages>;

/** The company's name, or its symbol until the provider or the stock list names it. */
export function companyName(company: EquityCompanyView): string {
	return company.name ?? company.symbol;
}

/** The listing's stock id (`us:AAPL`, `jp:7974`), as the stock directory names it. */
export function companyStockId(company: EquityCompanyView): string {
	return formatStockId(company.market, company.symbol);
}

/** True while the runner has a company's sync queued or running. */
export function syncInProgress(company: EquityCompanyView): boolean {
	return company.sync.status === "queued" || company.sync.status === "running";
}

/**
 * How soon the page polls the list again: fast while a sync runs, the
 * queued ceiling while one waits for a runner, else nothing to watch
 * (the page then only re-checks on its visible ticker).
 */
export function companiesPollSignal(companies: readonly EquityCompanyView[]): PollSignal | null {
	if (companies.some((company) => company.sync.status === "running")) return "active";
	if (companies.some((company) => company.sync.status === "queued")) return "queued";
	return null;
}

const UNITS: readonly { readonly unit: Intl.RelativeTimeFormatUnit; readonly ms: number }[] = [
	{ unit: "day", ms: 86_400_000 },
	{ unit: "hour", ms: 3_600_000 },
	{ unit: "minute", ms: 60_000 },
];

/** "5 minutes ago", "2 hours ago", "yesterday" (「5 分前」…); "now" under a minute. */
export function relativeTime(iso: string, nowMs: number, locale: Locale): string {
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return iso;
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	const delta = at - nowMs;
	for (const { unit, ms } of UNITS) {
		if (Math.abs(delta) >= ms) return format.format(Math.round(delta / ms), unit);
	}
	return format.format(0, "second");
}

const MONTHS_EN = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

/** A fiscal year end "MM-DD" as "Sep 28" / 「9月28日」; the text as it came otherwise. */
export function formatFiscalYearEnd(monthDay: string, locale: Locale): string {
	const match = /^(\d{2})-(\d{2})$/.exec(monthDay);
	if (match === null) return monthDay;
	const month = Number(match[1]);
	const day = Number(match[2]);
	const name = MONTHS_EN[month - 1];
	if (name === undefined) return monthDay;
	return locale === "ja" ? `${month}月${day}日` : `${name} ${day}`;
}

/** The status line of a company's sync: status, EDINET phase, and when it last succeeded. */
export function syncStatusText(
	company: EquityCompanyView,
	nowMs: number,
	locale: Locale,
	text: EquitiesText,
): string {
	const sync = company.sync;
	const parts = [text.status(sync.status)];
	if (sync.phase !== null && sync.status !== "failed") parts.push(text.phase(sync.phase));
	if (sync.lastSucceededAt !== null) {
		parts.push(text.lastSynced(relativeTime(sync.lastSucceededAt, nowMs, locale)));
	} else if (sync.lastCheckedAt !== null) {
		parts.push(text.lastChecked(relativeTime(sync.lastCheckedAt, nowMs, locale)));
	}
	return parts.join(" · ");
}

/**
 * The last failure in words, or null when the last sync did not fail. A
 * source that is not configured names the variable to set in the runner's
 * env file (ADR-0048 §9); the provider's HTTP status is shown unchanged
 * (ADR-0037).
 */
export function syncFailureText(company: EquityCompanyView, text: EquitiesText): string | null {
	const failure = company.sync.failure;
	if (failure === null || company.sync.status !== "failed") return null;
	const reason =
		failure.code === "FINANCIAL_SOURCE_NOT_CONFIGURED"
			? text.notConfigured(company.provider)
			: text.failureCode(failure.code);
	return failure.upstreamStatus === null
		? reason
		: `${reason} ${text.upstreamStatus(failure.upstreamStatus)}`;
}
