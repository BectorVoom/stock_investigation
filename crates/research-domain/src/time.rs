//! ISO-8601 instants ↔ epoch milliseconds — port of `packages/domain/src/time.ts`.
//!
//! Both directions are JavaScript's own (`Date.parse`, `toISOString`), so
//! they come from `research_js::date` and inherit V8's leniency: a string
//! without a zone is local time, `Feb 30` rolls over, RFC 822 text parses.

use research_js::date::{self, LocalTimeZone, SystemTimeZone};

/// `isoToEpochMs`: epoch milliseconds for the instant `Date.parse` reads in
/// `iso` (in the operating system's zone when the text has none), or `None`
/// when it is not a valid instant.
#[must_use]
pub fn iso_to_epoch_ms(iso: &str) -> Option<i64> {
	iso_to_epoch_ms_in(iso, &SystemTimeZone)
}

/// [`iso_to_epoch_ms`] with an explicit local zone (tests, deterministic
/// callers).
#[must_use]
pub fn iso_to_epoch_ms_in(iso: &str, zone: &dyn LocalTimeZone) -> Option<i64> {
	date::parse_epoch_ms(iso, zone)
}

/// `epochMsToIso`: `new Date(ms).toISOString()`. `None` where JavaScript
/// throws a `RangeError` (beyond ±8.64e15 ms).
#[must_use]
pub fn epoch_ms_to_iso(ms: i64) -> Option<String> {
	date::epoch_ms_to_iso(ms)
}

#[cfg(test)]
mod tests {
	use super::*;
	use research_js::date::{FixedOffset, Utc};

	#[test]
	fn round_trips_instants() {
		assert_eq!(
			iso_to_epoch_ms_in("1970-01-01T00:00:00.000Z", &Utc),
			Some(0)
		);
		assert_eq!(
			iso_to_epoch_ms_in("2026-10-11T03:00:00.000Z", &Utc),
			Some(1_791_687_600_000)
		);
		assert_eq!(
			epoch_ms_to_iso(1_791_687_600_000).as_deref(),
			Some("2026-10-11T03:00:00.000Z")
		);
		assert_eq!(
			epoch_ms_to_iso(-1).as_deref(),
			Some("1969-12-31T23:59:59.999Z")
		);
		assert_eq!(
			epoch_ms_to_iso(8_640_000_000_000_000).as_deref(),
			Some("+275760-09-13T00:00:00.000Z")
		);
		assert_eq!(epoch_ms_to_iso(8_640_000_000_000_001), None);
		assert_eq!(epoch_ms_to_iso(i64::MIN), None);
	}

	#[test]
	fn rejects_what_date_parse_rejects() {
		assert_eq!(iso_to_epoch_ms_in("not a date", &Utc), None);
		assert_eq!(iso_to_epoch_ms_in("2026-13-01", &Utc), None);
		assert_eq!(iso_to_epoch_ms_in("", &Utc), None);
		assert_eq!(
			iso_to_epoch_ms_in("+275760-09-13T00:00:00.001Z", &Utc),
			None
		);
	}

	#[test]
	fn reads_zoneless_date_times_as_local_time() {
		let tokyo = FixedOffset::east_minutes(540);
		assert_eq!(
			iso_to_epoch_ms_in("2026-10-11T12:00:00", &tokyo),
			iso_to_epoch_ms_in("2026-10-11T03:00:00Z", &Utc)
		);
		assert!(iso_to_epoch_ms("2026-10-11T12:00:00").is_some());
	}
}
