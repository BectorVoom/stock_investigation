//! The regular expressions of the contract schemas, matched by hand.
//!
//! Each `Pattern` keeps the JavaScript source zod prints in its default
//! message (`Invalid string: must match pattern /…/`). The matchers are
//! byte-level: every pattern here is ASCII-only, JavaScript `\d` is ASCII,
//! and `$` without the `m` flag matches only at the very end, so a byte
//! scan decides exactly what the regex decides (pinned by the vectors).

use crate::zod::Pattern;

fn all_bytes(text: &str, min: usize, max: usize, allowed: impl Fn(u8) -> bool) -> bool {
	(min..=max).contains(&text.len()) && text.bytes().all(allowed)
}

/// First byte by `first`, the rest by `rest`, total length `min..=max`.
fn head_tail(
	text: &str,
	min: usize,
	max: usize,
	first: impl Fn(u8) -> bool,
	rest: impl Fn(u8) -> bool,
) -> bool {
	let bytes = text.as_bytes();
	(min..=max).contains(&bytes.len())
		&& bytes
			.split_first()
			.is_some_and(|(head, tail)| first(*head) && tail.iter().all(|byte| rest(*byte)))
}

const fn is_upper_digit(byte: u8) -> bool {
	byte.is_ascii_uppercase() || byte.is_ascii_digit()
}

const fn is_lower_digit(byte: u8) -> bool {
	byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

/// `idSchema`: `/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/`.
pub static ID: Pattern = Pattern {
	source: "/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/",
	matches: |text| {
		head_tail(
			text,
			1,
			96,
			|byte| byte.is_ascii_alphanumeric(),
			|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'),
		)
	},
};

/// `agentIdSchema`: `/^[a-z][a-z0-9-]{1,31}$/`.
pub static AGENT_ID: Pattern = Pattern {
	source: "/^[a-z][a-z0-9-]{1,31}$/",
	matches: |text| {
		head_tail(
			text,
			2,
			32,
			|byte| byte.is_ascii_lowercase(),
			|byte| is_lower_digit(byte) || byte == b'-',
		)
	},
};

/// UI component id: `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`.
pub static COMPONENT_ID: Pattern = Pattern {
	source: "/^[A-Za-z][A-Za-z0-9_-]{0,63}$/",
	matches: |text| {
		head_tail(
			text,
			1,
			64,
			|byte| byte.is_ascii_alphabetic(),
			|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'),
		)
	},
};

/// UI component type: `/^[a-z][a-z0-9-]{1,39}$/`.
pub static COMPONENT_TYPE: Pattern = Pattern {
	source: "/^[a-z][a-z0-9-]{1,39}$/",
	matches: |text| {
		head_tail(
			text,
			2,
			40,
			|byte| byte.is_ascii_lowercase(),
			|byte| is_lower_digit(byte) || byte == b'-',
		)
	},
};

/// Ticker: `/^[A-Z0-9.-]{1,12}$/`.
pub static TICKER: Pattern = Pattern {
	source: "/^[A-Z0-9.-]{1,12}$/",
	matches: |text| {
		all_bytes(text, 1, 12, |byte| {
			is_upper_digit(byte) || matches!(byte, b'.' | b'-')
		})
	},
};

/// `currencySchema`: `/^[A-Z]{3}$/`.
pub static CURRENCY: Pattern = Pattern {
	source: "/^[A-Z]{3}$/",
	matches: |text| all_bytes(text, 3, 3, |byte| byte.is_ascii_uppercase()),
};

/// SHA-256 hex: `/^[0-9a-f]{64}$/`.
pub static SHA256_HEX: Pattern = Pattern {
	source: "/^[0-9a-f]{64}$/",
	matches: |text| {
		all_bytes(text, 64, 64, |byte| {
			byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
		})
	},
};

/// Dataset column key: `/^[A-Za-z][A-Za-z0-9_]{0,39}$/`.
pub static DATASET_KEY: Pattern = Pattern {
	source: "/^[A-Za-z][A-Za-z0-9_]{0,39}$/",
	matches: |text| {
		head_tail(
			text,
			1,
			40,
			|byte| byte.is_ascii_alphabetic(),
			|byte| byte.is_ascii_alphanumeric() || byte == b'_',
		)
	},
};

/// `STABLE_FAILURE_CODE_PATTERN`: `/^[A-Z][A-Z0-9_]{1,59}$/`.
pub static STABLE_FAILURE_CODE: Pattern = Pattern {
	source: "/^[A-Z][A-Z0-9_]{1,59}$/",
	matches: |text| {
		head_tail(
			text,
			2,
			60,
			|byte| byte.is_ascii_uppercase(),
			|byte| is_upper_digit(byte) || byte == b'_',
		)
	},
};

/// Printable ASCII without spaces: `/^[\x21-\x7e]+$/`.
pub static PRINTABLE_ASCII: Pattern = Pattern {
	source: "/^[\\x21-\\x7e]+$/",
	matches: |text| !text.is_empty() && text.bytes().all(|byte| (0x21..=0x7E).contains(&byte)),
};

/// Earnings period key: `/^[a-z0-9-]{1,48}$/`.
pub static PERIOD_KEY: Pattern = Pattern {
	source: "/^[a-z0-9-]{1,48}$/",
	matches: |text| all_bytes(text, 1, 48, |byte| is_lower_digit(byte) || byte == b'-'),
};

/// Google event id: `/^[0-9a-v]{32}$/`.
pub static GOOGLE_EVENT_ID: Pattern = Pattern {
	source: "/^[0-9a-v]{32}$/",
	matches: |text| {
		all_bytes(text, 32, 32, |byte| {
			byte.is_ascii_digit() || (b'a'..=b'v').contains(&byte)
		})
	},
};

fn digit(bytes: &[u8], index: usize) -> Option<u8> {
	bytes
		.get(index)
		.filter(|byte| byte.is_ascii_digit())
		.map(|byte| byte - b'0')
}

/// zod's `dateSource`: `YYYY-MM-DD` with the month's day count and the
/// Gregorian leap rule written as a regex (any four-digit year, 0000–9999).
fn date_prefix(bytes: &[u8]) -> bool {
	let (Some(y0), Some(y1), Some(y2), Some(y3)) = (
		digit(bytes, 0),
		digit(bytes, 1),
		digit(bytes, 2),
		digit(bytes, 3),
	) else {
		return false;
	};
	if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
		return false;
	}
	let (Some(m0), Some(m1), Some(d0), Some(d1)) = (
		digit(bytes, 5),
		digit(bytes, 6),
		digit(bytes, 8),
		digit(bytes, 9),
	) else {
		return false;
	};
	let month = m0 * 10 + m1;
	let day = d0 * 10 + d1;
	if month == 2 && day == 29 {
		// `\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00`
		let leap_low = match y2 {
			0 => matches!(y3, 4 | 8),
			2 | 4 | 6 | 8 => matches!(y3, 0 | 4 | 8),
			_ => matches!(y3, 2 | 6),
		};
		let leap_century = y2 == 0
			&& y3 == 0
			&& match y0 {
				0 | 2 | 4 | 6 | 8 => matches!(y1, 0 | 4 | 8),
				_ => matches!(y1, 2 | 6),
			};
		return leap_low || leap_century;
	}
	let max_day = match month {
		1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
		4 | 6 | 9 | 11 => 30,
		2 => 28,
		_ => return false,
	};
	(1..=max_day).contains(&day)
}

