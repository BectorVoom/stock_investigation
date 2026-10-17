//! Port of `packages/domain/src/evidence/verifyClaims.ts`: deterministic
//! claim verification (AGT-009 / AGT-013 / DATA-001). Generation output is
//! untrusted: a citation only counts when it points at evidence this run
//! actually fetched AND the quoted passage really occurs in that evidence.
//!
//! Performance (ADR-0030 decision 5): every evidence text is normalised and
//! scanned for number tokens once, in parallel, into an [`EvidenceIndex`];
//! claims are then verified in parallel against that immutable index and
//! collected by index. The TypeScript memoises the number tokens lazily; the
//! memo is pure, so computing them eagerly gives identical output. The same
//! index lets the pipeline's supplier, baseline and pricing-power checks
//! reuse the normalised texts instead of re-normalising them per call.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use memchr::memmem;
use rayon::prelude::*;
use research_js::{utf16, whitespace};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::{IsNormalized, is_nfkc_quick};

use crate::literal::js_literal_enum;

/// A supporting or contradicting quote must be long enough to be a passage.
/// A word or two occurs in almost any article and would "verify" anything.
pub const MIN_QUOTE_LENGTH: usize = 12;

/// Below this many bytes of text, one thread is faster than the rayon pool.
const PARALLEL_MIN_BYTES: usize = 32 * 1024;

js_literal_enum! {
	/// What a claim asserts (`claimTypeSchema`).
	pub enum ClaimType {
		/// A reported fact: its numbers must appear in the supporting evidence.
		Observation = "observation",
		/// A conclusion drawn from facts.
		Inference = "inference",
		/// A tentative explanation.
		Hypothesis = "hypothesis",
		/// A statement about the future.
		Forecast = "forecast",
	}
}

js_literal_enum! {
	/// How a link relates its evidence to the claim (`evidenceRelationSchema`).
	pub enum EvidenceRelation {
		/// The passage supports the claim.
		Supports = "supports",
		/// The passage contradicts the claim.
		Contradicts = "contradicts",
		/// The source as a whole gives context.
		Context = "context",
	}
}

js_literal_enum! {
	/// Verification outcome of one claim (`claimStatusSchema`).
	pub enum ClaimStatus {
		/// Verified support and no verified contradiction.
		Supported = "supported",
		/// No verified support, or a figure the support does not contain.
		Unsupported = "unsupported",
		/// Verified support and verified contradiction.
		Conflicting = "conflicting",
	}
}

/// One citation of a draft claim.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftEvidenceLink {
	/// The cited evidence.
	pub evidence_id: String,
	/// How it relates to the claim.
	pub relation: EvidenceRelation,
	/// Verbatim passage the claim relies on; `None` for a link with no quoted passage.
	pub quote: Option<String>,
}

/// A claim as the model drafted it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftClaim {
	/// Pipeline-allocated id.
	pub claim_id: String,
	/// The claim text.
	pub text: String,
	/// What it asserts.
	pub claim_type: ClaimType,
	/// Its citations, in the model's order.
	pub links: Vec<DraftEvidenceLink>,
}

/// Text the run retrieved for one evidence item (title plus permitted excerpt).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceText {
	/// The evidence id.
	pub evidence_id: String,
	/// The retrieved text.
	pub retrieved_text: String,
}

