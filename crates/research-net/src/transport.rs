//! The DNS-pinning hop transport and the production fetchers (port of
//! `packages/adapters/src/node/index.ts`, SEC-002).
//!
//! The runner sits on the owner's PC, so the threat is a URL that reaches the
//! home network: a router admin page, a NAS, a service on loopback, a cloud
//! metadata address. String checks on the URL cannot stop that, because DNS
//! may map any innocent-looking name to such an address.
//!
//! Enforcement, per hop (the target and every redirect):
//!  1. string policy + allowlist (shared core);
//!  2. the caller's redirect authorizer before each redirect hop (shared core);
//!  3. resolve the host name ONCE, taking every A/AAAA answer;
//!  4. refuse the hop unless EVERY answer is a public address. A single
//!     non-public answer rejects the name, so a mixed answer cannot be used to
//!     win a race for the private one;
//!  5. use one of the first [`MAX_CONNECT_ATTEMPTS`] validated addresses as
//!     an IP literal (`tls.rs`), with TLS verified against the host name. The
//!     name is never resolved again, so a second, different DNS answer
//!     (rebinding) has nothing to influence. A pooled connection (ADR-0030
//!     C1) is only used for an address of THIS answer, after step 4 passed;
//!     such addresses are tried first.
//!
//! Response size: `max_bytes` is enforced twice — on the bytes read from the
//! socket before content decoding (`pinned.rs`) and on the decoded bytes
//! (shared core) — and the connection is closed when either is exceeded.
//!
//! RESIDUAL RISK
//!  - "Public" is decided by `classify_ip_address`; a range it wrongly treats
//!    as public would be reachable. Addresses that are public but routed back
//!    into the owner's network by their own router/VPN (hairpin NAT,
//!    split-horizon VPN ranges using public space) are indistinguishable from
//!    the Internet.
//!  - The resolver itself is trusted to report what it resolved.
//!  - This adapter is the only guard in the process: code that opens sockets
//!    directly bypasses it. OS-level egress filtering remains the stronger
//!    control and is out of scope here.

use std::sync::Arc;

use async_trait::async_trait;

use crate::core::{HopOutcome, HopRequest, HopResponse, HopTransport, SafeFetchCore};
use crate::dns::{DnsLookup, ResolveError, SystemLookup, ValidatedAddress, resolve_public_with};
use crate::pinned::{PinnedConnect, PinnedHttpsConnect, PinnedRequest, PinnedResponse};
use crate::tls::{PinnedTls, TlsSetupError};

/// Validated addresses tried in order before giving up on a hop.
pub const MAX_CONNECT_ATTEMPTS: usize = 3;

/// The production `SafeFetcher` + `SafeBinaryFetcher`.
pub type NodeSafeFetcher = SafeFetchCore<PinnedHopTransport>;

/// TEST SEAMS only (`NodeSafeFetcherOverrides`), compiled only with the
/// `test-seams` feature. An override replaces system DNS or the pinned TLS
/// connection, so it removes the corresponding guarantee.
#[cfg(any(test, feature = "test-seams"))]
#[derive(Clone, Default)]
pub struct NodeSafeFetcherOverrides {
	/// Replaces the OS resolver.
	pub lookup: Option<Arc<dyn DnsLookup>>,
	/// Replaces the pinned HTTPS connection.
	pub connect: Option<Arc<dyn PinnedConnect>>,
}

/// One process-wide fetcher (text and binary share the transport and its
/// connection pool): OS resolver, verified TLS to port 443, keep-alive pool.
///
/// # Errors
/// When the TLS configuration cannot be built.
pub fn create_node_safe_fetcher() -> Result<NodeSafeFetcher, TlsSetupError> {
	Ok(SafeFetchCore::new(Arc::new(PinnedHopTransport {
		lookup: Arc::new(SystemLookup),
		connect: Arc::new(PinnedHttpsConnect::new(PinnedTls::new()?)),
	})))
}

