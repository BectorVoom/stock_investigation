//! Feed normalisation — port of `normalizeFeed` and its helpers in
//! `packages/domain/src/news/feed.ts`.
//!
//! Rayon (ADR-0030 decision 5): every examined item is reduced in parallel
//! (plain text of title and summary, URL canonicalisation, timestamp,
//! truncation, fingerprint material), collected by index, then one
//! sequential fold applies the within-feed dedupe and builds the rejection
//! list — so the output is the sequential TypeScript's. Duplicates are
//! reduced too and then dropped by the fold; that costs a little work on
//! rare duplicates and keeps the map free of shared state. Callers on a
//! tokio worker bridge to this CPU work through `rayon::spawn` + a oneshot.

use crate::literal::js_literal_enum;

mod plain_text;
mod timestamp;

pub use plain_text::to_plain_text;
pub use timestamp::{parse_feed_timestamp, parse_feed_timestamp_in};

use super::canonical_url::canonicalize_article_url;
use super::raw_feed::{RawFeed, RawFeedItem};
use super::url_policy::UrlPolicyError;
use rayon::prelude::*;
use regex::Regex;
use research_js::date::{LocalTimeZone, SystemTimeZone};
use research_js::{utf16, whitespace};
use std::collections::HashSet;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// Longest stored article title, in UTF-16 units.
pub const MAX_TITLE_LENGTH: usize = 300;
/// Longest stored excerpt, in UTF-16 units.
pub const MAX_EXCERPT_LENGTH: usize = 500;

js_literal_enum! {
	/// What may be retained from a publisher's content (DATA-010).
	pub enum LicensePolicy {
		/// Headline and link only; no excerpt is stored.
		HeadlineAndLinkOnly = "headline-and-link-only",
		/// A short excerpt may be stored.
		ShortExcerptPermitted = "short-excerpt-permitted",
	}
}

/// One article a feed proposes, normalised.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArticleCandidate {
	/// Canonical article URL (the dedupe key).
	pub canonical_url: String,
	/// Plain-text title, at most [`MAX_TITLE_LENGTH`] units.
	pub title: String,
	/// The source's publisher name.
	pub publisher: String,
	/// `None` when the feed gave no parseable date; never back-filled with
	/// the retrieval time.
	pub published_at: Option<String>,
	/// When the feed was fetched.
	pub retrieved_at: String,
	/// Plain-text excerpt when the license permits one.
	pub excerpt: Option<String>,
	/// Text hashed into the content fingerprint.
	pub fingerprint_material: String,
}

/// Why an examined item was not turned into an article.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedItemRejection {
	/// The title is empty once reduced to plain text.
	MissingTitle {
		/// Position in the feed.
		index: usize,
	},
	/// No link, or a blank one.
	MissingLink {
		/// Position in the feed.
		index: usize,
	},
	/// The link fails the URL policy.
	UnsafeLink {
		/// Position in the feed.
		index: usize,
		/// The policy's verdict.
		detail: UrlPolicyError,
	},
}

impl FeedItemRejection {
	/// The TypeScript `reason` literal.
	#[must_use]
	pub const fn reason(self) -> &'static str {
		match self {
			Self::MissingTitle { .. } => "MISSING_TITLE",
			Self::MissingLink { .. } => "MISSING_LINK",
			Self::UnsafeLink { .. } => "UNSAFE_LINK",
		}
	}

	/// The item's position in the feed.
	#[must_use]
	pub const fn index(self) -> usize {
		match self {
			Self::MissingTitle { index }
			| Self::MissingLink { index }
			| Self::UnsafeLink { index, .. } => index,
		}
	}
}

/// `normalizeFeed`'s result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizedFeed {
	/// Articles in feed order, deduplicated by canonical URL (first wins).
	pub articles: Vec<ArticleCandidate>,
	/// Rejected items in feed order.
	pub rejected: Vec<FeedItemRejection>,
	/// Items beyond `max_items` that were not examined.
	pub truncated_item_count: usize,
}

