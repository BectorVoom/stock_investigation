//! Verified row selection for analysis comparison tables (`comparisonTable.ts`).

/// Discrete verification flags of one candidate comparison-table row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComparisonRowCandidate {
	/// Whether at least one supported claim or verified evidence passage backs the row.
	pub has_verified_support: bool,
	/// Whether any number token in the row's cells is absent from its verified backing.
	pub has_stray_number: bool,
}

/// 0-based indices of rows with verified backing and no stray numbers, capped at `max_rows`.
#[must_use]
pub fn select_verified_comparison_row_indices(
	candidates: &[ComparisonRowCandidate],
	max_rows: usize,
) -> Vec<usize> {
	if max_rows == 0 {
		return Vec::new();
	}
	candidates
		.iter()
		.enumerate()
		.filter(|(_, c)| c.has_verified_support && !c.has_stray_number)
		.map(|(index, _)| index)
		.take(max_rows)
		.collect()
}
