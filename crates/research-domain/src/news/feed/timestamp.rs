//! `parseFeedTimestamp` of `packages/domain/src/news/feed.ts`.
//!
//! Only ISO 8601 and RFC 822 shapes are accepted, and a timestamp without a
//! zone is read as UTC — never in the machine's local zone — so the Worker
//! and the runner agree (ARCH-011). The candidate is then handed to V8's
//! `Date.parse` (`research_js::date`), whose roll-overs (Feb 30 → Mar 2,
//! `24:00`, seconds 60) the result keeps.
//!
//! The regexes are the TypeScript ones with JavaScript semantics spelled
//! out: `\d` is `[0-9]`, `\s` is JavaScript's white-space set, and `/i` only
//! folds ASCII letters (so `ſ` never matches `s`).

use regex::Regex;
use research_js::date::{self, LocalTimeZone, SystemTimeZone};
use research_js::whitespace;
use std::sync::LazyLock;

/// JavaScript `\s`.
const JS_SPACE: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

/// `/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?))?\s*(Z|[+-]\d{2}:?\d{2})?$/i`
static ISO_DATE_TIME: LazyLock<Option<Regex>> = LazyLock::new(|| {
	Regex::new(&format!(
		r"^([0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}})(?:[Tt ]([0-9]{{2}}:[0-9]{{2}}(?::[0-9]{{2}}(?:\.[0-9]{{1,9}})?)?))?{JS_SPACE}*([Zz]|[+-][0-9]{{2}}:?[0-9]{{2}})?$"
	))
	.ok()
});

/// `/^(?:[A-Za-z]{3},\s*)?(\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?)\s*(GMT|UTC|UT|Z|[ECMP][SD]T|[+-]\d{4})?$/i`
static RFC_822_DATE_TIME: LazyLock<Option<Regex>> = LazyLock::new(|| {
	Regex::new(&format!(
		r"^(?:[A-Za-z]{{3}},{s}*)?([0-9]{{1,2}}{s}+[A-Za-z]{{3}}{s}+[0-9]{{4}}{s}+[0-9]{{2}}:[0-9]{{2}}(?::[0-9]{{2}})?){s}*([Gg][Mm][Tt]|[Uu][Tt][Cc]|[Uu][Tt]|[Zz]|[EeCcMmPp][SsDd][Tt]|[+-][0-9]{{4}})?$",
		s = JS_SPACE
	))
	.ok()
});

/// `parseFeedTimestamp` in the operating system's zone (the candidates
/// always carry a zone or are date-only, so the zone never changes the
/// result; it is a parameter only to keep `Date.parse` exact).
#[must_use]
pub fn parse_feed_timestamp(text: Option<&str>) -> Option<String> {
	parse_feed_timestamp_in(text, &SystemTimeZone)
}

/// [`parse_feed_timestamp`] with an explicit local zone.
#[must_use]
pub fn parse_feed_timestamp_in(text: Option<&str>, zone: &dyn LocalTimeZone) -> Option<String> {
	let trimmed = whitespace::trim(text?);
	let candidate = if let Some(iso) = ISO_DATE_TIME
		.as_ref()
		.and_then(|regex| regex.captures(trimmed))
	{
		let date = iso.get(1).map_or("", |found| found.as_str());
		match iso.get(2) {
			None => date.to_owned(),
			Some(time) => {
				let zone_text = iso.get(3).map_or("Z", |found| found.as_str());
				format!("{date}T{}{zone_text}", time.as_str())
			}
		}
	} else {
		let rfc = RFC_822_DATE_TIME
			.as_ref()
			.and_then(|regex| regex.captures(trimmed))?;
		let stamp = rfc.get(1).map_or("", |found| found.as_str());
		let zone_text = rfc.get(2).map_or("UTC", |found| found.as_str());
		format!("{stamp} {zone_text}")
	};
	date::epoch_ms_to_iso(date::parse_epoch_ms(&candidate, zone)?)
}

#[cfg(test)]
mod tests {
	use super::*;
	use research_js::date::Utc;

	fn parse(text: &str) -> Option<String> {
		parse_feed_timestamp_in(Some(text), &Utc)
	}

	#[test]
	fn patterns_compile() {
		assert!(ISO_DATE_TIME.is_some());
		assert!(RFC_822_DATE_TIME.is_some());
	}

	#[test]
	fn converts_feed_shapes_to_utc() {
		assert_eq!(
			parse("Sat, 10 Oct 2026 21:00:00 +0900").as_deref(),
			Some("2026-10-10T12:00:00.000Z")
		);
		assert_eq!(
			parse("2026-10-10T21:00:00+09:00").as_deref(),
			Some("2026-10-10T12:00:00.000Z")
		);
		assert_eq!(
			parse("2026-10-10 12:00").as_deref(),
			Some("2026-10-10T12:00:00.000Z")
		);
		assert_eq!(
			parse("Sat, 10 Oct 2026 12:00:00").as_deref(),
			Some("2026-10-10T12:00:00.000Z")
		);
		assert_eq!(
			parse("2026-02-30").as_deref(),
			Some("2026-03-02T00:00:00.000Z")
		);
		assert_eq!(parse("yesterday-ish"), None);
		assert_eq!(parse("32 Foo 2026"), None);
		assert_eq!(parse_feed_timestamp_in(None, &Utc), None);
	}
}
