//! `Date.prototype.toISOString` for the log line's `at`.
//!
//! TEMPORARY (ADR-0030 wave A): the shared implementation is
//! `research_js::date` / `research_domain::time`, written in parallel; this
//! private copy covers the instants a running process sees (years
//! 0000..=9999) and is replaced at the merge.

/// Days since 1970-01-01 → (year, month, day), H. Hinnant's `civil_from_days`.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
	let shifted = days + 719_468;
	let era = shifted.div_euclid(146_097);
	let day_of_era = shifted - era * 146_097;
	let year_of_era =
		(day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
	let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
	let shifted_month = (5 * day_of_year + 2) / 153;
	let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
	let month = if shifted_month < 10 {
		shifted_month + 3
	} else {
		shifted_month - 9
	};
	(year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

/// `new Date(ms).toISOString()`.
pub(crate) fn epoch_ms_to_iso(ms: i64) -> String {
	let days = ms.div_euclid(86_400_000);
	let in_day = ms.rem_euclid(86_400_000);
	let (year, month, day) = civil_from_days(days);
	format!(
		"{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
		in_day / 3_600_000,
		in_day / 60_000 % 60,
		in_day / 1000 % 60,
		in_day % 1000
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn formats_like_to_iso_string() {
		assert_eq!(epoch_ms_to_iso(0), "1970-01-01T00:00:00.000Z");
		assert_eq!(
			epoch_ms_to_iso(1_791_676_800_000),
			"2026-10-11T00:00:00.000Z"
		);
		assert_eq!(epoch_ms_to_iso(-1), "1969-12-31T23:59:59.999Z");
	}
}