/// TEST SEAM: [`create_node_safe_fetcher`] with replaced parts.
///
/// # Errors
/// When the TLS configuration cannot be built.
#[cfg(any(test, feature = "test-seams"))]
pub fn create_node_safe_fetcher_with(
	overrides: NodeSafeFetcherOverrides,
) -> Result<NodeSafeFetcher, TlsSetupError> {
	let lookup = overrides.lookup.unwrap_or_else(|| Arc::new(SystemLookup));
	let connect: Arc<dyn PinnedConnect> = match overrides.connect {
		Some(connect) => connect,
		None => Arc::new(PinnedHttpsConnect::new(PinnedTls::new()?)),
	};
	Ok(SafeFetchCore::new(Arc::new(PinnedHopTransport {
		lookup,
		connect,
	})))
}

/// The per-hop transport: resolve, classify every answer, then a pinned GET.
/// Built only by [`create_node_safe_fetcher`] (or the test seam).
pub struct PinnedHopTransport {
	lookup: Arc<dyn DnsLookup>,
	connect: Arc<dyn PinnedConnect>,
}

fn to_outcome(response: PinnedResponse) -> HopOutcome {
	HopOutcome::Response(HopResponse {
		status: response.status,
		location: response.location,
		content_type: response.content_type,
		content_length: response.content_length,
		retry_after: response.retry_after,
		body: response.body,
	})
}

#[async_trait]
impl HopTransport for PinnedHopTransport {
	async fn hop(&self, request: HopRequest<'_>) -> HopOutcome {
		let addresses = match resolve_public_with(self.lookup.as_ref(), request.hostname).await {
			Ok(addresses) => addresses,
			Err(ResolveError::LookupFailed(code)) => {
				return HopOutcome::NetworkError {
					detail: format!("DNS lookup failed: {code}"),
				};
			}
			Err(ResolveError::NoAddresses) => {
				return HopOutcome::NetworkError {
					detail: "DNS lookup returned no addresses".to_owned(),
				};
			}
			// Described by class only; the address itself is never echoed.
			Err(ResolveError::NotPublic(class)) => {
				return HopOutcome::UnsafeDestination {
					detail: format!("host resolves to a {} address", class.as_str()),
				};
			}
		};

		let candidates = addresses.get(..MAX_CONNECT_ATTEMPTS).unwrap_or(&addresses);
		// ADR-0030 C1: an address with an idle connection goes first (stable),
		// so DNS round-robin does not defeat reuse; the set of addresses and
		// their count stay the TypeScript's.
		let mut ordered: Vec<&ValidatedAddress> = candidates.iter().collect();
		ordered.sort_by_key(|address| !self.connect.has_idle(address));

		let path = request.path_and_query();
		let mut last_failure = "no connection attempted".to_owned();
		for address in ordered {
			if request.signal.aborted() {
				break;
			}
			let pinned = PinnedRequest {
				address,
				path: &path,
				headers: request.headers,
				max_encoded_bytes: request.max_bytes,
				json_body: request.json_body,
			};
			match self.connect.connect(pinned).await {
				Ok(response) => return to_outcome(response),
				// The body may have reached the server: sending it again elsewhere
				// would repeat a non-idempotent request.
				Err(error) if error.body_sent => {
					return HopOutcome::NetworkError {
						detail: error.detail,
					};
				}
				// Typically an unreachable address family; the next validated address may work.
				Err(error) => last_failure = error.detail,
			}
		}
		HopOutcome::NetworkError {
			detail: last_failure,
		}
	}
}

#[cfg(test)]
mod tests {
	//! `nodeSafeFetcher.test.ts` "resolution failures and address fallback"
	//! over a scripted DNS + connection layer (no sockets).
	use std::collections::{BTreeSet, HashMap};
	use std::sync::Mutex;

	use bytes::Bytes;
	use research_application::ports::{
		SafeFetchError, SafeFetchErrorCode, SafeFetchOptions, SafeFetcher,
	};