/// `NormalizeFeedOptions`.
#[derive(Clone, Copy, Debug)]
pub struct NormalizeFeedOptions<'a> {
	/// Publisher name stored on every article.
	pub publisher: &'a str,
	/// Retrieval timestamp stored on every article.
	pub retrieved_at: &'a str,
	/// What may be retained (DATA-010).
	pub license_policy: LicensePolicy,
	/// How many leading items are examined.
	pub max_items: usize,
}

/// Inputs of [`article_fingerprint_material`].
#[derive(Clone, Copy, Debug)]
pub struct FingerprintInput<'a> {
	/// Bounded plain-text title.
	pub title: &'a str,
	/// Publisher name.
	pub publisher: &'a str,
	/// Publication instant, if known.
	pub published_at: Option<&'a str>,
	/// Full plain-text summary, if any.
	pub summary: Option<&'a str>,
	/// Canonical article URL.
	pub canonical_url: &'a str,
}

/// `/[^\p{L}\p{N}]+/gu`.
static NOT_LETTER_OR_NUMBER: LazyLock<Option<Regex>> =
	LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").ok());

/// NFKC → lower case → runs of non-letters/non-numbers to one space → trim.
fn normalize_for_fingerprint(text: &str) -> String {
	let lowered = text.nfkc().collect::<String>().to_lowercase();
	let spaced = match NOT_LETTER_OR_NUMBER.as_ref() {
		Some(regex) => regex.replace_all(&lowered, " ").into_owned(),
		None => lowered,
	};
	whitespace::trim(&spaced).to_owned()
}

/// `articleFingerprintMaterial`: text hashed into the stable content
/// fingerprint. When the feed supplies a summary, identity is the content
/// itself (publisher, day, headline, summary), so the same story syndicated
/// under two links collapses to one. When there is no summary, a headline
/// alone is too weak to call two links the same article — a publisher reuses
/// headlines such as "Market wrap" for different updates — so the canonical
/// URL becomes part of the identity instead.
#[must_use]
pub fn article_fingerprint_material(input: &FingerprintInput<'_>) -> String {
	let day = input
		.published_at
		.map_or(std::borrow::Cow::Borrowed("undated"), |at| {
			utf16::slice(at, 0, 10)
		});
	let summary = input
		.summary
		.map(normalize_for_fingerprint)
		.unwrap_or_default();
	let body = if summary.is_empty() {
		format!("url:{}", input.canonical_url)
	} else {
		format!("summary:{summary}")
	};
	format!(
		"{}\n{day}\n{}\n{body}",
		input.publisher.to_lowercase(),
		normalize_for_fingerprint(input.title)
	)
}

/// Cuts on a code-point boundary so the result never exceeds `max_length`
/// UTF-16 units, marking the cut with `…`.
fn truncate(text: String, max_length: usize) -> String {
	if utf16::utf16_len(&text) <= max_length {
		return text;
	}
	let mut kept = utf16::cut_code_points(&text, max_length.saturating_sub(1)).to_owned();
	kept.push('…');
	kept
}

/// One examined item, reduced independently of the others.
enum Reduced {
	Rejected(FeedItemRejection),
	Article(ArticleCandidate),
}

fn reduce_item(
	index: usize,
	item: &RawFeedItem,
	options: &NormalizeFeedOptions<'_>,
	zone: &dyn LocalTimeZone,
) -> Reduced {
	let title = item.title.as_deref().map(to_plain_text).unwrap_or_default();
	if title.is_empty() {
		return Reduced::Rejected(FeedItemRejection::MissingTitle { index });
	}
	let Some(link) = item
		.link
		.as_deref()
		.map(whitespace::trim)
		.filter(|link| !link.is_empty())
	else {
		return Reduced::Rejected(FeedItemRejection::MissingLink { index });
	};
	let canonical_url = match canonicalize_article_url(link) {
		Ok(url) => url,
		Err(detail) => return Reduced::Rejected(FeedItemRejection::UnsafeLink { index, detail }),
	};
	let published_at = parse_feed_timestamp_in(item.published_text.as_deref(), zone);
	let title = truncate(title, MAX_TITLE_LENGTH);
	let summary = item
		.summary_text
		.as_deref()
		.map(to_plain_text)
		.unwrap_or_default();
	let excerpt = (options.license_policy == LicensePolicy::ShortExcerptPermitted
		&& !summary.is_empty())
	.then(|| truncate(summary.clone(), MAX_EXCERPT_LENGTH));
	let fingerprint_material = article_fingerprint_material(&FingerprintInput {
		title: &title,
		publisher: options.publisher,
		published_at: published_at.as_deref(),
		// The full summary identifies the content even when licensing forbids storing it.
		summary: (!summary.is_empty()).then_some(summary.as_str()),
		canonical_url: &canonical_url,
	});
	Reduced::Article(ArticleCandidate {
		canonical_url,
		title,
		publisher: options.publisher.to_owned(),
		published_at,
		retrieved_at: options.retrieved_at.to_owned(),
		excerpt,
		fingerprint_material,
	})
}

