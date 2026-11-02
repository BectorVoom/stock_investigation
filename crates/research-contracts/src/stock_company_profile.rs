//! A Japanese stock's company profile from J-Quants' Listed Issue Master
//! (`packages/contracts/src/stockCompanyProfile.ts`, ADR-0059 §3): carried by
//! the JP `stock-directory-refresh` completion. Only the parts the runner
//! reaches are ported: the limits, the profile schema and the refinement of
//! the completion's profiles (the stored view stays TypeScript).

use std::collections::HashSet;

use research_js::json::Value;
use serde::Serialize;

use crate::primitives::ISO_DATE;
use crate::zod::{Cx, Pattern, StrCheck, decode_object, nullable, string};

/// `STOCK_COMPANY_PROFILE_LIMITS`.
pub mod limits {
	/// Profiles one completion carries: the directory's bound (4,444 issues measured 2026-11-02).
	pub const MAX_PROFILES: usize = crate::stock_directory::limits::MAX_ENTRIES_PER_MARKET;
	/// Longest name, in UTF-16 units.
	pub const MAX_NAME_CHARS: usize = 200;
	/// Longest code.
	pub const MAX_CODE_CHARS: usize = 8;
}

fn upper_digit(byte: u8) -> bool {
	byte.is_ascii_uppercase() || byte.is_ascii_digit()
}

/// `jpxLocalCodeSchema`'s pattern as a predicate: four characters, a digit
/// then digits or uppercase letters (`7203`, `130A`).
#[must_use]
pub fn is_jpx_local_code(text: &str) -> bool {
	matches!(text.as_bytes(), [a, b, c, d] if a.is_ascii_digit() && [*b, *c, *d].into_iter().all(upper_digit))
}

/// `jpxLocalCodeSchema`.
pub static JPX_LOCAL_CODE: Pattern = Pattern {
	source: "/^[0-9][0-9A-Z]{3}$/",
	matches: is_jpx_local_code,
};

const SYMBOL: &[StrCheck] = &[StrCheck::Regex(&JPX_LOCAL_CODE, None)];
const CODE: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(limits::MAX_CODE_CHARS)];
const NAME: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_NAME_CHARS),
];

/// `stockCompanyProfileSchema`: one listed issue's profile, in schema key order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockCompanyProfile {
	/// The directory symbol: J-Quants' 5-character `Code` without its trailing `0`.
	pub symbol: String,
	/// `CoNameEn`; `None` when J-Quants states none.
	pub name_en: Option<String>,
	/// `S17`: the TSE 17-sector code.
	#[serde(rename = "sector17Code")]
	pub sector17_code: String,
	/// `S17Nm`.
	#[serde(rename = "sector17Name")]
	pub sector17_name: String,
	/// `S33`: the TSE 33-sector code.
	#[serde(rename = "sector33Code")]
	pub sector33_code: String,
	/// `S33Nm`.
	#[serde(rename = "sector33Name")]
	pub sector33_name: String,
	/// `ScaleCat` (e.g. "TOPIX Core30"); `None` for J-Quants' "-".
	pub scale_category: Option<String>,
	/// `Mkt` (e.g. "0111").
	pub market_segment_code: String,
	/// `MktNm` (e.g. "プライム").
	pub market_segment_name: String,
	/// `Date`: the day the master states the issue's information for.
	pub as_of: String,
}

impl StockCompanyProfile {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			symbol: "symbol" => string(SYMBOL),
			name_en: "nameEn" => nullable(string(NAME)),
			sector17_code: "sector17Code" => string(CODE),
			sector17_name: "sector17Name" => string(NAME),
			sector33_code: "sector33Code" => string(CODE),
			sector33_name: "sector33Name" => string(NAME),
			scale_category: "scaleCategory" => nullable(string(NAME)),
			market_segment_code: "marketSegmentCode" => string(CODE),
			market_segment_name: "marketSegmentName" => string(NAME),
			as_of: "asOf" => string(ISO_DATE),
		})
	}
}

/// `stockCompanyProfilesProblem`: the first problem of a completion's
/// profiles (a symbol twice), or `None`.
#[must_use]
pub fn stock_company_profiles_problem(profiles: &[StockCompanyProfile]) -> Option<String> {
	let mut symbols: HashSet<&str> = HashSet::with_capacity(profiles.len());
	for profile in profiles {
		if !symbols.insert(profile.symbol.as_str()) {
			return Some(format!("profile {} appears twice", profile.symbol));
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn jpx_local_codes_match_like_the_regex() {
		for good in ["7203", "130A", "1301", "9ZZZ"] {
			assert!(is_jpx_local_code(good), "{good}");
		}
		for bad in ["72030", "A203", "130a", "720", ""] {
			assert!(!is_jpx_local_code(bad), "{bad}");
		}
	}

	#[test]
	fn a_symbol_twice_is_the_problem() {
		let profile = StockCompanyProfile {
			symbol: "7203".to_owned(),
			name_en: None,
			sector17_code: "6".to_owned(),
			sector17_name: "自動車・輸送機".to_owned(),
			sector33_code: "3700".to_owned(),
			sector33_name: "輸送用機器".to_owned(),
			scale_category: None,
			market_segment_code: "0111".to_owned(),
			market_segment_name: "プライム".to_owned(),
			as_of: "2026-08-10".to_owned(),
		};
		assert_eq!(
			stock_company_profiles_problem(std::slice::from_ref(&profile)),
			None
		);
		assert_eq!(
			stock_company_profiles_problem(&[profile.clone(), profile]).as_deref(),
			Some("profile 7203 appears twice")
		);
	}
}
