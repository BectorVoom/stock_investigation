/** Restores a shortened generated citation only from the current run's shown pack.
 * An unresolved reference stays unresolved; this never supplies evidence or verifies a quote.
 */
export function resolveClaimEvidenceId(
	runId: string,
	reference: string,
	shownIds: ReadonlySet<string>,
): string {
	if (shownIds.has(reference) || !/^ev[1-9]\d*$/.test(reference)) return reference;
	const canonical = `${runId}_${reference}`;
	return shownIds.has(canonical) ? canonical : reference;
}
