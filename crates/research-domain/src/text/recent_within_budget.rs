//! Port of `packages/domain/src/text/recentWithinBudget.ts` (proved in
//! `formal/`, replayed from its vectors).

/// `Number.MAX_SAFE_INTEGER`: larger values are not safe integers in the
/// TypeScript, which answers 0 for them.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// `recentCountWithinBudget`: how many of the most recent messages fit a
/// data-volume budget.
///
/// `sizes` holds per-message UTF-8 byte counts, oldest first. The answer is
/// the length of the longest suffix whose total is at most `budget` and whose
/// length is at most `max_items`: walk from the newest item backwards and stop
/// at the first item that does not fit, so the kept messages stay contiguous
/// (ARCH-009). Anything that is not a safe integer makes the answer 0: when
/// in doubt, send nothing (ARCH-017). (Negative and fractional values cannot
/// be expressed in `u64`.)
#[must_use]
pub fn recent_count_within_budget(sizes: &[u64], budget: u64, max_items: u64) -> usize {
	if budget > MAX_SAFE_INTEGER || max_items > MAX_SAFE_INTEGER {
		return 0;
	}
	// The TypeScript validates every size, even after it stopped counting.
	if sizes.iter().any(|size| *size > MAX_SAFE_INTEGER) {
		return 0;
	}
	let mut count = 0usize;
	let mut total = 0u64;
	for size in sizes.iter().rev() {
		if u64::try_from(count).unwrap_or(u64::MAX) >= max_items || total + size > budget {
			break;
		}
		total += size;
		count += 1;
	}
	count
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn keeps_the_newest_contiguous_suffix() {
		assert_eq!(recent_count_within_budget(&[], 10, 10), 0);
		assert_eq!(recent_count_within_budget(&[5, 1, 1], 2, 10), 2);
		assert_eq!(recent_count_within_budget(&[1, 9, 1], 5, 10), 1);
		assert_eq!(recent_count_within_budget(&[1, 1, 1], 10, 2), 2);
		assert_eq!(
			recent_count_within_budget(&[1, MAX_SAFE_INTEGER + 1], 10, 2),
			0
		);
		assert_eq!(recent_count_within_budget(&[1], MAX_SAFE_INTEGER + 1, 2), 0);
	}
}
