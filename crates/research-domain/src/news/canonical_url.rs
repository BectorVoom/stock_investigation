//! Port of `packages/domain/src/news/canonicalUrl.ts`.

use research_js::utf16;
use url::Url;

use super::url_policy::{UrlPolicyError, validate_fetch_url};

const TRACKING_PARAMETERS: [&str; 11] = [
	"fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid", "yclid", "ref_src",
	"cmpid", "ocid",
];

fn is_tracking_parameter(name: &str) -> bool {
	let lower = name.to_lowercase();
	lower.starts_with("utm_") || TRACKING_PARAMETERS.contains(&lower.as_str())
}

/// Canonical form used as the article identity (FR-003): lower-case host, no
/// fragment, no tracking parameters, stable parameter order, no trailing
/// slash on non-root paths. Two URLs that differ only in those respects are
/// one article.
///
/// Parameters sort by UTF-16 code units, never by locale, so the Worker and
/// the runner always derive the same identity (ARCH-011).
///
/// # Errors
/// The URL policy's verdict when the URL is not fetchable.
pub fn canonicalize_article_url(raw_url: &str) -> Result<String, UrlPolicyError> {
	let validated = validate_fetch_url(raw_url)?;
	let mut url = Url::parse(&validated.href).map_err(|_| UrlPolicyError::MalformedUrl)?;
	url.set_fragment(None);
	url.set_host(Some(&validated.hostname))
		.map_err(|_| UrlPolicyError::MalformedUrl)?;
	let mut kept: Vec<(String, String)> = url
		.query_pairs()
		.filter(|(name, _)| !is_tracking_parameter(name))
		.map(|(name, value)| (name.into_owned(), value.into_owned()))
		.collect();
	// A stable sort, like Array.prototype.sort.
	kept.sort_by(|(name_a, value_a), (name_b, value_b)| {
		utf16::compare(name_a, name_b).then_with(|| utf16::compare(value_a, value_b))
	});
	if kept.is_empty() {
		url.set_query(None);
	} else {
		let search = url::form_urlencoded::Serializer::new(String::new())
			.extend_pairs(&kept)
			.finish();
		url.set_query(Some(&search));
	}
	let path = url.path();
	if path.len() > 1 && path.ends_with('/') {
		let trimmed = path.trim_end_matches('/').to_owned();
		url.set_path(&trimmed);
	}
	Ok(url.as_str().to_owned())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn canonicalizes_like_the_typescript() {
		assert_eq!(
			canonicalize_article_url("https://News.Example.org/a/b/?utm_source=x&b=2&a=1#frag")
				.unwrap(),
			"https://news.example.org/a/b?a=1&b=2"
		);
		assert_eq!(
			canonicalize_article_url("https://a.org/?fbclid=1").unwrap(),
			"https://a.org/"
		);
		assert_eq!(
			canonicalize_article_url("https://a.org/x?q=a+b&q=a%20a").unwrap(),
			"https://a.org/x?q=a+a&q=a+b"
		);
	}
}
