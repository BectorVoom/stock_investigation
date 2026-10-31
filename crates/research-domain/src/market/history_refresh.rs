//! Port of `packages/domain/src/market/historyRefresh.ts` (ADR-0044): the
//! incremental refresh of a stored market history. Pure: dates are
//! `YYYY-MM-DD` strings (they order as text), instants are epoch ms passed in.
//! Modelled in `formal/ResearchFormal/HistoryRefresh.lean` and replayed from
//! the TypeScript's vectors (`vectors/domain/history.json`).
//!
//! A refresh fetches only the newest part of a series — the window that
//! starts at the **anchor**, the [`HISTORY_OVERLAP_OBSERVATIONS`]-th newest
//! stored observation — and the anchor proves the older stored history still
//! matches the provider: when the window's answer holds the anchor's date with
//! the same value, everything older than the anchor is kept as stored. When it
//! does not (a split re-adjusted every older close, an agency revised a year
//! back, the window was cut short), the runner fetches the full history
//! instead and the stored series is replaced.
//!
//! The API decides the request ([`history_refresh_request`]), the runner the
//! fetches and the write ([`first_history_fetch`], [`history_outcome`]), and
//! the database applies the write; [`merge_history`] is that write's
//! reference semantics, which the SQL must match.
//!
//! Dates compare as Rust `str` (UTF-8 bytes), the TypeScript as UTF-16 code
//! units; both orders agree on ASCII, which every ISO date is.

use std::collections::HashSet;

/// Stored observations a window refresh re-reads (the anchor included).
pub const HISTORY_OVERLAP_OBSERVATIONS: usize = 32;
/// Days after which a series is fetched in full again although its anchor holds.
pub const HISTORY_FULL_CHECK_DAYS: u32 = 7;

const DAY_MS: f64 = 86_400_000.0;

/// One dated value (`HistoryPoint`).
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryPoint {
	/// `YYYY-MM-DD`.
	pub observed_on: String,
	/// The value.
	pub value: f64,
}

/// A dated value the history rules can read without copying it: the
/// runner decides on the provider's points in place (one answer is up to
/// 800 of them).
pub trait DatedValue {
	/// `YYYY-MM-DD`.
	fn observed_on(&self) -> &str;
	/// The value.
	fn value(&self) -> f64;
}

impl DatedValue for HistoryPoint {
	fn observed_on(&self) -> &str {
		&self.observed_on
	}
	fn value(&self) -> f64 {
		self.value
	}
}

/// What a market-refresh claim tells the runner about one series.
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryRefreshRequest {
	/// The stored observation the window must reproduce; `None` when nothing usable is stored.
	pub anchor: Option<HistoryPoint>,
	/// True when the series is due a full fetch although it has an anchor.
	pub full_check: bool,
}

/// How the fetched points are stored. `replace_from` is the first date whose
/// stored rows the answer replaces (rows on or after it that the answer does
/// not hold are deleted; older rows are kept); `None` replaces every stored
/// row of the series. A window write always has a date (its anchor).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HistoryWrite {
	/// A window fetch whose anchor held.
	Window {
		/// The anchor's date.
		replace_from: String,
	},
	/// A full fetch.
	Full {
		/// The oldest fetched date when the anchor held, else `None` (replace everything).
		replace_from: Option<String>,
	},
}

impl HistoryWrite {
	/// The first replaced date; `None` replaces every stored row.
	#[must_use]
	pub fn replace_from(&self) -> Option<&str> {
		match self {
			Self::Window { replace_from } => Some(replace_from),
			Self::Full { replace_from } => replace_from.as_deref(),
		}
	}
}

/// The provider request the runner sends first: from the anchor's date, or everything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryFetch<'a> {
	/// From this date (inclusive).
	Window {
		/// The anchor's date.
		from: &'a str,
	},
	/// The full history (the newest the provider's cap allows).
	Full,
}

/// After a fetch: store the points (with how), or fetch the full history and decide again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HistoryOutcome {
	/// Store the points; `None` merges (no stored row is deleted).
	Store {
		/// How the points replace the stored history.
		write: Option<HistoryWrite>,
	},
	/// Fetch the full history and decide again with [`HistoryFetch::Full`].
	RefetchFull,
}

