//! Shared primitives (`packages/contracts/src/primitives.ts`).

use research_js::json::Value;

use crate::patterns;
use crate::zod::{Cx, StrCheck, js_enum, run_string};

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

/// `isoDateTimeSchema` decoder.
pub(crate) fn iso_date_time(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, ISO_DATE_TIME)
}

/// `isoDateSchema` decoder.
pub(crate) fn iso_date(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, ISO_DATE)
}

/// `httpsUrlSchema` decoder.
pub(crate) fn https_url(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, HTTPS_URL)
}

/// `shortTextSchema` decoder.
pub(crate) fn short_text(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, SHORT_TEXT)
}

/// `currencySchema` decoder.
pub(crate) fn currency(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, CURRENCY)
}

/// `z.string()` decoder.
pub(crate) fn any_string(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, ANY_STRING)
}

js_enum! {
	/// `marketSchema`.
	pub enum Market {
		Jp = "JP",
		Us = "US",
	}
}