/// `z.iso.date()`: `/^<dateSource>$/`.
#[must_use]
pub fn is_iso_date(text: &str) -> bool {
	let bytes = text.as_bytes();
	bytes.len() == 10 && date_prefix(bytes)
}

/// `hh:mm` with `(?:[01]\d|2[0-3]):[0-5]\d` at `index`.
fn hour_minute(bytes: &[u8], index: usize) -> bool {
	let (Some(h0), Some(h1)) = (digit(bytes, index), digit(bytes, index + 1)) else {
		return false;
	};
	let hour_ok = h0 <= 1 || (h0 == 2 && h1 <= 3);
	hour_ok
		&& bytes.get(index + 2) == Some(&b':')
		&& digit(bytes, index + 3).is_some_and(|m| m <= 5)
		&& digit(bytes, index + 4).is_some()
}

/// `z.iso.datetime({ offset: true })`:
/// `^<date>T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$`
/// — seconds mandatory, any number of fraction digits, `Z` or `±hh:mm`.
#[must_use]
pub fn is_iso_date_time(text: &str) -> bool {
	let bytes = text.as_bytes();
	if bytes.len() < 20 || !date_prefix(bytes) || bytes.get(10) != Some(&b'T') {
		return false;
	}
	if !hour_minute(bytes, 11) || bytes.get(16) != Some(&b':') {
		return false;
	}
	if !(digit(bytes, 17).is_some_and(|s| s <= 5) && digit(bytes, 18).is_some()) {
		return false;
	}
	let mut index = 19;
	if bytes.get(index) == Some(&b'.') {
		let start = index + 1;
		index = start;
		while digit(bytes, index).is_some() {
			index += 1;
		}
		if index == start {
			return false;
		}
	}
	match bytes.get(index) {
		Some(b'Z') => index + 1 == bytes.len(),
		Some(b'+' | b'-') => index + 6 == bytes.len() && hour_minute(bytes, index + 1),
		_ => false,
	}
}

/// `URL.canParse(value) && new URL(value).protocol === "https:"`.
#[must_use]
pub fn is_https_url(text: &str) -> bool {
	url::Url::parse(text).is_ok_and(|parsed| parsed.scheme() == "https")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn iso_dates_follow_zod() {
		assert!(is_iso_date("2024-02-29"));
		assert!(is_iso_date("2000-02-29"));
		assert!(is_iso_date("0000-02-29"));
		assert!(!is_iso_date("1900-02-29"));
		assert!(!is_iso_date("2023-02-29"));
		assert!(!is_iso_date("2023-04-31"));
		assert!(!is_iso_date("2023-13-01"));
		assert!(!is_iso_date("2023-1-01"));
		assert!(!is_iso_date("２０２３-01-01"));
	}

	#[test]
	fn iso_date_times_follow_zod() {
		assert!(is_iso_date_time("2026-10-11T00:00:00Z"));
		assert!(is_iso_date_time("2026-10-11T23:59:59.123456789+09:00"));
		assert!(!is_iso_date_time("2026-10-11T24:00:00Z"));
		assert!(!is_iso_date_time("2026-10-11T00:00Z"));
		assert!(!is_iso_date_time("2026-10-11T00:00:00z"));
		assert!(!is_iso_date_time("2026-10-11T00:00:00+0900"));
		assert!(!is_iso_date_time("2026-10-11T00:00:00.Z"));
		assert!(!is_iso_date_time("2026-10-11 00:00:00Z"));
	}

	#[test]
	fn ids_follow_the_regex() {
		assert!((ID.matches)("run_1:a.b-c"));
		assert!(!(ID.matches)("_run"));
		assert!(!(ID.matches)(&"a".repeat(97)));
		assert!((ID.matches)(&"a".repeat(96)));
		assert!(!(ID.matches)("ｒun"));
	}
}