/// The claim's request for one series (API side). `anchor` is the
/// [`HISTORY_OVERLAP_OBSERVATIONS`]-th newest stored observation (the oldest
/// stored one when fewer are stored), or `None` when none is stored.
/// `history_checked_at_ms` is when the series was last fetched in full
/// (`None`: never, or the stamp did not parse); a full check is due when that
/// is `None`, not finite or at least [`HISTORY_FULL_CHECK_DAYS`] old. A stamp
/// in the future (a clock step back) is not due.
#[must_use]
pub fn history_refresh_request(
	anchor: Option<HistoryPoint>,
	history_checked_at_ms: Option<f64>,
	now_ms: f64,
) -> HistoryRefreshRequest {
	let Some(anchor) = anchor else {
		return HistoryRefreshRequest {
			anchor: None,
			full_check: false,
		};
	};
	let due = history_checked_at_ms.is_none_or(|checked| {
		!checked.is_finite() || now_ms - checked >= f64::from(HISTORY_FULL_CHECK_DAYS) * DAY_MS
	});
	HistoryRefreshRequest {
		anchor: Some(anchor),
		full_check: due,
	}
}

/// The first provider request for a claimed series (runner side).
#[must_use]
pub fn first_history_fetch(request: &HistoryRefreshRequest) -> HistoryFetch<'_> {
	match &request.anchor {
		Some(anchor) if !request.full_check => HistoryFetch::Window {
			from: &anchor.observed_on,
		},
		_ => HistoryFetch::Full,
	}
}

/// True when ascending, date-unique `points` hold the anchor's date with
/// exactly the anchor's value. Binary search: O(log n). The probe sequence is
/// the TypeScript's (`mid = (lo + hi) >>> 1` over an inclusive `hi`), so even
/// an input breaking the precondition answers the same.
#[must_use]
pub fn anchor_confirmed<P: DatedValue>(anchor: &HistoryPoint, points: &[P]) -> bool {
	let mut lo = 0usize;
	// Exclusive bound: the TypeScript's inclusive `hi` plus one, so it never goes below zero.
	let mut hi = points.len();
	while lo < hi {
		let mid = (lo + hi - 1) / 2;
		let Some(point) = points.get(mid) else {
			return false;
		};
		match point.observed_on().cmp(anchor.observed_on.as_str()) {
			// `==`: 0 and -0 are the same stored number (SQLite keeps no sign of zero).
			std::cmp::Ordering::Equal => return point.value() == anchor.value,
			std::cmp::Ordering::Less => lo = mid + 1,
			std::cmp::Ordering::Greater => hi = mid,
		}
	}
	false
}

/// What to do with the ascending, date-unique `points` one fetch returned
/// (runner side):
///
/// - window fetch, anchor reproduced → store, replacing from the anchor's date;
/// - window fetch, anchor missing or changed → fetch the full history;
/// - full fetch, nothing stored (no anchor) → store, replacing everything;
/// - full fetch, anchor reproduced → store, replacing from the oldest fetched
///   date (older stored rows predate the answer and stay);
/// - full fetch, anchor missing or changed → store, replacing everything (the
///   older stored rows belong to a superseded version of the series).
///
/// An empty answer replaces nothing (`write` `None`: plain merge), so a
/// provider that answers with no points never empties the stored history.
#[must_use]
pub fn history_outcome<P: DatedValue>(
	request: &HistoryRefreshRequest,
	fetched: HistoryFetch<'_>,
	points: &[P],
) -> HistoryOutcome {
	let confirmed = |points: &[P]| {
		request
			.anchor
			.as_ref()
			.is_some_and(|anchor| anchor_confirmed(anchor, points))
	};
	if let HistoryFetch::Window { .. } = fetched {
		return match &request.anchor {
			Some(anchor) if confirmed(points) => HistoryOutcome::Store {
				write: Some(HistoryWrite::Window {
					replace_from: anchor.observed_on.clone(),
				}),
			},
			_ => HistoryOutcome::RefetchFull,
		};
	}
	let Some(first) = points.first() else {
		return HistoryOutcome::Store { write: None };
	};
	let replace_from = confirmed(points).then(|| first.observed_on().to_owned());
	HistoryOutcome::Store {
		write: Some(HistoryWrite::Full { replace_from }),
	}
}

/// The reference semantics of storing fetched points (what the SQL does):
/// stored rows the write replaces are dropped unless the answer holds their
/// date, every fetched point is stored with its fetched value, and the result
/// is ascending by date with one row per date, cut to the newest
/// `max_stored`. `write` `None` merges (no stored row is dropped). Inputs are
/// ascending and date-unique.
#[must_use]
pub fn merge_history(
	stored: &[HistoryPoint],
	fetched: &[HistoryPoint],
	write: Option<&HistoryWrite>,
	max_stored: usize,
) -> Vec<HistoryPoint> {
	let fetched_dates: HashSet<&str> = fetched
		.iter()
		.map(|point| point.observed_on.as_str())
		.collect();
	let kept: Vec<&HistoryPoint> = stored
		.iter()
		.filter(|point| {
			if fetched_dates.contains(point.observed_on.as_str()) {
				return false;
			}
			match write {
				None => true,
				Some(write) => write
					.replace_from()
					.is_some_and(|from| point.observed_on.as_str() < from),
			}
		})
		.collect();
	let mut merged: Vec<HistoryPoint> = Vec::with_capacity(kept.len() + fetched.len());
	let (mut i, mut j) = (0, 0);
	loop {
		match (kept.get(i), fetched.get(j)) {
			(None, None) => break,
			// Equal dates cannot meet (kept rows are not fetched dates); the
			// fetched point goes first on a tie, as in the TypeScript.
			(Some(a), Some(b)) if b.observed_on <= a.observed_on => {
				merged.push(b.clone());
				j += 1;
			}
			(Some(a), _) => {
				merged.push((*a).clone());
				i += 1;
			}
			(None, Some(b)) => {
				merged.push(b.clone());
				j += 1;
			}
		}
	}
	if merged.len() > max_stored {
		merged.drain(..merged.len() - max_stored);
	}
	merged
}

