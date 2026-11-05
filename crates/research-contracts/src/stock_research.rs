//! Stored stock retrieval contract, shared by both runners.
use crate::primitives::{HTTPS_URL, ISO_DATE_TIME};
use crate::records::SourceClass;
use crate::zod::{
	ArrCheck, Cx, NumCheck, StrCheck, array, boolean, decode_object, js_enum, nullable, number,
	optional, string,
};
use research_js::json::Value;
use serde::Serialize;

js_enum! {
	/// The corpus to search.
	pub enum StockResearchKind { Company = "company", Financials = "financials", News = "news" }
}
fn bounded_words(text: &str) -> bool {
	text.split(research_js::whitespace::is_js_whitespace)
		.filter(|part| !part.is_empty())
		.count()
		<= 8
}
const QUERY: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(128),
	StrCheck::Refine(bounded_words, "Use at most eight search terms."),
];
fn limit(cx: &mut Cx, input: Option<&Value>) -> Option<f64> {
	if input.is_none() {
		return Some(6.0);
	}
	number(&[NumCheck::Int, NumCheck::Gte(1.0), NumCheck::Lte(12.0)])(cx, input)
}
/// Validated agent arguments. The lease is injected by the host, never by the model.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockResearchQuery {
	/// All terms must match one passage.
	pub query: String,
	/// None searches all three corpora.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub kind: Option<StockResearchKind>,
	/// Maximum results, 1..12.
	pub limit: f64,
}
impl StockResearchQuery {
	/// Exact argument boundary.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			query: "query" => string(QUERY),
			kind: "kind" => optional(StockResearchKind::decode),
			limit: "limit" => limit,
		})
	}
}
/// Server-provided passage and lineage.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockResearchHit {
	/// Corpus.
	pub kind: StockResearchKind,
	/// Stable stored record reference.
	pub record_id: String,
	/// Stored title.
	pub title: String,
	/// Bounded passage.
	pub text: String,
	/// None is context only.
	pub source_url: Option<String>,
	/// Publisher.
	pub publisher: String,
	/// Publication date.
	pub published_at: Option<String>,
	/// Stored retrieval date.
	pub retrieved_at: String,
	/// Financial period or as-of date.
	pub effective_at: Option<String>,
	/// Evidence class.
	pub source_class: SourceClass,
	/// Whether excerpts may be retained.
	pub retain_quotes: bool,
	/// AI text is never promoted to primary evidence.
	pub ai_generated: bool,
}
impl StockResearchHit {
	/// Validates server data.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			kind: "kind" => StockResearchKind::decode,
			record_id: "recordId" => string(&[StrCheck::Min(1), StrCheck::Max(300)]),
			title: "title" => string(&[StrCheck::Min(1), StrCheck::Max(300)]),
			text: "text" => string(&[StrCheck::Min(1), StrCheck::Max(2400)]),
			source_url: "sourceUrl" => nullable(string(HTTPS_URL)),
			publisher: "publisher" => string(&[StrCheck::Min(1), StrCheck::Max(300)]),
			published_at: "publishedAt" => nullable(string(ISO_DATE_TIME)),
			retrieved_at: "retrievedAt" => string(ISO_DATE_TIME),
			effective_at: "effectiveAt" => nullable(string(ISO_DATE_TIME)),
			source_class: "sourceClass" => SourceClass::decode,
			retain_quotes: "retainQuotes" => boolean,
			ai_generated: "aiGenerated" => boolean,
		})
	}
}
/// The bounded search response.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StockResearchResponse {
	/// Passages in corpus-interleaved order.
	pub hits: Vec<StockResearchHit>,
	/// Narrow the query when true.
	pub truncated: bool,
}
impl crate::Contract for StockResearchResponse {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			hits: "hits" => array(StockResearchHit::decode, &[ArrCheck::Max(12)]),
			truncated: "truncated" => boolean,
		})
	}
}
impl crate::Contract for StockResearchQuery {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		Self::decode(cx, input)
	}
}
