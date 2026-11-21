/**
 * Verified row selection for analysis comparison tables. A candidate row is
 * admitted to a published canvas table only when it carries verified backing
 * (a supported claim or verified passage) and contains no number absent from
 * its verified backing. Lean-verified in `ComparisonTable.lean`.
 */

export interface ComparisonRowCandidate {
	readonly hasVerifiedSupport: boolean;
	readonly hasStrayNumber: boolean;
}

/**
 * Returns the 0-based indices of candidate rows that have verified backing and
 * no unsupported numbers, in input order, capped at `maxRows`.
 */
export function selectVerifiedComparisonRowIndices(
	candidates: readonly ComparisonRowCandidate[],
	maxRows: number,
): readonly number[] {
	const limit = Math.max(0, Math.trunc(maxRows));
	if (limit === 0) return [];
	const selected: number[] = [];
	for (let index = 0; index < candidates.length && selected.length < limit; index += 1) {
		const candidate = candidates[index];
		if (candidate?.hasVerifiedSupport && !candidate.hasStrayNumber) {
			selected.push(index);
		}
	}
	return selected;
}
