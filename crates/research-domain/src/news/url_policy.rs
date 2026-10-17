//! Port of `packages/domain/src/news/urlPolicy.ts`.
//!
//! String-level URL policy for outbound fetches (SEC-002, layer 1 of 4).
//! Passing this check is necessary but NOT sufficient: adapters must still
//! enforce connection-time destination checks, per-hop redirect validation
//! and byte/time limits, because DNS can map an innocent name to a private
//! address.
//!
//! URLs are parsed with the `url` crate (WHATWG URL Standard, like Node's
//! `URL`); `vectors/domain-news/url-policy.json` pins the two against each
//! other on a corpus of edge cases.

use research_js::utf16;
use url::Url;

use super::ip_classification::looks_like_ip_literal;

/// Why a URL was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UrlPolicyError {
	/// Not an absolute URL.
	MalformedUrl,
	/// Longer than [`MAX_URL_LENGTH`] UTF-16 units.
	UrlTooLong,
	/// Not `https:`.
	SchemeNotAllowed,
	/// Carries a user name or password.
	CredentialsNotAllowed,
	/// Names a port other than the default 443.
	PortNotAllowed,
	/// The host is (or looks like) an IP address.
	IpLiteralNotAllowed,
	/// The host is local, internal, reserved or malformed.
	HostnameNotAllowed,
}

impl UrlPolicyError {
	/// The TypeScript literal, e.g. `"MALFORMED_URL"`.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::MalformedUrl => "MALFORMED_URL",
			Self::UrlTooLong => "URL_TOO_LONG",
			Self::SchemeNotAllowed => "SCHEME_NOT_ALLOWED",
			Self::CredentialsNotAllowed => "CREDENTIALS_NOT_ALLOWED",
			Self::PortNotAllowed => "PORT_NOT_ALLOWED",
			Self::IpLiteralNotAllowed => "IP_LITERAL_NOT_ALLOWED",
			Self::HostnameNotAllowed => "HOSTNAME_NOT_ALLOWED",
		}
	}
}

impl std::fmt::Display for UrlPolicyError {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(self.as_str())
	}
}

impl std::error::Error for UrlPolicyError {}

/// Longest URL accepted, in UTF-16 code units.
pub const MAX_URL_LENGTH: usize = 2048;

const FORBIDDEN_HOST_SUFFIXES: [&str; 12] = [
	".localhost",
	".local",
	".internal",
	".intranet",
	".lan",
	".home",
	".corp",
	".home.arpa",
	".test",
	".invalid",
	".example",
	".onion",
];

/// A URL that passed the policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedFetchUrl {
	/// Normalized absolute URL, safe to hand to a network-restricted fetch adapter.
	pub href: String,
	/// Lower-case host name without a trailing dot.
	pub hostname: String,
}

/// `validateFetchUrl`.
///
/// # Errors
/// The first policy rule the URL breaks, in the TypeScript's order.
pub fn validate_fetch_url(raw_url: &str) -> Result<ValidatedFetchUrl, UrlPolicyError> {
	if utf16::utf16_len(raw_url) > MAX_URL_LENGTH {
		return Err(UrlPolicyError::UrlTooLong);
	}
	let url = Url::parse(raw_url).map_err(|_| UrlPolicyError::MalformedUrl)?;
	if url.scheme() != "https" {
		return Err(UrlPolicyError::SchemeNotAllowed);
	}
	if !url.username().is_empty() || url.password().is_some_and(|password| !password.is_empty()) {
		return Err(UrlPolicyError::CredentialsNotAllowed);
	}
	// The parser drops the default port, so any explicit value is a non-443 port.
	if url.port().is_some() {
		return Err(UrlPolicyError::PortNotAllowed);
	}
	let host = url.host_str().unwrap_or("").to_lowercase();
	let hostname = host.strip_suffix('.').unwrap_or(&host).to_owned();
	if looks_like_ip_literal(&hostname) {
		return Err(UrlPolicyError::IpLiteralNotAllowed);
	}
	if hostname.is_empty()
		|| hostname == "localhost"
		|| !hostname.contains('.')
		// An empty label ("localhost..", "a..b") names nothing resolvable and would dodge the suffix checks.
		|| hostname.split('.').any(str::is_empty)
		|| FORBIDDEN_HOST_SUFFIXES.iter().any(|suffix| hostname.ends_with(suffix))
	{
		return Err(UrlPolicyError::HostnameNotAllowed);
	}
	Ok(ValidatedFetchUrl {
		href: url.as_str().to_owned(),
		hostname,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn applies_the_policy_in_order() {
		let ok = validate_fetch_url("https://News.Example.org./a?b=1#c").unwrap();
		assert_eq!(ok.hostname, "news.example.org");
		assert_eq!(ok.href, "https://news.example.org./a?b=1#c");
		assert_eq!(
			validate_fetch_url("http://example.org/"),
			Err(UrlPolicyError::SchemeNotAllowed)
		);
		assert_eq!(
			validate_fetch_url("https://u:p@a.org/"),
			Err(UrlPolicyError::CredentialsNotAllowed)
		);
		assert_eq!(
			validate_fetch_url("https://a.org:8443/"),
			Err(UrlPolicyError::PortNotAllowed)
		);
		assert_eq!(
			validate_fetch_url("https://a.org:443/").map(|url| url.href),
			Ok("https://a.org/".to_owned())
		);
		assert_eq!(
			validate_fetch_url("https://127.0.0.1/"),
			Err(UrlPolicyError::IpLiteralNotAllowed)
		);
		assert_eq!(
			validate_fetch_url("https://printer.local/"),
			Err(UrlPolicyError::HostnameNotAllowed)
		);
		assert_eq!(
			validate_fetch_url("not a url"),
			Err(UrlPolicyError::MalformedUrl)
		);
	}
}
