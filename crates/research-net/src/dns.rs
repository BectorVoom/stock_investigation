//! Host name resolution and the destination check (`systemLookup` and
//! `firstUnsafeClass` in `packages/adapters/src/node/index.ts`, SEC-002).
//!
//! Production resolves with the OS resolver, like Node's
//! `dns.lookup(host, {all: true, verbatim: true})`: getaddrinfo, answers in
//! the OS's order, honouring the hosts file and macOS scoped/VPN resolvers.
//!
//! [`resolve_public`] is the only producer of [`ValidatedAddress`]: the
//! answer is refused unless EVERY address in it is public, and only then are
//! its addresses handed out. The connection layer (`tls.rs`, `pinned.rs`)
//! accepts nothing else, so no caller can point it at an arbitrary IP.

use std::io;
use std::net::IpAddr;

use async_trait::async_trait;
use research_domain::news::ip_classification::{IpClass, classify_ip_address};

/// A public address of a host name, taken from a resolution in which every
/// answer classified as public. Constructed only by [`resolve_public`] (and
/// by the `test-seams` feature's [`ValidatedAddress::assume_validated`]).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ValidatedAddress {
	hostname: String,
	ip: IpAddr,
}

impl ValidatedAddress {
	/// The host name it was resolved for (SNI, certificate identity, `Host`).
	#[must_use]
	pub fn hostname(&self) -> &str {
		&self.hostname
	}

	/// The address.
	#[must_use]
	pub fn ip(&self) -> IpAddr {
		self.ip
	}

	/// TEST SEAM: treats `ip` as a validated address of `hostname`.
	#[cfg(any(test, feature = "test-seams"))]
	#[must_use]
	pub fn assume_validated(hostname: &str, ip: IpAddr) -> Self {
		Self {
			hostname: hostname.to_owned(),
			ip,
		}
	}
}

/// Why a host name yields no usable address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolveError {
	/// The resolver failed, with the Node error code (`ENOTFOUND`, …).
	LookupFailed(String),
	/// The resolver answered with no address.
	NoAddresses,
	/// The first answer that is not public, by class only (never the address).
	NotPublic(IpClass),
}

/// Resolves `hostname` with the OS resolver and refuses the whole answer
/// unless every address is public. The addresses keep the resolver's order.
///
/// # Errors
/// A failed or empty lookup, or any non-public answer.
pub async fn resolve_public(hostname: &str) -> Result<Vec<ValidatedAddress>, ResolveError> {
	resolve_public_with(&SystemLookup, hostname).await
}

/// [`resolve_public`] over an injected resolver (the fetcher's test seam;
/// production always passes [`SystemLookup`]).
pub(crate) async fn resolve_public_with(
	lookup: &dyn DnsLookup,
	hostname: &str,
) -> Result<Vec<ValidatedAddress>, ResolveError> {
	let answers = lookup
		.lookup(hostname)
		.await
		.map_err(|LookupError(code)| ResolveError::LookupFailed(code))?;
	if answers.is_empty() {
		return Err(ResolveError::NoAddresses);
	}
	// A single non-public answer rejects the name, so a mixed answer cannot be
	// used to win a race for the private one. The string classifier is the one
	// source of truth (pinned by vectors); `Display` writes IPv4-mapped IPv6
	// with its dotted tail, which it parses.
	if let Some(class) = answers.iter().find_map(|address| {
		let class = classify_ip_address(&address.to_string());
		(class != IpClass::Public).then_some(class)
	}) {
		return Err(ResolveError::NotPublic(class));
	}
	Ok(answers
		.into_iter()
		.map(|ip| ValidatedAddress {
			hostname: hostname.to_owned(),
			ip,
		})
		.collect())
}

/// A failed lookup, as the Node error code (`ENOTFOUND`, `EAI_AGAIN`, …).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LookupError(pub String);

/// Returns every address a name resolves to (`DnsLookup`). `Err` means
/// "could not resolve"; `Ok(vec![])` is reported as a failure by the caller.
/// Implementations other than [`SystemLookup`] reach the fetcher only through
/// the `test-seams` feature.
#[async_trait]
pub trait DnsLookup: Send + Sync {
	/// Resolves `hostname`.
	async fn lookup(&self, hostname: &str) -> Result<Vec<IpAddr>, LookupError>;
}

/// The OS resolver (getaddrinfo on a blocking thread).
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemLookup;

#[async_trait]
impl DnsLookup for SystemLookup {
	async fn lookup(&self, hostname: &str) -> Result<Vec<IpAddr>, LookupError> {
		match tokio::net::lookup_host((hostname, 443)).await {
			Ok(addresses) => {
				let mut answers: Vec<IpAddr> = Vec::with_capacity(4);
				for address in addresses {
					// getaddrinfo can list an address once per socket type; Node's
					// answer has each address once, in first-seen order.
					if !answers.contains(&address.ip()) {
						answers.push(address.ip());
					}
				}
				Ok(answers)
			}
			Err(error) => Err(LookupError(lookup_error_code(&error).to_owned())),
		}
	}
}

/// Node's code for a getaddrinfo failure. std reports it as
/// "failed to lookup address information: <gai_strerror text>", so the text
/// of the platform's message table (glibc and macOS) identifies the code.
fn lookup_error_code(error: &io::Error) -> &'static str {
	if error.raw_os_error().is_some() {
		// EAI_SYSTEM: the errno itself.
		return crate::errors::io_error_code(error);
	}
	let message = error.to_string().to_ascii_lowercase();
	let has = |needle: &str| message.contains(needle);
	if has("nodename nor servname")
		|| has("name or service not known")
		|| has("no address associated")
		|| has("not known")
	{
		// EAI_NONAME / EAI_NODATA: Node reports both as ENOTFOUND.
		"ENOTFOUND"
	} else if has("temporary failure") {
		"EAI_AGAIN"
	} else if has("non-recoverable") {
		"EAI_FAIL"
	} else if has("address family") || has("ai_family") {
		"EAI_FAMILY"
	} else if has("memory") {
		"EAI_MEMORY"
	} else {
		"EAI_FAIL"
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn maps_getaddrinfo_messages_to_node_codes() {
		let message =
			|text: &str| io::Error::other(format!("failed to lookup address information: {text}"));
		assert_eq!(
			lookup_error_code(&message("nodename nor servname provided, or not known")),
			"ENOTFOUND"
		);
		assert_eq!(
			lookup_error_code(&message("Name or service not known")),
			"ENOTFOUND"
		);
		assert_eq!(
			lookup_error_code(&message("No address associated with hostname")),
			"ENOTFOUND"
		);
		assert_eq!(
			lookup_error_code(&message("Temporary failure in name resolution")),
			"EAI_AGAIN"
		);
		assert_eq!(
			lookup_error_code(&message("Non-recoverable failure in name resolution")),
			"EAI_FAIL"
		);
	}

	#[tokio::test]
	async fn the_system_resolver_reports_an_unknown_name_as_enotfound() {
		// `.invalid` is reserved (RFC 6761): resolvers answer NXDOMAIN without asking upstream.
		let result = SystemLookup.lookup("research-net-test.invalid").await;
		assert!(
			matches!(&result, Err(LookupError(code)) if code == "ENOTFOUND" || code == "EAI_AGAIN"),
			"{result:?}"
		);
	}
}
