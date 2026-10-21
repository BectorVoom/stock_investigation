//! TLS to an address the caller has ALREADY validated (SEC-002, connection
//! layer; the socket half of `pinnedConnect.ts`).
//!
//! The TCP connection goes to the IP literal itself, so nothing below
//! resolves the name again: there is no second lookup an attacker could
//! answer differently (DNS rebinding / TOCTOU). TLS stays fully verified
//! against the host name, not the address:
//!   address    = validated IP literal -> where the TCP connection goes
//!   SNI + cert = host name            -> certificate identity check
//! There is no way to switch verification off; the only deviations
//! ([`PinnedTlsOverrides`]) exist so tests can run this exact code against a
//! local server.
//!
//! The peer address is compared with the validated address right after the
//! TCP connect, BEFORE the TLS handshake and before any request byte
//! (`PINNED_ADDRESS_MISMATCH`).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use rustls::ClientConfig;
#[cfg(any(test, feature = "test-seams"))]
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::dns::ValidatedAddress;
use crate::errors::io_error_code;

/// A connection-level failure, as a `describeThrown` label (`ECONNREFUSED`,
/// `ERR_TLS_CERT_ALTNAME_INVALID`, `PINNED_ADDRESS_MISMATCH`, …).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ConnectError(pub String);

impl ConnectError {
	/// A static label.
	#[must_use]
	pub fn code(code: &str) -> Self {
		Self(code.to_owned())
	}
}

/// The TLS client configuration could not be built.
#[derive(Debug, thiserror::Error)]
pub enum TlsSetupError {
	/// rustls refused the protocol versions or the provider.
	#[error("TLS configuration failed: {0}")]
	Config(#[from] rustls::Error),
	/// The extra test root is not a usable PEM certificate.
	#[error("the extra trusted root is not a valid PEM certificate")]
	InvalidRoot,
}

/// TEST SEAMS (`PinnedTlsOverrides` in the TypeScript), compiled only with
/// the `test-seams` feature, which the production binary never enables. Note
/// what is deliberately absent even here: there is no way to switch
/// verification off.
#[cfg(any(test, feature = "test-seams"))]
#[derive(Clone, Debug, Default)]
pub struct PinnedTlsOverrides {
	/// Port instead of 443.
	pub port: Option<u16>,
	/// An additional trusted root, PEM.
	pub extra_root_pem: Option<String>,
	/// Dial 127.0.0.1 instead of the validated address (the TypeScript's
	/// `loopbackConnect`). The peer check then expects 127.0.0.1, while the
	/// pool and every caller keep seeing the validated address.
	pub dial_loopback: bool,
}

/// Opens verified TLS connections to validated addresses.
#[derive(Clone)]
pub struct PinnedTls {
	connector: TlsConnector,
	#[cfg(any(test, feature = "test-seams"))]
	port: u16,
	#[cfg(any(test, feature = "test-seams"))]
	dial_loopback: bool,
}

impl std::fmt::Debug for PinnedTls {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter.debug_struct("PinnedTls").finish_non_exhaustive()
	}
}

fn client_config(
	extra_root: Option<CertificateDer<'static>>,
) -> Result<TlsConnector, TlsSetupError> {
	let mut roots = rustls::RootCertStore::empty();
	roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
	if let Some(certificate) = extra_root {
		roots
			.add(certificate)
			.map_err(|_| TlsSetupError::InvalidRoot)?;
	}
	let provider = Arc::new(rustls::crypto::ring::default_provider());
	let config = ClientConfig::builder_with_provider(provider)
		.with_safe_default_protocol_versions()?
		.with_root_certificates(roots)
		.with_no_client_auth();
	Ok(TlsConnector::from(Arc::new(config)))
}

impl PinnedTls {
	/// Production configuration: port 443, the Mozilla root bundle (what
	/// Node ships), TLS 1.2 and 1.3, no ALPN (HTTP/1.1 only, like Node's
	/// `https.request`).
	///
	/// # Errors
	/// When rustls rejects the configuration (not expected with ring).
	pub fn new() -> Result<Self, TlsSetupError> {
		Ok(Self {
			connector: client_config(None)?,
			#[cfg(any(test, feature = "test-seams"))]
			port: 443,
			#[cfg(any(test, feature = "test-seams"))]
			dial_loopback: false,
		})
	}

	/// TEST SEAM: [`PinnedTls::new`] with a test port, root and loopback dialing.
	///
	/// # Errors
	/// An invalid extra root, or a rustls configuration error.
	#[cfg(any(test, feature = "test-seams"))]
	pub fn with_overrides(overrides: &PinnedTlsOverrides) -> Result<Self, TlsSetupError> {
		let extra_root = match &overrides.extra_root_pem {
			Some(pem) => Some(
				CertificateDer::from_pem_slice(pem.as_bytes())
					.map_err(|_| TlsSetupError::InvalidRoot)?,
			),
			None => None,
		};
		Ok(Self {
			connector: client_config(extra_root)?,
			port: overrides.port.unwrap_or(443),
			dial_loopback: overrides.dial_loopback,
		})
	}