/// Why a link or a claim failed verification (`claimIssueSchema`; serialised
/// with its `code` tag first, as zod's parsed value).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(tag = "code")]
pub enum ClaimIssue {
	/// `UNKNOWN_EVIDENCE`: the run never fetched this id.
	#[serde(rename = "UNKNOWN_EVIDENCE", rename_all = "camelCase")]
	UnknownEvidence {
		/// The cited id.
		evidence_id: String,
	},
	/// `QUOTE_NOT_FOUND`: the passage is not in the cited evidence.
	#[serde(rename = "QUOTE_NOT_FOUND", rename_all = "camelCase")]
	QuoteNotFound {
		/// The cited id.
		evidence_id: String,
	},
	/// `QUOTE_TOO_SHORT`: under [`MIN_QUOTE_LENGTH`] after normalisation.
	#[serde(rename = "QUOTE_TOO_SHORT", rename_all = "camelCase")]
	QuoteTooShort {
		/// The cited id.
		evidence_id: String,
	},
	/// `MISSING_QUOTE`: support or contradiction without a passage.
	#[serde(rename = "MISSING_QUOTE", rename_all = "camelCase")]
	MissingQuote {
		/// The cited id.
		evidence_id: String,
	},
	/// `NUMBER_NOT_IN_EVIDENCE`: an observation states a figure no support contains.
	#[serde(rename = "NUMBER_NOT_IN_EVIDENCE", rename_all = "camelCase")]
	NumberNotInEvidence {
		/// The figure, thousands separators removed.
		number_text: String,
	},
	/// `NO_SUPPORTING_EVIDENCE`.
	#[serde(rename = "NO_SUPPORTING_EVIDENCE")]
	NoSupportingEvidence,
	/// `NOT_INDEPENDENTLY_VERIFIED`: deterministic checks passed, but no
	/// independent verdict confirmed the claim.
	#[serde(rename = "NOT_INDEPENDENTLY_VERIFIED")]
	NotIndependentlyVerified,
}

impl ClaimIssue {
	/// The TypeScript `code`.
	#[must_use]
	pub const fn code(&self) -> &'static str {
		match self {
			Self::UnknownEvidence { .. } => "UNKNOWN_EVIDENCE",
			Self::QuoteNotFound { .. } => "QUOTE_NOT_FOUND",
			Self::QuoteTooShort { .. } => "QUOTE_TOO_SHORT",
			Self::MissingQuote { .. } => "MISSING_QUOTE",
			Self::NumberNotInEvidence { .. } => "NUMBER_NOT_IN_EVIDENCE",
			Self::NoSupportingEvidence => "NO_SUPPORTING_EVIDENCE",
			Self::NotIndependentlyVerified => "NOT_INDEPENDENTLY_VERIFIED",
		}
	}
}

/// A verified claim. Nothing is dropped: unsupported claims stay visible.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedClaim {
	/// The draft's id.
	pub claim_id: String,
	/// The draft's text.
	pub text: String,
	/// The draft's type.
	pub claim_type: ClaimType,
	/// The outcome.
	pub status: ClaimStatus,
	/// Only links that passed verification; rejected ones appear in `issues`.
	pub links: Vec<DraftEvidenceLink>,
	/// Link issues (link order), then number issues, then `NO_SUPPORTING_EVIDENCE`.
	pub issues: Vec<ClaimIssue>,
}

/// `text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()`.
#[must_use]
pub fn normalize_for_match(text: &str) -> String {
	if text.is_ascii() {
		// NFKC is the identity on ASCII and lower-casing is byte-wise: one pass.
		let mut normalized = Vec::with_capacity(text.len());
		let mut pending_space = false;
		for byte in text.bytes() {
			if matches!(byte, b'\t' | b'\n' | 0x0B | 0x0C | b'\r' | b' ') {
				pending_space = !normalized.is_empty();
			} else {
				if pending_space {
					normalized.push(b' ');
					pending_space = false;
				}
				normalized.push(byte.to_ascii_lowercase());
			}
		}
		// Only ASCII bytes were pushed, so this never fails.
		return String::from_utf8(normalized).unwrap_or_default();
	}
	let composed = nfkc(text);
	let lower = composed.to_lowercase();
	let collapsed = whitespace::collapse(&lower);
	whitespace::trim(&collapsed).to_owned()
}

/// `text.normalize("NFKC")`, borrowing when the text is already normalised.
fn nfkc(text: &str) -> Cow<'_, str> {
	if text.is_ascii() || is_nfkc_quick(text.chars()) == IsNormalized::Yes {
		Cow::Borrowed(text)
	} else {
		Cow::Owned(text.nfkc().collect())
	}
}

