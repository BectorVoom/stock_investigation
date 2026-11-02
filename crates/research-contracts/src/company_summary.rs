//! An AI-written company summary (`packages/contracts/src/companySummary.ts`,
//! ADR-0060): what a `company-summary` claim carries (the stored facts) and
//! what its `company-summarized` completion returns (a short description and
//! the investment themes, in English and Japanese). Only the parts the runner
//! reaches are ported: the limits, the summary and the facts (the stored view
//! stays TypeScript).

use research_js::json::Value;
use serde::Serialize;

use crate::zod::{ArrCheck, Cx, StrCheck, array, decode_object, nullable, string};

/// `COMPANY_SUMMARY_LIMITS` (the parts the runner reaches).
pub mod limits {
	/// Longest description, in characters.
	pub const MAX_DESCRIPTION_CHARS: usize = 1_000;
	/// Fewest themes.
	pub const MIN_THEMES: usize = 1;
	/// Most themes.
	pub const MAX_THEMES: usize = 8;
	/// Longest theme, in characters.
	pub const MAX_THEME_CHARS: usize = 40;
	/// A name, listing or sector fact the claim carries.
	pub const MAX_FACT_CHARS: usize = 200;
	/// The US annual report's business text the claim carries.
	pub const MAX_BUSINESS_EXCERPT_CHARS: usize = 4_000;
}

const DESCRIPTION: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_DESCRIPTION_CHARS),
];
const THEME: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_THEME_CHARS),
];
const FACT: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_FACT_CHARS),
];
const BUSINESS_EXCERPT: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_BUSINESS_EXCERPT_CHARS),
];
const THEMES: &[ArrCheck] = &[
	ArrCheck::Min(limits::MIN_THEMES),
	ArrCheck::Max(limits::MAX_THEMES),
];

/// One text in both UI languages (`localizedText(max)`), trimmed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocalizedText {
	/// English.
	pub en: String,
	/// Japanese.
	pub ja: String,
}

impl LocalizedText {
	fn decode_with(
		cx: &mut Cx,
		input: Option<&Value>,
		checks: &'static [StrCheck],
	) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			en: "en" => string(checks),
			ja: "ja" => string(checks),
		})
	}

	/// `companySummaryThemeSchema` (≤ 40 characters each).
	pub fn decode_theme(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		Self::decode_with(cx, input, THEME)
	}

	/// The description (≤ 1,000 characters each).
	pub fn decode_description(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		Self::decode_with(cx, input, DESCRIPTION)
	}
}

/// `companySummarySchema`: what the agent writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CompanySummary {
	/// What the company does, both languages.
	pub description: LocalizedText,
	/// Its investment themes (1..=8).
	pub themes: Vec<LocalizedText>,
}

impl CompanySummary {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			description: "description" => LocalizedText::decode_description,
			themes: "themes" => array(LocalizedText::decode_theme, THEMES),
		})
	}
}

/// `companySummaryFactsSchema`: the stored facts a claim gives the agent;
/// `None` when not stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanySummaryFacts {
	/// The directory name.
	pub name: Option<String>,
	/// The local (Japanese) name.
	pub local_name: Option<String>,
	/// The listing.
	pub listing: Option<String>,
	/// A Japanese stock's J-Quants sectors.
	pub sector: Option<String>,
	/// The start of a US stock's annual-report business section.
	pub business_excerpt: Option<String>,
}

impl CompanySummaryFacts {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			name: "name" => nullable(string(FACT)),
			local_name: "localName" => nullable(string(FACT)),
			listing: "listing" => nullable(string(FACT)),
			sector: "sector" => nullable(string(FACT)),
			business_excerpt: "businessExcerpt" => nullable(string(BUSINESS_EXCERPT)),
		})
	}
}