#[cfg(test)]
mod tests {
	use super::*;

	fn point(observed_on: &str, value: f64) -> HistoryPoint {
		HistoryPoint {
			observed_on: observed_on.to_owned(),
			value,
		}
	}

	#[test]
	fn the_first_fetch_is_a_window_only_with_an_anchor_and_no_full_check() {
		let anchor = point("2026-09-01", 1.0);
		let window = history_refresh_request(Some(anchor.clone()), Some(0.0), 1.0);
		assert_eq!(
			first_history_fetch(&window),
			HistoryFetch::Window { from: "2026-09-01" }
		);
		let due = history_refresh_request(Some(anchor), Some(0.0), 7.0 * DAY_MS);
		assert!(due.full_check);
		assert_eq!(first_history_fetch(&due), HistoryFetch::Full);
		let none = history_refresh_request(None, None, 0.0);
		assert_eq!(first_history_fetch(&none), HistoryFetch::Full);
		assert!(!none.full_check);
	}

	#[test]
	fn outcomes_follow_the_anchor() {
		let points = [point("2026-09-01", 1.0), point("2026-09-02", 2.0)];
		let held = HistoryRefreshRequest {
			anchor: Some(point("2026-09-02", 2.0)),
			full_check: false,
		};
		assert_eq!(
			history_outcome(&held, first_history_fetch(&held), &points),
			HistoryOutcome::Store {
				write: Some(HistoryWrite::Window {
					replace_from: "2026-09-02".to_owned()
				})
			}
		);
		assert_eq!(
			history_outcome(&held, HistoryFetch::Full, &points),
			HistoryOutcome::Store {
				write: Some(HistoryWrite::Full {
					replace_from: Some("2026-09-01".to_owned())
				})
			}
		);
		let changed = HistoryRefreshRequest {
			anchor: Some(point("2026-09-02", 2.5)),
			full_check: false,
		};
		assert_eq!(
			history_outcome(&changed, first_history_fetch(&changed), &points),
			HistoryOutcome::RefetchFull
		);
		assert_eq!(
			history_outcome(&changed, HistoryFetch::Full, &points),
			HistoryOutcome::Store {
				write: Some(HistoryWrite::Full { replace_from: None })
			}
		);
		assert_eq!(
			history_outcome::<HistoryPoint>(&changed, HistoryFetch::Full, &[]),
			HistoryOutcome::Store { write: None }
		);
	}

	#[test]
	fn zero_and_negative_zero_are_one_stored_value() {
		assert!(anchor_confirmed(
			&point("2026-09-01", 0.0),
			&[point("2026-09-01", -0.0)]
		));
		assert!(!anchor_confirmed(
			&point("2026-09-01", f64::NAN),
			&[point("2026-09-01", f64::NAN)]
		));
	}

	#[test]
	fn a_merge_replaces_from_its_date_and_keeps_the_newest() {
		let stored = [
			point("2026-01-01", 1.0),
			point("2026-01-02", 2.0),
			point("2026-01-03", 3.0),
		];
		let fetched = [point("2026-01-02", 20.0), point("2026-01-04", 4.0)];
		let write = HistoryWrite::Window {
			replace_from: "2026-01-02".to_owned(),
		};
		assert_eq!(
			merge_history(&stored, &fetched, Some(&write), 10),
			[
				point("2026-01-01", 1.0),
				point("2026-01-02", 20.0),
				point("2026-01-04", 4.0)
			]
		);
		assert_eq!(
			merge_history(&stored, &fetched, None, 2),
			[point("2026-01-03", 3.0), point("2026-01-04", 4.0)]
		);
		let everything = HistoryWrite::Full { replace_from: None };
		assert_eq!(
			merge_history(&stored, &fetched, Some(&everything), 10),
			fetched
		);
		assert!(merge_history(&stored, &fetched, None, 0).is_empty());
	}
}