/// `extractNumberTokens`: numeric tokens with thousands separators removed,
/// e.g. `"1,234.5%"` → `"1234.5"`. The pattern is `/\d[\d,]*(?:\.\d+)?/g` on
/// the NFKC form, where `\d` is ASCII (no `u` flag), so full-width digits
/// count after normalisation and other scripts' digits never do.
#[must_use]
pub fn extract_number_tokens(text: &str) -> Vec<String> {
	let normalized = nfkc(text);
	let bytes = normalized.as_bytes();
	let mut tokens = Vec::new();
	let mut index = 0usize;
	while let Some(offset) = bytes
		.get(index..)
		.and_then(|rest| rest.iter().position(u8::is_ascii_digit))
	{
		let start = index + offset;
		let mut end = start + 1;
		while bytes
			.get(end)
			.is_some_and(|byte| byte.is_ascii_digit() || *byte == b',')
		{
			end += 1;
		}
		// `(?:\.\d+)?`: a fraction only when a digit follows the point.
		if bytes.get(end) == Some(&b'.') && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
			end += 2;
			while bytes.get(end).is_some_and(u8::is_ascii_digit) {
				end += 1;
			}
		}
		let token = bytes.get(start..end).unwrap_or_default();
		tokens.push(
			token
				.iter()
				.filter(|byte| **byte != b',')
				.map(|byte| char::from(*byte))
				.collect(),
		);
		index = end;
	}
	tokens
}

/// `isPassageOf`: whether `quote` is a passage of `retrieved_text` — long
/// enough to be a passage and present verbatim, ignoring case and whitespace
/// differences.
#[must_use]
pub fn is_passage_of(quote: &str, retrieved_text: &str) -> bool {
	is_passage_of_prepared(quote, &PreparedText::new(retrieved_text))
}

/// [`is_passage_of`] against an already prepared text.
#[must_use]
pub fn is_passage_of_prepared(quote: &str, text: &PreparedText) -> bool {
	let normalized = normalize_for_match(quote);
	utf16::utf16_len(&normalized) >= MIN_QUOTE_LENGTH && text.contains_normalized(&normalized)
}

/// `mentions`: whether `text` mentions `phrase`, ignoring case and whitespace differences.
#[must_use]
pub fn mentions(text: &str, phrase: &str) -> bool {
	mentions_prepared(&PreparedText::new(text), phrase)
}

/// [`mentions`] against an already prepared text.
#[must_use]
pub fn mentions_prepared(text: &PreparedText, phrase: &str) -> bool {
	let normalized = normalize_for_match(phrase);
	!normalized.is_empty() && text.contains_normalized(&normalized)
}

/// One evidence text, normalised for matching, with its number tokens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedText {
	normalized: String,
	number_tokens: HashSet<String>,
}

impl PreparedText {
	/// Normalises `text` and extracts its number tokens.
	#[must_use]
	pub fn new(text: &str) -> Self {
		Self::from_normalized(normalize_for_match(text))
	}

	/// Wraps text that is already normalised (the TypeScript `verifyClaim`
	/// takes such a map), extracting its number tokens.
	#[must_use]
	pub fn from_normalized(normalized: String) -> Self {
		// `numberTokensOf` scans the normalised text, as the TypeScript does.
		let number_tokens = extract_number_tokens(&normalized).into_iter().collect();
		Self {
			normalized,
			number_tokens,
		}
	}

	/// The normalised text.
	#[must_use]
	pub fn normalized(&self) -> &str {
		&self.normalized
	}

	/// The distinct number tokens of the normalised text.
	#[must_use]
	pub const fn number_tokens(&self) -> &HashSet<String> {
		&self.number_tokens
	}

	fn contains_normalized(&self, needle: &str) -> bool {
		memmem::find(self.normalized.as_bytes(), needle.as_bytes()).is_some()
	}
}

/// Evidence texts by id, prepared once (the TypeScript `evidenceById` map
/// plus its number-token memo). A repeated id keeps its last text, as a JS
/// `Map` built from entries does.
#[derive(Clone, Debug, Default)]
pub struct EvidenceIndex {
	by_id: HashMap<String, PreparedText>,
}