	use std::net::IpAddr;

	use super::*;
	use crate::core::{BodyError, HopBody};
	use crate::dns::LookupError;
	use crate::tls::ConnectError;

	const PUBLIC_V4: &str = "93.184.216.34";
	const PUBLIC_V4_B: &str = "151.101.1.69";
	const PUBLIC_V6: &str = "2606:2800:220:1:248:1893:25c8:1946";

	fn ip(text: &str) -> IpAddr {
		text.parse().unwrap()
	}

	struct FakeDns {
		answers: HashMap<String, Result<Vec<IpAddr>, LookupError>>,
		lookups: Mutex<Vec<String>>,
	}

	#[async_trait]
	impl DnsLookup for FakeDns {
		async fn lookup(&self, hostname: &str) -> Result<Vec<IpAddr>, LookupError> {
			self.lookups.lock().unwrap().push(hostname.to_owned());
			self.answers
				.get(hostname)
				.cloned()
				.unwrap_or_else(|| Ok(vec![ip(PUBLIC_V4)]))
		}
	}

	fn dns(answers: &[(&str, Result<Vec<IpAddr>, LookupError>)]) -> Arc<FakeDns> {
		Arc::new(FakeDns {
			answers: answers
				.iter()
				.map(|(host, answer)| ((*host).to_owned(), answer.clone()))
				.collect(),
			lookups: Mutex::new(Vec::new()),
		})
	}

	struct OneChunk(Option<Bytes>);

	#[async_trait]
	impl HopBody for OneChunk {
		async fn next_chunk(&mut self) -> Option<Result<Bytes, BodyError>> {
			self.0.take().map(Ok)
		}
	}

	/// Serves `body` from every address except those in `refuse` (with their code).
	struct FakeConnect {
		refuse: HashMap<IpAddr, &'static str>,
		/// Addresses that fail after the body may have reached them.
		hang_up_after_body: BTreeSet<IpAddr>,
		idle: BTreeSet<IpAddr>,
		attempted: Mutex<Vec<(String, IpAddr, String)>>,
		bodies: Mutex<Vec<Option<Vec<u8>>>>,
	}

	#[async_trait]
	impl PinnedConnect for FakeConnect {
		async fn connect(
			&self,
			request: PinnedRequest<'_>,
		) -> Result<PinnedResponse, ConnectError> {
			self.attempted.lock().unwrap().push((
				request.address.hostname().to_owned(),
				request.address.ip(),
				request.path.to_owned(),
			));
			self.bodies
				.lock()
				.unwrap()
				.push(request.json_body.map(<[u8]>::to_vec));
			if let Some(code) = self.refuse.get(&request.address.ip()) {
				return Err(ConnectError::code(code));
			}
			if self.hang_up_after_body.contains(&request.address.ip()) {
				return Err(ConnectError::code("ECONNRESET").after_body_sent());
			}
			Ok(PinnedResponse {
				status: 200,
				location: None,
				content_type: Some("text/plain".to_owned()),
				content_length: None,
				retry_after: None,
				body: Box::new(OneChunk(Some(Bytes::from_static(b"reached")))),
			})
		}

		fn has_idle(&self, address: &ValidatedAddress) -> bool {
			self.idle.contains(&address.ip())
		}
	}

