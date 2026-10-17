//! Port of `packages/domain/src/market/rateWindow.ts` (API-007), proved in
//! `formal/` and replayed from its vectors.

/// `rateWindowPermit`'s answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RatePermit {
	/// The request may go now.
	Allowed,
	/// Wait this long before asking again.
	Denied {
		/// Milliseconds until the oldest grant in the window expires.
		retry_after_ms: i64,
	},
}

/// `rateWindowPermit`: a request is allowed iff fewer than `max_per_window`
/// grants lie in `(now_ms − window_ms, now_ms]`.
#[must_use]
pub fn rate_window_permit(
	granted_at_ms: &[i64],
	now_ms: i64,
	max_per_window: usize,
	window_ms: i64,
) -> RatePermit {
	let floor = now_ms.saturating_sub(window_ms);
	let mut in_window = 0usize;
	let mut oldest: Option<i64> = None;
	for at in granted_at_ms
		.iter()
		.copied()
		.filter(|at| *at > floor && *at <= now_ms)
	{
		in_window += 1;
		oldest = Some(oldest.map_or(at, |current| current.min(at)));
	}
	match oldest {
		Some(oldest) if in_window >= max_per_window => RatePermit::Denied {
			retry_after_ms: oldest.saturating_add(window_ms).saturating_sub(now_ms),
		},
		_ => RatePermit::Allowed,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn counts_the_half_open_window() {
		assert_eq!(rate_window_permit(&[], 10, 1, 5), RatePermit::Allowed);
		assert_eq!(rate_window_permit(&[5], 10, 1, 5), RatePermit::Allowed);
		assert_eq!(
			rate_window_permit(&[9, 6], 10, 2, 5),
			RatePermit::Denied { retry_after_ms: 1 }
		);
		assert_eq!(rate_window_permit(&[11], 10, 1, 5), RatePermit::Allowed);
		assert_eq!(
			rate_window_permit(&[10], 10, 0, 5),
			RatePermit::Denied { retry_after_ms: 5 }
		);
		assert_eq!(rate_window_permit(&[], 10, 0, 5), RatePermit::Allowed);
	}
}
