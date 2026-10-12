/** Epoch milliseconds for an ISO-8601 instant, or null when the text is not a valid instant. */
export function isoToEpochMs(iso: string): number | null {
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

export function epochMsToIso(ms: number): string {
	return new Date(ms).toISOString();
}