	fn connect(refuse: &[(&str, &'static str)], idle: &[&str]) -> Arc<FakeConnect> {
		Arc::new(FakeConnect {
			refuse: refuse
				.iter()
				.map(|(address, code)| (ip(address), *code))
				.collect(),
			hang_up_after_body: BTreeSet::new(),
			idle: idle.iter().map(|address| ip(address)).collect(),
			attempted: Mutex::new(Vec::new()),
			bodies: Mutex::new(Vec::new()),
		})
	}

	fn fetcher(lookup: Arc<FakeDns>, connect: Arc<FakeConnect>) -> NodeSafeFetcher {
		create_node_safe_fetcher_with(NodeSafeFetcherOverrides {
			lookup: Some(lookup),
			connect: Some(connect),
		})
		.unwrap()
	}

	fn limits() -> SafeFetchOptions {
		SafeFetchOptions {
			max_bytes: 10_000,
			timeout_ms: 2_000,
			accept: "text/plain".to_owned(),
			cancel: None,
			allowed_hosts: None,
			authorize_redirect: None,
			user_agent: None,
			authorization: None,
			finnhub_token: None,
			include_error_body: false,
			json_body: None,
		}
	}

	fn failure(code: SafeFetchErrorCode, detail: &str) -> SafeFetchError {
		SafeFetchError::new(code, detail.to_owned())
	}

	fn attempted(connect: &FakeConnect) -> Vec<IpAddr> {
		connect
			.attempted
			.lock()
			.unwrap()
			.iter()
			.map(|(_, address, _)| *address)
			.collect()
	}

	#[tokio::test]
	async fn reports_a_dns_failure_without_connecting() {
		let network = connect(&[], &[]);
		let lookup = dns(&[(
			"nowhere.synthetic-wire.org",
			Err(LookupError("ENOTFOUND".to_owned())),
		)]);
		let result = fetcher(lookup, network.clone())
			.fetch_text("https://nowhere.synthetic-wire.org/", &limits())
			.await;
		assert_eq!(
			result,
			Err(failure(
				SafeFetchErrorCode::NetworkError,
				"DNS lookup failed: ENOTFOUND"
			))
		);
		assert!(attempted(&network).is_empty());
	}

	#[tokio::test]
	async fn treats_an_empty_dns_answer_as_a_failure_not_as_permission() {
		let network = connect(&[], &[]);
		let lookup = dns(&[("empty.synthetic-wire.org", Ok(vec![]))]);
		let result = fetcher(lookup, network.clone())
			.fetch_text("https://empty.synthetic-wire.org/", &limits())
			.await;
		assert_eq!(
			result,
			Err(failure(
				SafeFetchErrorCode::NetworkError,
				"DNS lookup returned no addresses"
			))
		);
		assert!(attempted(&network).is_empty());
	}

	#[tokio::test]
	async fn refuses_any_non_public_answer_before_connecting() {
		for (answers, class) in [
			(vec![ip("10.0.0.9")], "non-public"),
			(vec![ip(PUBLIC_V4), ip("127.0.0.1")], "non-public"),
			(vec![ip(PUBLIC_V4), ip("::ffff:192.168.1.1")], "non-public"),
			(vec![ip("fe80::1")], "non-public"),
		] {
			let network = connect(&[], &[]);
			let lookup = dns(&[("internal.example.com", Ok(answers))]);
			let result = fetcher(lookup, network.clone())
				.fetch_text("https://internal.example.com/admin", &limits())
				.await;
			assert_eq!(
				result,
				Err(failure(
					SafeFetchErrorCode::UnsafeUrl,
					&format!("host resolves to a {class} address")
				))
			);
			assert!(attempted(&network).is_empty());
		}
	}

	#[tokio::test]
	async fn falls_back_to_the_next_validated_address_when_one_is_unreachable() {
		let network = connect(&[(PUBLIC_V6, "ENETUNREACH")], &[]);
		let lookup = dns(&[(
			"dual.synthetic-wire.org",
			Ok(vec![ip(PUBLIC_V6), ip(PUBLIC_V4)]),
		)]);
		let document = fetcher(lookup.clone(), network.clone())
			.fetch_text("https://dual.synthetic-wire.org/?", &limits())
			.await
			.unwrap();
		assert_eq!(document.text, "reached");
		assert_eq!(attempted(&network), [ip(PUBLIC_V6), ip(PUBLIC_V4)]);
		assert_eq!(*lookup.lookups.lock().unwrap(), ["dual.synthetic-wire.org"]);
		// An empty query is not sent ("/", not "/?").
		assert_eq!(network.attempted.lock().unwrap()[0].2, "/");
	}

	#[tokio::test]
	async fn tries_at_most_three_addresses_and_reports_the_last_code() {
		let addresses = [PUBLIC_V4, PUBLIC_V4_B, "8.8.8.8", "1.1.1.1"];
		let network = connect(
			&[
				(PUBLIC_V4, "ECONNREFUSED"),
				(PUBLIC_V4_B, "ETIMEDOUT"),
				("8.8.8.8", "ECONNRESET"),
			],
			&[],
		);
		let lookup = dns(&[(
			"refused.synthetic-wire.org",
			Ok(addresses.iter().map(|a| ip(a)).collect()),
		)]);
		let result = fetcher(lookup, network.clone())
			.fetch_text("https://refused.synthetic-wire.org/", &limits())
			.await;
		assert_eq!(
			result,
			Err(failure(SafeFetchErrorCode::NetworkError, "ECONNRESET"))
		);
		assert_eq!(attempted(&network).len(), 3);
	}

	#[tokio::test]
	async fn tries_an_address_with_an_idle_connection_first() {
		// ADR-0030 C1: DNS round-robin must not defeat reuse, but only answers of
		// the current, all-public resolution are candidates.
		let network = connect(&[], &[PUBLIC_V4_B, "8.8.4.4"]);
		let lookup = dns(&[(
			"rotating.synthetic-wire.org",
			Ok(vec![
				ip(PUBLIC_V4),
				ip(PUBLIC_V4_B),
				ip("1.1.1.1"),
				ip("8.8.4.4"),
			]),
		)]);
		fetcher(lookup, network.clone())
			.fetch_text("https://rotating.synthetic-wire.org/", &limits())
			.await
			.unwrap();
		// 8.8.4.4 is idle but fourth in the answer: never a candidate.
		assert_eq!(attempted(&network), [ip(PUBLIC_V4_B)]);
	}

	fn post_limits() -> SafeFetchOptions {
		SafeFetchOptions {
			allowed_hosts: Some(BTreeSet::from(["post.synthetic-wire.org".to_owned()])),
			json_body: Some(r#"{"query":"q"}"#.to_owned()),
			..limits()
		}
	}

	#[tokio::test]
	async fn a_post_falls_back_only_while_its_body_was_not_sent() {
		let lookup = || {
			dns(&[(
				"post.synthetic-wire.org",
				Ok(vec![ip(PUBLIC_V6), ip(PUBLIC_V4), ip(PUBLIC_V4_B)]),
			)])
		};
		// Unreachable before any byte: the next validated address is tried.
		let network = connect(&[(PUBLIC_V6, "ENETUNREACH")], &[]);
		let document = fetcher(lookup(), network.clone())
			.fetch_text("https://post.synthetic-wire.org/search", &post_limits())
			.await
			.unwrap();
		assert_eq!(document.text, "reached");
		assert_eq!(attempted(&network), [ip(PUBLIC_V6), ip(PUBLIC_V4)]);
		assert_eq!(
			*network.bodies.lock().unwrap(),
			[
				Some(br#"{"query":"q"}"#.to_vec()),
				Some(br#"{"query":"q"}"#.to_vec())
			]
		);

		// Failed after the body may have arrived: never sent to another address.
		let hung_up = Arc::new(FakeConnect {
			hang_up_after_body: BTreeSet::from([ip(PUBLIC_V6)]),
			..Arc::into_inner(connect(&[], &[])).unwrap()
		});
		let result = fetcher(lookup(), hung_up.clone())
			.fetch_text("https://post.synthetic-wire.org/search", &post_limits())
			.await;
		assert_eq!(
			result,
			Err(failure(SafeFetchErrorCode::NetworkError, "ECONNRESET"))
		);
		assert_eq!(attempted(&hung_up), [ip(PUBLIC_V6)]);
	}
}