	#[cfg(any(test, feature = "test-seams"))]
	fn dial_target(&self, address: IpAddr) -> SocketAddr {
		let ip = if self.dial_loopback {
			IpAddr::V4(Ipv4Addr::LOCALHOST)
		} else {
			address
		};
		SocketAddr::new(ip, self.port)
	}

	#[cfg(not(any(test, feature = "test-seams")))]
	#[allow(clippy::unused_self)]
	fn dial_target(&self, address: IpAddr) -> SocketAddr {
		SocketAddr::new(address, 443)
	}

	/// TCP to the validated address, peer check, then TLS with SNI and
	/// certificate identity = the host name it was resolved for.
	///
	/// # Errors
	/// Connection, peer-mismatch or TLS failure, as a Node error code.
	pub async fn connect(
		&self,
		address: &ValidatedAddress,
	) -> Result<TlsStream<TcpStream>, ConnectError> {
		let dial = self.dial_target(address.ip());
		let tcp = TcpStream::connect(dial)
			.await
			.map_err(|error| ConnectError::code(io_error_code(&error)))?;
		// Belt and braces: whatever happened below us, refuse to speak to a
		// peer that is not the address that was validated — before TLS and
		// before any request byte.
		let peer = tcp
			.peer_addr()
			.map_err(|error| ConnectError::code(io_error_code(&error)))?;
		verify_peer(peer.ip(), dial.ip())?;
		// Node's http client disables Nagle too; small requests go out at once.
		tcp.set_nodelay(true)
			.map_err(|error| ConnectError::code(io_error_code(&error)))?;
		let server_name = ServerName::try_from(address.hostname().to_owned())
			.map_err(|_| ConnectError::code("ERR_TLS_CERT_ALTNAME_INVALID"))?;
		self.connector
			.connect(server_name, tcp)
			.await
			.map_err(|error| ConnectError::code(io_error_code(&error)))
	}
}

/// The peer must be exactly the validated address. An IPv4-mapped IPv6 peer
/// does not equal its IPv4 address (Node compares canonical texts, which
/// differ too).
///
/// # Errors
/// `PINNED_ADDRESS_MISMATCH`.
pub fn verify_peer(peer: IpAddr, expected: IpAddr) -> Result<(), ConnectError> {
	if peer == expected {
		Ok(())
	} else {
		Err(ConnectError::code("PINNED_ADDRESS_MISMATCH"))
	}
}

/// `isSameIpAddress(actual, expected)`: true only when both texts are valid
/// IP addresses (Node's `isIP` forms) denoting the same address.
#[must_use]
pub fn is_same_ip_address(actual: Option<&str>, expected: &str) -> bool {
	let Some(actual) = actual.and_then(parse_ip_text) else {
		return false;
	};
	parse_ip_text(expected).is_some_and(|expected| expected == actual)
}

/// Node's `isIP` grammar: strict dotted-decimal IPv4, or IPv6 text. A zone
/// suffix (`fe80::1%en0`) passes `isIP` but the TypeScript's canonical form
/// (`new URL("http://[…]/")`) rejects it, so it never compares equal.
fn parse_ip_text(text: &str) -> Option<IpAddr> {
	if text.contains(':') {
		return text.parse::<std::net::Ipv6Addr>().ok().map(IpAddr::V6);
	}
	// std rejects leading zeros, exactly like Node's isIPv4.
	text.parse::<Ipv4Addr>().ok().map(IpAddr::V4)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn compares_addresses_by_value_like_node() {
		let same = |a: Option<&str>, b: &str| is_same_ip_address(a, b);
		assert!(same(Some("93.184.216.34"), "93.184.216.34"));
		assert!(same(Some("2606:2800:220:1:0:0:0:1"), "2606:2800:220:1::1"));
		assert!(same(
			Some("2606:2800:220:1::1"),
			"2606:2800:0220:0001:0000:0000:0000:0001"
		));
		assert!(!same(Some("93.184.216.35"), "93.184.216.34"));
		assert!(!same(Some("127.0.0.1"), "93.184.216.34"));
		assert!(!same(None, "93.184.216.34"));
		assert!(!same(Some("not-an-ip"), "not-an-ip"));
		assert!(verify_peer("127.0.0.1".parse().unwrap(), "127.0.0.1".parse().unwrap()).is_ok());
		assert_eq!(
			verify_peer(
				"::ffff:127.0.0.1".parse().unwrap(),
				"127.0.0.1".parse().unwrap()
			),
			Err(ConnectError::code("PINNED_ADDRESS_MISMATCH"))
		);
	}

	#[test]
	fn production_configuration_builds_and_dials_port_443() {
		let tls = PinnedTls::new().unwrap();
		assert_eq!(
			tls.dial_target("93.184.216.34".parse().unwrap()),
			"93.184.216.34:443".parse().unwrap()
		);
		assert!(matches!(
			PinnedTls::with_overrides(&PinnedTlsOverrides {
				extra_root_pem: Some("not a pem".to_owned()),
				..PinnedTlsOverrides::default()
			}),
			Err(TlsSetupError::InvalidRoot)
		));
	}
}
