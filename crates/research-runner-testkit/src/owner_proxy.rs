//! `X-E2E-Owner` injection. The production API client has no hook for extra
//! headers (and must not get one), so the E2E runner talks to this loopback
//! proxy, which forwards every request to the E2E Worker with the owner header
//! added (`tests/e2e/worker.ts` routes on it, so a second runner's credential,
//! agent report and claimed jobs belong to that owner). The client sends one
//! request per connection (`Connection: close`), so rewriting the head of the
//! first request is enough; the rest is a byte pipe.

use std::io;
use std::net::Ipv4Addr;

use tokio::io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

/// The header the E2E Worker routes on.
pub const OWNER_HEADER: &str = "X-E2E-Owner";
/// A request head larger than this is refused (the runner's heads are tiny).
const MAX_HEAD_BYTES: usize = 64 * 1024;

/// Why the proxy could not start.
#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
	/// The upstream URL has no host or port.
	#[error("the E2E origin is not a usable URL")]
	Upstream,
	/// The owner contains characters that cannot travel in a header value.
	#[error("E2E_RUNNER_OWNER is not a valid header value")]
	Owner,
	/// The loopback listener could not be bound.
	#[error("the owner proxy could not listen")]
	Listen(#[from] io::Error),
}

/// Rewrites a request head: `Host` points at the upstream and the owner
/// header replaces any existing one. `head` excludes the blank line.
fn rewrite_head(head: &str, authority: &str, owner: &str) -> String {
	let mut lines = head.split("\r\n");
	let mut out = String::with_capacity(head.len() + 64);
	out.push_str(lines.next().unwrap_or_default());
	out.push_str("\r\n");
	for line in lines {
		let name = line.split(':').next().unwrap_or_default();
		if name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case(OWNER_HEADER) {
			continue;
		}
		out.push_str(line);
		out.push_str("\r\n");
	}
	out.push_str(&format!(
		"Host: {authority}\r\n{OWNER_HEADER}: {owner}\r\n\r\n"
	));
	out
}

/// Reads up to and including the blank line; returns the head (without it)
/// and any body bytes read past it.
async fn read_head(client: &mut TcpStream) -> io::Result<(String, Vec<u8>)> {
	let mut buffer = Vec::with_capacity(1024);
	let mut chunk = [0_u8; 4096];
	loop {
		if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
			let rest = buffer.split_off(end + 4);
			buffer.truncate(end);
			let head = String::from_utf8(buffer).map_err(|_| {
				io::Error::new(io::ErrorKind::InvalidData, "request head is not UTF-8")
			})?;
			return Ok((head, rest));
		}
		if buffer.len() > MAX_HEAD_BYTES {
			return Err(io::Error::new(
				io::ErrorKind::InvalidData,
				"request head too large",
			));
		}
		let read = client.read(&mut chunk).await?;
		if read == 0 {
			return Err(io::ErrorKind::UnexpectedEof.into());
		}
		buffer.extend_from_slice(chunk.get(..read).unwrap_or_default());
	}
}

async fn forward(
	mut client: TcpStream,
	upstream: (String, u16),
	authority: String,
	owner: String,
) -> io::Result<()> {
	let (head, rest) = read_head(&mut client).await?;
	let mut server = TcpStream::connect((upstream.0.as_str(), upstream.1)).await?;
	server
		.write_all(rewrite_head(&head, &authority, &owner).as_bytes())
		.await?;
	server.write_all(&rest).await?;
	copy_bidirectional(&mut client, &mut server).await?;
	Ok(())
}

/// Starts the proxy on an ephemeral loopback port and returns its base URL.
/// The accept loop lives as long as the runtime.
///
/// # Errors
/// An unusable upstream URL or owner, or a listener that cannot bind.
pub async fn start(origin: &str, owner: &str) -> Result<String, ProxyError> {
	if owner.is_empty() || owner.chars().any(char::is_control) {
		return Err(ProxyError::Owner);
	}
	let upstream = Url::parse(origin).map_err(|_| ProxyError::Upstream)?;
	let host = upstream.host_str().ok_or(ProxyError::Upstream)?.to_owned();
	let port = upstream
		.port_or_known_default()
		.ok_or(ProxyError::Upstream)?;
	let authority = match upstream.port() {
		Some(explicit) => format!("{host}:{explicit}"),
		None => host.clone(),
	};
	let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
	let local = listener.local_addr()?;
	let owner = owner.to_owned();
	tokio::spawn(async move {
		loop {
			let Ok((client, _)) = listener.accept().await else {
				continue;
			};
			let (host, authority, owner) = (host.clone(), authority.clone(), owner.clone());
			tokio::spawn(async move {
				// A failed connection is the client's to retry (its own backoff).
				let _ = forward(client, (host, port), authority, owner).await;
			});
		}
	});
	Ok(format!("http://{local}"))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_head_gets_the_upstream_host_and_the_owner() {
		let head = "POST /api/v1/runner/jobs/claim HTTP/1.1\r\nhost: 127.0.0.1:9\r\nauthorization: Bearer t\r\nx-e2e-owner: spoof";
		assert_eq!(
			rewrite_head(head, "localhost:8799", "second@example.test"),
			"POST /api/v1/runner/jobs/claim HTTP/1.1\r\nauthorization: Bearer t\r\nHost: localhost:8799\r\nX-E2E-Owner: second@example.test\r\n\r\n"
		);
	}

	#[tokio::test]
	async fn a_request_reaches_the_upstream_with_the_owner_header() {
		let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
		let origin = format!("http://{}", upstream.local_addr().unwrap());
		let proxy = start(&origin, "owner@example.test").await.unwrap();
		let proxy_address = proxy.trim_start_matches("http://").to_owned();
		let client = tokio::spawn(async move {
			let mut stream = TcpStream::connect(proxy_address).await.unwrap();
			stream
				.write_all(b"POST /x HTTP/1.1\r\nHost: wrong\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi")
				.await
				.unwrap();
			let mut reply = String::new();
			stream.read_to_string(&mut reply).await.unwrap();
			reply
		});
		let (mut served, _) = upstream.accept().await.unwrap();
		let mut received = Vec::new();
		let mut chunk = [0_u8; 512];
		while !received.ends_with(b"\r\n\r\nhi") {
			let read = served.read(&mut chunk).await.unwrap();
			received.extend_from_slice(&chunk[..read]);
		}
		let text = String::from_utf8(received).unwrap();
		assert!(
			text.contains("X-E2E-Owner: owner@example.test\r\n"),
			"{text}"
		);
		assert!(text.contains(&format!(
			"Host: {}\r\n",
			origin.trim_start_matches("http://")
		)));
		assert!(!text.contains("Host: wrong"));
		served
			.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
			.await
			.unwrap();
		drop(served);
		assert!(client.await.unwrap().ends_with("ok"));
	}

	#[tokio::test]
	async fn an_owner_with_control_characters_is_refused() {
		assert!(matches!(
			start("http://127.0.0.1:1", "a\r\nb").await,
			Err(ProxyError::Owner)
		));
	}
}