impl EvidenceIndex {
	/// Prepares `evidence` in parallel when it is large.
	#[must_use]
	pub fn new(evidence: &[EvidenceText]) -> Self {
		let mut last_index: HashMap<&str, usize> = HashMap::with_capacity(evidence.len());
		for (index, item) in evidence.iter().enumerate() {
			last_index.insert(item.evidence_id.as_str(), index);
		}
		let winners: Vec<&EvidenceText> = evidence
			.iter()
			.enumerate()
			.filter(|(index, item)| last_index.get(item.evidence_id.as_str()) == Some(index))
			.map(|(_, item)| item)
			.collect();
		let total_bytes: usize = winners.iter().map(|item| item.retrieved_text.len()).sum();
		let prepare = |item: &&EvidenceText| {
			(
				item.evidence_id.clone(),
				PreparedText::new(&item.retrieved_text),
			)
		};
		let by_id = if total_bytes >= PARALLEL_MIN_BYTES {
			winners.par_iter().map(prepare).collect()
		} else {
			winners.iter().map(prepare).collect()
		};
		Self { by_id }
	}

	/// An index over texts that are already normalised (TypeScript
	/// `verifyClaim(claim, evidenceById)`), in map order: a repeated id keeps
	/// its last text.
	#[must_use]
	pub fn from_normalized<I: IntoIterator<Item = (String, String)>>(entries: I) -> Self {
		Self {
			by_id: entries
				.into_iter()
				.map(|(id, normalized)| (id, PreparedText::from_normalized(normalized)))
				.collect(),
		}
	}

	/// The prepared text of an evidence id.
	#[must_use]
	pub fn get(&self, evidence_id: &str) -> Option<&PreparedText> {
		self.by_id.get(evidence_id)
	}
}

fn verify_link(link: &DraftEvidenceLink, index: &EvidenceIndex) -> Option<ClaimIssue> {
	let evidence_id = || link.evidence_id.clone();
	let Some(retrieved) = index.get(&link.evidence_id) else {
		return Some(ClaimIssue::UnknownEvidence {
			evidence_id: evidence_id(),
		});
	};
	let Some(quote) = link
		.quote
		.as_deref()
		.filter(|quote| !whitespace::trim(quote).is_empty())
	else {
		// Context links may point at a source as a whole; support/contradiction must quote it.
		return (link.relation != EvidenceRelation::Context).then(|| ClaimIssue::MissingQuote {
			evidence_id: evidence_id(),
		});
	};
	let quote = normalize_for_match(quote);
	if link.relation != EvidenceRelation::Context && utf16::utf16_len(&quote) < MIN_QUOTE_LENGTH {
		return Some(ClaimIssue::QuoteTooShort {
			evidence_id: evidence_id(),
		});
	}
	(!retrieved.contains_normalized(&quote)).then(|| ClaimIssue::QuoteNotFound {
		evidence_id: evidence_id(),
	})
}

/// `verifyClaim`: one claim against prepared evidence.
#[must_use]
pub fn verify_claim(claim: &DraftClaim, index: &EvidenceIndex) -> VerifiedClaim {
	let mut issues = Vec::new();
	let mut valid_links = Vec::with_capacity(claim.links.len());
	for link in &claim.links {
		match verify_link(link, index) {
			None => valid_links.push(link.clone()),
			Some(issue) => issues.push(issue),
		}
	}
	let supporting: Vec<&DraftEvidenceLink> = valid_links
		.iter()
		.filter(|link| link.relation == EvidenceRelation::Supports)
		.collect();
	let contradicting = valid_links
		.iter()
		.any(|link| link.relation == EvidenceRelation::Contradicts);
	let mut number_issues = 0usize;
	// Forecasts and hypotheses legitimately state numbers no source contains yet.
	if claim.claim_type == ClaimType::Observation {
		let sources: Vec<&HashSet<String>> = supporting
			.iter()
			.filter_map(|link| {
				index
					.get(&link.evidence_id)
					.map(PreparedText::number_tokens)
			})
			.collect();
		for token in extract_number_tokens(&claim.text) {
			if !sources.iter().any(|tokens| tokens.contains(&token)) {
				issues.push(ClaimIssue::NumberNotInEvidence { number_text: token });
				number_issues += 1;
			}
		}
	}
	if supporting.is_empty() {
		issues.push(ClaimIssue::NoSupportingEvidence);
	}
	let status = if supporting.is_empty() || number_issues > 0 {
		ClaimStatus::Unsupported
	} else if contradicting {
		ClaimStatus::Conflicting
	} else {
		ClaimStatus::Supported
	};
	VerifiedClaim {
		claim_id: claim.claim_id.clone(),
		text: claim.text.clone(),
		claim_type: claim.claim_type,
		status,
		links: valid_links,
		issues,
	}
}

