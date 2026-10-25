//! The upstream status reported with `ALL_TOOL_CALLS_FAILED`
//! (docs/rule/error_handling.md §4a rule 6; `toolErrorStatus` in
//! `packages/application/src/research/pipeline.ts`).

use std::collections::HashMap;

/// How often one status was seen and the index of its latest call.
#[derive(Clone, Copy, Debug, Default)]
struct Seen {
	count: u64,
	last: u64,
}

/// Per sanitized tool error code: each upstream status the failed calls
/// carried, how often, and the index of the latest call that carried it.
#[derive(Debug, Default)]
pub(super) struct ToolErrorStatuses {
	by_code: HashMap<String, HashMap<u16, Seen>>,
}

impl ToolErrorStatuses {
	/// Records the status of a call that failed with `code`; `call` is the
	/// call's 1-based index among the executed calls. A failure without a
	/// status records nothing.
	pub(super) fn record(&mut self, code: &str, status: Option<u16>, call: u64) {
		let Some(status) = status else {
			return;
		};
		let seen = self
			.by_code
			.entry(code.to_owned())
			.or_default()
			.entry(status)
			.or_default();
		seen.count = seen.count.saturating_add(1);
		seen.last = call;
	}

	/// The most frequent status among the calls that failed with `code`, the
	/// latest call winning a tie; `None` when none of them carried one.
	pub(super) fn most_frequent(&self, code: Option<&str>) -> Option<u16> {
		let statuses = self.by_code.get(code?)?;
		// Each call index is unique, so (count, last) orders every status
		// totally: the result never depends on the map's iteration order.
		statuses
			.iter()
			.max_by_key(|(_, seen)| (seen.count, seen.last))
			.map(|(status, _)| *status)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reports_the_most_frequent_status_of_the_reported_code() {
		let mut statuses = ToolErrorStatuses::default();
		statuses.record("HTTP_ERROR", Some(503), 1);
		statuses.record("HTTP_ERROR", Some(529), 2);
		statuses.record("HTTP_ERROR", Some(503), 3);
		// Another code's statuses never count for this one.
		statuses.record("SEARCH_FAILED", Some(529), 4);
		statuses.record("SEARCH_FAILED", Some(529), 5);
		assert_eq!(statuses.most_frequent(Some("HTTP_ERROR")), Some(503));
		assert_eq!(statuses.most_frequent(Some("SEARCH_FAILED")), Some(529));
	}

	#[test]
	fn the_latest_call_wins_a_tie() {
		let mut statuses = ToolErrorStatuses::default();
		statuses.record("HTTP_ERROR", Some(404), 1);
		statuses.record("HTTP_ERROR", Some(503), 2);
		statuses.record("HTTP_ERROR", Some(404), 3);
		statuses.record("HTTP_ERROR", Some(503), 4);
		assert_eq!(statuses.most_frequent(Some("HTTP_ERROR")), Some(503));
		statuses.record("HTTP_ERROR", Some(404), 5);
		assert_eq!(statuses.most_frequent(Some("HTTP_ERROR")), Some(404));
	}

	#[test]
	fn carries_none_when_no_failed_call_had_a_status() {
		let mut statuses = ToolErrorStatuses::default();
		statuses.record("TIMEOUT", None, 1);
		assert_eq!(statuses.most_frequent(Some("TIMEOUT")), None);
		assert_eq!(statuses.most_frequent(Some("MAX_WALL_CLOCK")), None);
		assert_eq!(statuses.most_frequent(None), None);
	}
}