/// `normalizeFeed`: pure normalisation of parsed feed items into article
/// candidates, deduplicated within the feed. Timestamps are read with the
/// operating system's zone, as `Date.parse` does (they always carry a zone).
#[must_use]
pub fn normalize_feed(feed: &RawFeed, options: &NormalizeFeedOptions<'_>) -> NormalizedFeed {
	normalize_feed_in(feed, options, &SystemTimeZone)
}

/// [`normalize_feed`] with an explicit local zone.
#[must_use]
pub fn normalize_feed_in(
	feed: &RawFeed,
	options: &NormalizeFeedOptions<'_>,
	zone: &dyn LocalTimeZone,
) -> NormalizedFeed {
	let examined = feed
		.items
		.get(..options.max_items.min(feed.items.len()))
		.unwrap_or_default();
	let reduced: Vec<Reduced> = examined
		.par_iter()
		.enumerate()
		.map(|(index, item)| reduce_item(index, item, options, zone))
		.collect();
	let mut articles = Vec::new();
	let mut rejected = Vec::new();
	let mut seen_urls: HashSet<String> = HashSet::new();
	for outcome in reduced {
		match outcome {
			Reduced::Rejected(rejection) => rejected.push(rejection),
			Reduced::Article(article) => {
				// A repeated canonical URL is skipped silently (not a rejection).
				if seen_urls.insert(article.canonical_url.clone()) {
					articles.push(article);
				}
			}
		}
	}
	NormalizedFeed {
		articles,
		rejected,
		truncated_item_count: feed.items.len() - examined.len(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::news::raw_feed::FeedKind;
	use research_js::date::Utc;
	use serde::Deserialize;
	use serde_json::{Value, json};

	fn vector_file(name: &str) -> String {
		let path = format!("{}/../../vectors/feed/{name}", env!("CARGO_MANIFEST_DIR"));
		std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
	}

	fn report(failures: &[String]) {
		assert!(
			failures.is_empty(),
			"{} mismatches, first: {:#?}",
			failures.len(),
			failures.iter().take(10).collect::<Vec<_>>()
		);
	}

	#[test]
	fn plain_text_matches_typescript() {
		let cases: Vec<(String, String)> =
			serde_json::from_str(&vector_file("plain-text.json")).unwrap();
		assert!(cases.len() > 5000);
		let failures: Vec<String> = cases
			.iter()
			.filter(|(input, output)| to_plain_text(input) != *output)
			.map(|(input, output)| {
				format!("{input:?}: got {:?} want {output:?}", to_plain_text(input))
			})
			.collect();
		report(&failures);
	}

	#[test]
	fn timestamps_match_typescript() {
		let cases: Vec<(Option<String>, Option<String>)> =
			serde_json::from_str(&vector_file("timestamps.json")).unwrap();
		assert!(cases.len() > 5000);
		let failures: Vec<String> = cases
			.iter()
			.filter_map(|(input, output)| {
				let got = parse_feed_timestamp_in(input.as_deref(), &Utc);
				(got != *output).then(|| format!("{input:?}: got {got:?} want {output:?}"))
			})
			.collect();
		report(&failures);
	}

	#[derive(Deserialize)]
	#[serde(rename_all = "camelCase")]
	struct FingerprintCase {
		title: String,
		publisher: String,
		published_at: Option<String>,
		summary: Option<String>,
		canonical_url: String,
	}

	#[test]
	fn fingerprint_material_matches_typescript() {
		#[derive(Deserialize)]
		struct Case {
			input: FingerprintCase,
			output: String,
		}
		let cases: Vec<Case> = serde_json::from_str(&vector_file("fingerprint.json")).unwrap();
		assert!(cases.len() > 1000);
		let failures: Vec<String> = cases
			.iter()
			.filter_map(|case| {
				let input = &case.input;
				let got = article_fingerprint_material(&FingerprintInput {
					title: &input.title,
					publisher: &input.publisher,
					published_at: input.published_at.as_deref(),
					summary: input.summary.as_deref(),
					canonical_url: &input.canonical_url,
				});
				(got != case.output)
					.then(|| format!("{:?}: got {got:?} want {:?}", input.title, case.output))
			})
			.collect();
		report(&failures);
	}

	#[derive(Deserialize)]
	#[serde(rename_all = "camelCase")]
	struct ItemJson {
		title: Option<String>,
		link: Option<String>,
		published_text: Option<String>,
		summary_text: Option<String>,
	}

	#[derive(Deserialize)]
	#[serde(rename_all = "camelCase")]
	struct FeedJson {
		kind: String,
		title: Option<String>,
		site_link: Option<String>,
		items: Vec<ItemJson>,
	}

	#[derive(Deserialize)]
	#[serde(rename_all = "camelCase")]
	struct OptionsJson {
		publisher: String,
		retrieved_at: String,
		license_policy: String,
		max_items: usize,
	}

	#[derive(Deserialize)]
	struct NormalizeCase {
		feed: FeedJson,
		options: OptionsJson,
		output: Value,
	}

	fn output_json(result: &NormalizedFeed) -> Value {
		json!({
			"articles": result.articles.iter().map(|article| json!({
				"canonicalUrl": article.canonical_url,
				"title": article.title,
				"publisher": article.publisher,
				"publishedAt": article.published_at,
				"retrievedAt": article.retrieved_at,
				"excerpt": article.excerpt,
				"fingerprintMaterial": article.fingerprint_material,
			})).collect::<Vec<_>>(),
			"rejected": result.rejected.iter().map(|rejection| match rejection {
				FeedItemRejection::UnsafeLink { index, detail } =>
					json!({ "reason": rejection.reason(), "index": index, "detail": detail.as_str() }),
				_ => json!({ "reason": rejection.reason(), "index": rejection.index() }),
			}).collect::<Vec<_>>(),
			"truncatedItemCount": result.truncated_item_count,
		})
	}

	#[test]
	fn normalize_feed_matches_typescript() {
		let cases: Vec<NormalizeCase> =
			serde_json::from_str(&vector_file("normalize.json")).unwrap();
		assert!(cases.len() > 1000);
		let mut failures = Vec::new();
		for case in &cases {
			let feed = RawFeed {
				kind: if case.feed.kind == "atom" {
					FeedKind::Atom
				} else {
					FeedKind::Rss
				},
				title: case.feed.title.clone(),
				site_link: case.feed.site_link.clone(),
				items: case
					.feed
					.items
					.iter()
					.map(|item| RawFeedItem {
						title: item.title.clone(),
						link: item.link.clone(),
						published_text: item.published_text.clone(),
						summary_text: item.summary_text.clone(),
					})
					.collect(),
			};
			let options = NormalizeFeedOptions {
				publisher: &case.options.publisher,
				retrieved_at: &case.options.retrieved_at,
				license_policy: if case.options.license_policy == "short-excerpt-permitted" {
					LicensePolicy::ShortExcerptPermitted
				} else {
					LicensePolicy::HeadlineAndLinkOnly
				},
				max_items: case.options.max_items,
			};
			let got = output_json(&normalize_feed_in(&feed, &options, &Utc));
			if got != case.output {
				failures.push(format!("got {got}\nwant {}", case.output));
			}
		}
		report(&failures);
	}

	#[test]
	fn bounds_titles_without_splitting_surrogate_pairs() {
		let title = "📈".repeat(200);
		let truncated = truncate(title, MAX_TITLE_LENGTH);
		assert_eq!(utf16::utf16_len(&truncated), 299);
		assert!(truncated.ends_with('…'));
		assert_eq!(truncate("t".repeat(300), MAX_TITLE_LENGTH).len(), 300);
	}
}
