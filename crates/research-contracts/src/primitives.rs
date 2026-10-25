//! Shared primitives (`packages/contracts/src/primitives.ts`).

use research_js::json::Value;

use research_domain::upstream::UPSTREAM_STATUS_MAX;

use crate::patterns;
use crate::zod::{Cx, NumCheck, StrCheck, clamp_u64, run_number, run_string};

/// `idSchema`.
pub(crate) const ID: &[StrCheck] = &[StrCheck::Regex(&patterns::ID, Some("invalid id"))];
/// `isoDateTimeSchema` (`z.iso.datetime({ offset: true })`).
pub(crate) const ISO_DATE_TIME: &[StrCheck] = &[StrCheck::IsoDateTime];
/// `isoDateSchema` (`z.iso.date()`).
pub(crate) const ISO_DATE: &[StrCheck] = &[StrCheck::IsoDate];
/// `httpsUrlSchema`: at most 2048 characters and WHATWG-parsable as `https:`.
pub(crate) const HTTPS_URL: &[StrCheck] = &[
	StrCheck::Max(2048),
	StrCheck::Refine(patterns::is_https_url, "must be an https URL"),
];
/// `shortTextSchema`.
pub(crate) const SHORT_TEXT: &[StrCheck] = &[StrCheck::Trim, StrCheck::Min(1), StrCheck::Max(300)];
/// `longTextSchema`.
pub(crate) const LONG_TEXT: &[StrCheck] = &[StrCheck::Trim, StrCheck::Min(1), StrCheck::Max(4000)];
/// `currencySchema`.
pub(crate) const CURRENCY: &[StrCheck] = &[StrCheck::Regex(
	&patterns::CURRENCY,
	Some("ISO 4217 code expected"),
)];
/// `z.string()` without checks.
pub(crate) const ANY_STRING: &[StrCheck] = &[];

/// `idSchema` decoder.
pub(crate) fn id(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, ID)
}

/// `z.string()` decoder.
pub(crate) fn any_string(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, ANY_STRING)
}

/// `upstreamStatusSchema`: the HTTP status an external service answered
/// with, exactly as received (docs/rule/error_handling.md §4a) — an integer
/// in 100..=599, never remapped.
/// The bounds are the domain's `UPSTREAM_STATUS_MIN/MAX` (a test holds them
/// equal; `f64::from` is not usable in a const).
pub(crate) const UPSTREAM_STATUS: &[NumCheck] =
	&[NumCheck::Int, NumCheck::Gte(100.0), NumCheck::Lte(599.0)];

/// `upstreamStatusSchema` decoder. A value that failed a check has already
/// recorded its issue (the parse fails); the clamp only keeps zod's
/// "continue" semantics producing a value.
pub(crate) fn upstream_status(cx: &mut Cx, input: Option<&Value>) -> Option<u16> {
	run_number(cx, input, UPSTREAM_STATUS)
		.map(|value| u16::try_from(clamp_u64(value)).unwrap_or(UPSTREAM_STATUS_MAX))
}

/// `marketSchema` (defined once, in the domain).
pub use research_domain::finance::types::Market;

#[cfg(test)]
mod tests {
	use super::*;
	use research_domain::upstream::UPSTREAM_STATUS_MIN;

	#[test]
	fn the_upstream_status_bounds_are_the_domains() {
		let [NumCheck::Int, NumCheck::Gte(min), NumCheck::Lte(max)] = UPSTREAM_STATUS else {
			unreachable!("upstreamStatusSchema is int().min().max()");
		};
		assert_eq!(*min, f64::from(UPSTREAM_STATUS_MIN));
		assert_eq!(*max, f64::from(UPSTREAM_STATUS_MAX));
	}
}
