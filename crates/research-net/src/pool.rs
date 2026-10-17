//! Idle HTTPS connections kept for reuse (ADR-0030 change C1).
//!
//! The TypeScript opened a fresh socket per request (`agent: false`), which
//! made every GDELT call pay a ~5 s TLS handshake. Reuse is safe under these
//! rules, each enforced here or by the caller and each covered by a test:
//! - the key is (validated host name, peer IP): a connection whose TLS
//!   certificate was verified for one name never serves another name, even
//!   at the same address (no HTTP/2 coalescing, HTTP/1.1 only);
//! - a pooled connection is only offered for an IP contained in the CURRENT
//!   DNS answer, after that whole answer passed the all-public check (the
//!   transport resolves and classifies before it consults the pool), so a
//!   name that now resolves to a non-public address is refused exactly as
//!   before (SEC-002);
//! - only a connection that delivered a complete 2xx response is returned
//!   (abort, timeout, byte cap, decode error, non-2xx and `Connection: close`
//!   all close it), so no half-read body can desynchronise the next request;
//! - idle connections close after [`IDLE_TIMEOUT`]; at most
//!   [`MAX_IDLE_PER_KEY`] per key and [`MAX_IDLE_TOTAL`] in all.
//!
//! There is no proxy support at all (Node's `agent: false` ignored proxies too).

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Empty;
use hyper::client::conn::http1::SendRequest;
use tokio::task::AbortHandle;
use tokio::time::Instant;

/// Idle connections close after this long (comfortably above GDELT's 5 s spacing).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// Most idle connections kept for one (host, IP).
pub const MAX_IDLE_PER_KEY: usize = 4;
/// Most idle connections kept in all.
pub const MAX_IDLE_TOTAL: usize = 64;

/// Aborts the connection's driver task (closing the socket) when dropped.
#[derive(Debug)]
pub(crate) struct DriverGuard(pub(crate) AbortHandle);

impl Drop for DriverGuard {
	fn drop(&mut self) {
		self.0.abort();
	}
}

/// One HTTP/1.1 connection: the request half plus the task driving the socket.
pub(crate) struct Connection {
	pub(crate) sender: SendRequest<Empty<Bytes>>,
	// Field order: the sender drops first, then the driver is aborted.
	pub(crate) _driver: DriverGuard,
}

/// (validated host name, peer IP).
pub(crate) type PoolKey = (String, IpAddr);

struct Idle {
	connection: Connection,
	since: Instant,
}

#[derive(Default)]
struct PoolState {
	idle: HashMap<PoolKey, Vec<Idle>>,
	total: usize,
	sweeper_running: bool,
}

/// The idle-connection pool of one connector (shared by the text and the
/// binary fetcher when they share the connector).
#[derive(Default)]
pub struct ConnectionPool {
	state: Mutex<PoolState>,
}

impl std::fmt::Debug for ConnectionPool {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("ConnectionPool")
			.field("idle", &self.idle_count())
			.finish()
	}
}

fn expired(idle: &Idle, now: Instant) -> bool {
	now.saturating_duration_since(idle.since) >= IDLE_TIMEOUT || idle.connection.sender.is_closed()
}

impl ConnectionPool {
	fn lock(&self) -> MutexGuard<'_, PoolState> {
		// A panic while holding the lock cannot leave the map inconsistent
		// for a reader (every mutation is a single push/remove).
		self.state.lock().unwrap_or_else(PoisonError::into_inner)
	}

	/// Number of idle connections (tests and diagnostics).
	#[must_use]
	pub fn idle_count(&self) -> usize {
		self.lock().total
	}

	/// Whether a live idle connection exists for `key`.
	pub(crate) fn has_idle(&self, host: &str, address: IpAddr) -> bool {
		let state = self.lock();
		let now = Instant::now();
		state
			.idle
			.get(&(host.to_owned(), address))
			.is_some_and(|entries| entries.iter().any(|idle| !expired(idle, now)))
	}

	/// Takes the most recently used live connection for `key`.
	pub(crate) fn take(&self, host: &str, address: IpAddr) -> Option<Connection> {
		let mut state = self.lock();
		let key = (host.to_owned(), address);
		let now = Instant::now();
		let entries = state.idle.get_mut(&key)?;
		let mut taken = None;
		let mut removed = 0;
		while let Some(idle) = entries.pop() {
			removed += 1;
			if !expired(&idle, now) {
				taken = Some(idle.connection);
				break;
			}
		}
		if entries.is_empty() {
			state.idle.remove(&key);
		}
		state.total = state.total.saturating_sub(removed);
		taken
	}

	/// Returns a connection that completed a 2xx response cleanly.
	pub(crate) fn put(self: &Arc<Self>, key: PoolKey, connection: Connection) {
		if connection.sender.is_closed() {
			return;
		}
		let start_sweeper;
		{
			let mut state = self.lock();
			let entries = state.idle.entry(key).or_default();
			let mut evicted = 0;
			if entries.len() >= MAX_IDLE_PER_KEY {
				// Oldest first: entries are kept in return order.
				entries.remove(0);
				evicted += 1;
			}
			entries.push(Idle {
				connection,
				since: Instant::now(),
			});
			state.total = state.total + 1 - evicted;
			while state.total > MAX_IDLE_TOTAL {
				if !evict_oldest(&mut state) {
					break;
				}
			}
			start_sweeper = !state.sweeper_running;
			state.sweeper_running = true;
		}
		if start_sweeper {
			// Closes idle connections on time even when no request comes.
			tokio::spawn(sweep(Arc::downgrade(self)));
		}
	}

	/// Drops expired entries; returns the earliest remaining expiry.
	fn sweep_now(&self) -> Option<Instant> {
		let mut state = self.lock();
		let now = Instant::now();
		let mut removed = 0;
		state.idle.retain(|_, entries| {
			let before = entries.len();
			entries.retain(|idle| !expired(idle, now));
			removed += before - entries.len();
			!entries.is_empty()
		});
		state.total = state.total.saturating_sub(removed);
		let next = state
			.idle
			.values()
			.flatten()
			.map(|idle| idle.since + IDLE_TIMEOUT)
			.min();
		if next.is_none() {
			state.sweeper_running = false;
		}
		next
	}
}

fn evict_oldest(state: &mut PoolState) -> bool {
	let oldest = state
		.idle
		.iter()
		.filter_map(|(key, entries)| entries.first().map(|idle| (idle.since, key.clone())))
		.min_by_key(|(since, _)| *since);
	let Some((_, key)) = oldest else {
		return false;
	};
	if let Some(entries) = state.idle.get_mut(&key) {
		if !entries.is_empty() {
			entries.remove(0);
			state.total = state.total.saturating_sub(1);
		}
		if entries.is_empty() {
			state.idle.remove(&key);
		}
	}
	true
}

async fn sweep(pool: Weak<ConnectionPool>) {
	loop {
		let Some(next) = pool.upgrade().and_then(|pool| pool.sweep_now()) else {
			return;
		};
		// Wake a little after the earliest expiry; also re-check closed sockets
		// at least every 15 s so a server-side close frees its slot.
		let wake = next.min(Instant::now() + Duration::from_secs(15));
		tokio::time::sleep_until(wake + Duration::from_millis(10)).await;
	}
}