/// `verifyClaims`: every claim, in order; nothing is dropped, so unsupported
/// claims stay visible to the owner.
#[must_use]
pub fn verify_claims(claims: &[DraftClaim], evidence: &[EvidenceText]) -> Vec<VerifiedClaim> {
	verify_claims_with(claims, &EvidenceIndex::new(evidence))
}

/// [`verify_claims`] against an index the caller keeps for later checks.
#[must_use]
pub fn verify_claims_with(claims: &[DraftClaim], index: &EvidenceIndex) -> Vec<VerifiedClaim> {
	if claims.len() >= 8 {
		claims
			.par_iter()
			.map(|claim| verify_claim(claim, index))
			.collect()
	} else {
		claims
			.iter()
			.map(|claim| verify_claim(claim, index))
			.collect()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn link(id: &str, relation: EvidenceRelation, quote: Option<&str>) -> DraftEvidenceLink {
		DraftEvidenceLink {
			evidence_id: id.to_owned(),
			relation,
			quote: quote.map(str::to_owned),
		}
	}

	fn evidence() -> Vec<EvidenceText> {
		vec![
			EvidenceText {
				evidence_id: "ev_earnings".to_owned(),
				retrieved_text:
					"Example Corp reported revenue of 1,234 million yen, up 12% year on year."
						.to_owned(),
			},
			EvidenceText {
				evidence_id: "ev_analyst".to_owned(),
				retrieved_text: "Analysts warn that demand may fall as subsidies expire in 2027."
					.to_owned(),
			},
		]
	}

	#[test]
	fn extracts_number_tokens() {
		assert_eq!(
			extract_number_tokens("1,234.5% and 7 and 3.x"),
			["1234.5", "7", "3"]
		);
		assert_eq!(extract_number_tokens("売上高は１２３４億円"), ["1234"]);
		assert_eq!(extract_number_tokens("1.2.3"), ["1.2", "3"]);
		assert_eq!(extract_number_tokens("١٢٣"), Vec::<String>::new());
	}

	#[test]
	fn normalizes_like_javascript() {
		assert_eq!(normalize_for_match("  A \t B\n"), "a b");
		assert_eq!(
			normalize_for_match("\u{FEFF}Ｒｅｖｅｎｕｅ\u{00A0}UP\u{0085}"),
			"revenue up\u{0085}"
		);
		assert_eq!(normalize_for_match("ΑΣ"), "ας");
	}

	#[test]
	fn verifies_support_contradiction_and_numbers() {
		let claim = DraftClaim {
			claim_id: "cl1".to_owned(),
			text: "Example Corp revenue rose 12% and subsidies run to 2027.".to_owned(),
			claim_type: ClaimType::Observation,
			links: vec![
				link(
					"ev_earnings",
					EvidenceRelation::Supports,
					Some("UP 12%  year on year"),
				),
				link(
					"ev_analyst",
					EvidenceRelation::Contradicts,
					Some("subsidies expire in 2027"),
				),
				link(
					"ev_ghost",
					EvidenceRelation::Supports,
					Some("anything at all here"),
				),
				link("ev_analyst", EvidenceRelation::Supports, None),
				link("ev_analyst", EvidenceRelation::Context, None),
			],
		};
		let verified = verify_claims(&[claim], &evidence());
		let only = &verified[0];
		assert_eq!(only.status, ClaimStatus::Unsupported);
		assert_eq!(
			only.issues,
			[
				ClaimIssue::UnknownEvidence {
					evidence_id: "ev_ghost".to_owned()
				},
				ClaimIssue::MissingQuote {
					evidence_id: "ev_analyst".to_owned()
				},
				ClaimIssue::NumberNotInEvidence {
					number_text: "2027".to_owned()
				},
			]
		);
		assert_eq!(only.links.len(), 3);
	}

	#[test]
	fn parallel_and_sequential_agree() {
		let claims: Vec<DraftClaim> = (0..40)
			.map(|index| DraftClaim {
				claim_id: format!("cl{index}"),
				text: format!("Revenue was {} million yen, up 12%.", 1234 + index % 2),
				claim_type: ClaimType::Observation,
				links: vec![link(
					"ev_earnings",
					EvidenceRelation::Supports,
					Some("up 12% year on year"),
				)],
			})
			.collect();
		let index = EvidenceIndex::new(&evidence());
		let parallel = verify_claims_with(&claims, &index);
		let sequential: Vec<VerifiedClaim> = claims
			.iter()
			.map(|claim| verify_claim(claim, &index))
			.collect();
		assert_eq!(parallel, sequential);
		assert_eq!(parallel[0].status, ClaimStatus::Supported);
		assert_eq!(parallel[1].status, ClaimStatus::Unsupported);
	}

	#[test]
	fn passages_and_mentions() {
		let text = "Example Corp supplies   cathodes to Battery Inc.";
		assert!(is_passage_of("supplies cathodes to battery", text));
		assert!(!is_passage_of("cathodes", text));
		assert!(mentions(text, "BATTERY inc"));
		assert!(!mentions(text, " \t"));
	}

	/// The `scripts/bench.ts` case "verify 80 claims x 6 links against 80 x
	/// 4 KB evidence" (budget 10 ms). Run with
	/// `cargo test -p research-domain --release --lib bench_ -- --ignored --nocapture`.
	#[test]
	#[ignore = "timing; run in release"]
	fn bench_verify_80_claims() {
		const SENTENCE: &str =
			"Orders for grid storage reached 100 GWh in 2026, up from 70 GWh a year earlier. ";
		let evidence: Vec<EvidenceText> = (0..80)
			.map(|index| EvidenceText {
				evidence_id: format!("run_bench_ev{index}"),
				retrieved_text: format!(
					"{} Item {index} shipped {} units.",
					SENTENCE.repeat(48),
					index * 7 + 3
				),
			})
			.collect();
		let claims: Vec<DraftClaim> = (0..80)
			.map(|index| DraftClaim {
				claim_id: format!("run_bench_cl{index}"),
				text: format!(
					"Item {} shipped {} units in 2026.",
					index % 80,
					(index % 80) * 7 + 3
				),
				claim_type: ClaimType::Observation,
				links: (0..6)
					.map(|offset| DraftEvidenceLink {
						evidence_id: format!("run_bench_ev{}", (index + offset) % 80),
						relation: EvidenceRelation::Supports,
						quote: Some("Orders for grid storage reached 100 GWh in 2026".to_owned()),
					})
					.collect(),
			})
			.collect();
		let median = |run: &dyn Fn() -> Vec<VerifiedClaim>| {
			for _ in 0..5 {
				std::hint::black_box(run());
			}
			let mut samples: Vec<f64> = (0..25)
				.map(|_| {
					let started = std::time::Instant::now();
					std::hint::black_box(run());
					started.elapsed().as_secs_f64() * 1000.0
				})
				.collect();
			samples.sort_by(f64::total_cmp);
			samples[12]
		};
		let sequential = || {
			let index = EvidenceIndex {
				by_id: evidence
					.iter()
					.map(|item| {
						(
							item.evidence_id.clone(),
							PreparedText::new(&item.retrieved_text),
						)
					})
					.collect(),
			};
			claims
				.iter()
				.map(|claim| verify_claim(claim, &index))
				.collect::<Vec<_>>()
		};
		let parallel = || verify_claims(&claims, &evidence);
		assert_eq!(sequential(), parallel());
		for _ in 0..3 {
			println!(
				"verify 80 claims: sequential {:.3} ms, parallel {:.3} ms",
				median(&sequential),
				median(&parallel)
			);
		}
	}
}
