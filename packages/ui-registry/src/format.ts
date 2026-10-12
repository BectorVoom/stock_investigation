/**
 * Returns a normalized href only for credential-free https URLs. Everything
 * else (javascript:, data:, http:, malformed) yields null so callers render
 * plain text instead of a link (SEC-001 / section 9.6).
 */
export function safeHttpsUrl(value: string): string | null {
	if (!URL.canParse(value)) return null;
	const url = new URL(value);
	if (url.protocol !== "https:") return null;
	if (url.username !== "" || url.password !== "") return null;
	return url.href;
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar date (UTC) of an ISO date or instant; null when the text is not a date. */
export function formatIsoDate(iso: string): string | null {
	if (ISO_DATE_ONLY.test(iso)) return iso;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const compactFormat = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 2,
});

export function formatNumber(value: number): string {
	return numberFormat.format(value);
}

/**
 * Axis tick text: plain below 1,000, compact (1K, 2.5M) from there up, and
 * scientific notation for magnitudes no compact suffix can express legibly.
 */
export function formatAxisTick(value: number): string {
	const magnitude = Math.abs(value);
	if (magnitude >= 1e15 || (magnitude > 0 && magnitude < 1e-4)) return value.toExponential(2);
	return magnitude >= 1000 ? compactFormat.format(value) : numberFormat.format(value);
}

export function truncateLabel(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}
