//! Ephemeral IPv4 loopback callback with Host/state validation and fixed, non-reflecting pages.
use research_finance::ports::{Secret, Sleeper};
use std::sync::{
	Arc,
	atomic::{AtomicBool, Ordering},
};
use tokio::{
	io::{AsyncReadExt, AsyncWriteExt},
	net::{TcpListener, TcpStream},
	sync::watch,
	task::JoinSet,
};
use tokio_util::sync::CancellationToken;
/// Successful browser page, exact bytes from TypeScript.
pub const SUCCESS_PAGE: &str = "<!doctype html><html><head><meta charset=utf-8><title>Connected</title></head><body><p>Google Calendar is connected. You can close this tab.</p></body></html>";
/// Consent-denied browser page.
pub const DENIED_PAGE: &str = "<!doctype html><html><head><meta charset=utf-8><title>Not connected</title></head><body><p>Google Calendar was not connected: consent was denied. You can close this tab.</p></body></html>";
/// Generic failure browser page.
pub const FAILED_PAGE: &str = "<!doctype html><html><head><meta charset=utf-8><title>Not connected</title></head><body><p>Google Calendar was not connected: the request failed. You can close this tab.</p></body></html>";
/// Settles once; authorization codes have redacted Debug output.
#[derive(Clone, Debug)]
pub enum LoopbackResult {
	/// OAuth authorization code.
	Code(Secret),
	/// Provider denied the grant.
	Denied,
	/// Five-minute deadline.
	Timeout,
	/// Run stop, explicit close or server error.
	Aborted,
}
/// Listen failure without request data.
#[derive(Debug, thiserror::Error)]
#[error("loopback listen failed: {0}")]
pub struct LoopbackError(std::io::Error);
/// Lifetime of one loopback listener. Always close after using it.
pub struct LoopbackHandle {
	/// Bound port, always nonzero.
	pub port: u16,
	/// Desktop OAuth redirect URI.
	pub redirect_uri: String,
	result: watch::Receiver<Option<LoopbackResult>>,
	close: CancellationToken,
	task: Option<tokio::task::JoinHandle<()>>,
}
impl LoopbackHandle {
	/// Waits for the one terminal result; subsequent calls return the same result.
	pub async fn wait(&mut self) -> LoopbackResult {
		loop {
			if let Some(result) = self.result.borrow().clone() {
				return result;
			}
			if self.result.changed().await.is_err() {
				return LoopbackResult::Aborted;
			}
		}
	}
	/// Closes and joins the listener and all accepted sockets; idempotent.
	pub async fn close(&mut self) {
		self.close.cancel();
		if let Some(task) = self.task.take() {
			let _ = task.await;
		}
	}
}
impl Drop for LoopbackHandle {
	fn drop(&mut self) {
		self.close.cancel();
	}
}
fn states_equal(a: &str, b: &str) -> bool {
	if a.len() != b.len() {
		return false;
	}
	// No early exit on a differing byte. The state itself is public in the authorization URL.
	a.bytes()
		.zip(b.bytes())
		.fold(0u8, |difference, (a, b)| difference | (a ^ b))
		== 0
}
struct Callback {
	expected_host: String,
	state: String,
	max_code_length: usize,
	settled: AtomicBool,
	result: watch::Sender<Option<LoopbackResult>>,
}
fn decide(
	method: &str,
	target: &str,
	host: Option<&str>,
	callback: &Callback,
) -> (u16, &'static str, Option<LoopbackResult>) {
	if callback.settled.load(Ordering::SeqCst)
		|| method != "GET"
		|| host != Some(callback.expected_host.as_str())
	{
		return (404, FAILED_PAGE, None);
	}
	let url = url::Url::parse("http://127.0.0.1/").and_then(|base| base.join(target));
	let Ok(url) = url else {
		return (404, FAILED_PAGE, None);
	};
	if url.path() != "/" || url.host_str() != Some("127.0.0.1") || url.port().is_some() {
		return (404, FAILED_PAGE, None);
	}
	let params: Vec<_> = url.query_pairs().collect();
	let get = |key| {
		params
			.iter()
			.find(|(k, _)| k == key)
			.map(|(_, v)| v.as_ref())
	};
	if !get("state").is_some_and(|state| states_equal(state, &callback.state)) {
		return (400, FAILED_PAGE, None);
	}
	let result = if let Some(error) = get("error") {
		(
			if error == "access_denied" {
				DENIED_PAGE
			} else {
				FAILED_PAGE
			},
			LoopbackResult::Denied,
		)
	} else {
		let Some(code) = get("code").filter(|s| {
			!s.is_empty() && research_js::utf16::utf16_len(s) <= callback.max_code_length
		}) else {
			return (400, FAILED_PAGE, None);
		};
		(SUCCESS_PAGE, LoopbackResult::Code(Secret::new(code)))
	};
	if callback.settled.swap(true, Ordering::SeqCst) {
		return (404, FAILED_PAGE, None);
	}
	(200, result.0, Some(result.1))
}
async fn serve(mut socket: TcpStream, callback: Arc<Callback>, cancel: CancellationToken) -> bool {
	let mut bytes = Vec::with_capacity(1024);
	let head = loop {
		let mut chunk = [0; 1024];
		let read = tokio::select! { biased; () = cancel.cancelled() => return false,result = socket.read(&mut chunk) => result };
		let Ok(count) = read else {
			return false;
		};
		if count == 0 || bytes.len() + count > 16 * 1024 {
			return false;
		}
		bytes.extend_from_slice(chunk.get(..count).unwrap_or_default());
		if let Some(at) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
			break at + 4;
		}
	};
	let mut headers = [httparse::EMPTY_HEADER; 100];
	let mut request = httparse::Request::new(&mut headers);
	if !request
		.parse(bytes.get(..head).unwrap_or_default())
		.is_ok_and(|s| s.is_complete())
	{
		return false;
	}
	let host = request
		.headers
		.iter()
		.find(|h| h.name.eq_ignore_ascii_case("host"))
		.and_then(|h| std::str::from_utf8(h.value).ok());
	let (status, page, result) = decide(
		request.method.unwrap_or(""),
		request.path.unwrap_or(""),
		host,
		&callback,
	);
	let reason = match status {
		200 => "OK",
		400 => "Bad Request",
		_ => "Not Found",
	};
	let response = format!(
		"HTTP/1.1 {status} {reason}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-security-policy: default-src 'none'\r\ncache-control: no-store\r\nreferrer-policy: no-referrer\r\nx-content-type-options: nosniff\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{page}",
		page.len()
	);
	// Publish after flushing so a caller that immediately closes cannot reset the success page.
	let _ = socket.write_all(response.as_bytes()).await;
	let _ = socket.shutdown().await;
	if let Some(result) = result {
		callback.result.send_replace(Some(result));
		true
	} else {
		false
	}
}
/// Binds 127.0.0.1:0; all timers and sockets are scoped to the returned handle.
pub async fn start_loopback_listener(
	state: String,
	timeout_ms: u64,
	cancel: CancellationToken,
	sleep: Arc<dyn Sleeper>,
	max_code_length: usize,
) -> Result<LoopbackHandle, LoopbackError> {
	let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
		.await
		.map_err(LoopbackError)?;
	let port = listener.local_addr().map_err(LoopbackError)?.port();
	let (sender, result) = watch::channel(None);
	let callback = Arc::new(Callback {
		expected_host: format!("127.0.0.1:{port}"),
		state,
		max_code_length,
		settled: AtomicBool::new(false),
		result: sender,
	});
	let close = CancellationToken::new();
	let stop = close.clone();
	// The TypeScript starts the timeout sleep before `listen` returns, so an
	// injected sleep observes it before any later sleep of the caller: poll
	// it once here instead of leaving that to the spawned task.
	let timer_cancel = CancellationToken::new();
	let mut timer: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
		if cancel.is_cancelled() {
			// Already stopped: the TypeScript never starts the timeout.
			Box::pin(std::future::pending())
		} else {
			let sleep = sleep.clone();
			let token = timer_cancel.clone();
			Box::pin(async move { sleep.sleep(timeout_ms, Some(&token)).await })
		};
	let timer_ready =
		std::future::poll_fn(|cx| std::task::Poll::Ready(timer.as_mut().poll(cx).is_ready())).await;
	let task = tokio::spawn(async move {
		let mut clients = JoinSet::new();
		let terminal = loop {
			tokio::select! {
				biased;
				() = cancel.cancelled() => break Some(LoopbackResult::Aborted),
				() = stop.cancelled() => break Some(LoopbackResult::Aborted),
				() = async { if !timer_ready { (&mut timer).await } } => break Some(LoopbackResult::Timeout),
				joined = clients.join_next(), if !clients.is_empty() => { if matches!(joined,Some(Ok(true))) { break None; } },
				accepted = listener.accept() => match accepted { Ok((socket,_)) => { clients.spawn(serve(socket,callback.clone(),stop.clone())); },Err(_) => break Some(LoopbackResult::Aborted) },
			}
		};
		timer_cancel.cancel();
		drop(listener);
		if let Some(result) = terminal {
			if !callback.settled.swap(true, Ordering::SeqCst) {
				callback.result.send_replace(Some(result));
			}
		}
		clients.abort_all();
		while clients.join_next().await.is_some() {}
	});
	Ok(LoopbackHandle {
		port,
		redirect_uri: format!("http://127.0.0.1:{port}/"),
		result,
		close,
		task: Some(task),
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	struct NeverSleep;

	#[async_trait::async_trait]
	impl Sleeper for NeverSleep {
		async fn sleep(&self, _ms: u64, cancel: Option<&CancellationToken>) {
			match cancel {
				Some(cancel) => cancel.cancelled().await,
				None => std::future::pending().await,
			}
		}
	}

	async fn listener(cancel: CancellationToken) -> LoopbackHandle {
		start_loopback_listener(
			"state-1".to_owned(),
			300_000,
			cancel,
			Arc::new(NeverSleep),
			500,
		)
		.await
		.unwrap()
	}

	/// The raw response to one raw request, or empty when the socket was dropped.
	async fn raw(port: u16, request: &str) -> String {
		let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
		stream.write_all(request.as_bytes()).await.unwrap();
		let mut out = Vec::new();
		let _ = stream.read_to_end(&mut out).await;
		String::from_utf8_lossy(&out).into_owned()
	}

	fn get(port: u16, target: &str) -> String {
		format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
	}

	fn status(response: &str) -> &str {
		response.lines().next().unwrap_or("")
	}

	#[tokio::test]
	async fn rejects_a_non_root_path_without_closing() {
		let mut handle = listener(CancellationToken::new()).await;
		let port = handle.port;
		assert_eq!(
			status(&raw(port, &get(port, "/other?state=state-1&code=c")).await),
			"HTTP/1.1 404 Not Found"
		);
		assert_eq!(
			status(&raw(port, &get(port, "/?state=state-1&code=ok")).await),
			"HTTP/1.1 200 OK"
		);
		assert!(matches!(handle.wait().await, LoopbackResult::Code(code) if code.expose() == "ok"));
		handle.close().await;
	}

	#[tokio::test]
	async fn answers_an_unparseable_target_without_crashing_and_keeps_listening() {
		let mut handle = listener(CancellationToken::new()).await;
		let port = handle.port;
		assert_eq!(
			status(&raw(port, &get(port, "//[")).await),
			"HTTP/1.1 404 Not Found"
		);
		assert_eq!(
			status(&raw(port, &get(port, "/?state=state-1&code=ok")).await),
			"HTTP/1.1 200 OK"
		);
		assert!(matches!(handle.wait().await, LoopbackResult::Code(_)));
		handle.close().await;
	}

	#[tokio::test]
	async fn serves_fixed_pages_with_security_headers_and_never_reflects_input() {
		let mut handle = listener(CancellationToken::new()).await;
		let port = handle.port;
		let wrong = raw(port, &get(port, "/?state=state-1&code=&x=%3Cscript%3E")).await;
		assert!(wrong.starts_with("HTTP/1.1 400 Bad Request"));
		assert!(wrong.ends_with(FAILED_PAGE));
		assert!(!wrong.contains("script"));
		let denied = raw(port, &get(port, "/?state=state-1&error=access_denied")).await;
		assert!(denied.ends_with(DENIED_PAGE));
		for header in [
			"content-type: text/html; charset=utf-8",
			"content-security-policy: default-src 'none'",
			"cache-control: no-store",
			"referrer-policy: no-referrer",
			"x-content-type-options: nosniff",
			"connection: close",
		] {
			assert!(denied.contains(header), "{header}");
		}
		assert!(denied.contains(&format!("content-length: {}", DENIED_PAGE.len())));
		assert!(matches!(handle.wait().await, LoopbackResult::Denied));
		handle.close().await;
	}

	#[tokio::test]
	async fn other_provider_errors_get_the_generic_page() {
		let mut handle = listener(CancellationToken::new()).await;
		let port = handle.port;
		let failed = raw(port, &get(port, "/?state=state-1&error=server_error")).await;
		assert!(failed.starts_with("HTTP/1.1 200 OK") && failed.ends_with(FAILED_PAGE));
		assert!(matches!(handle.wait().await, LoopbackResult::Denied));
		handle.close().await;
	}

	#[tokio::test]
	async fn drops_a_malformed_request_without_writing_anything() {
		let mut handle = listener(CancellationToken::new()).await;
		let port = handle.port;
		assert_eq!(raw(port, "NOT HTTP AT ALL\r\n\r\n").await, "");
		assert_eq!(
			status(&raw(port, &get(port, "/?state=state-1&code=ok")).await),
			"HTTP/1.1 200 OK"
		);
		handle.close().await;
	}

	#[tokio::test]
	async fn the_first_callback_closes_the_port() {
		let mut handle = listener(CancellationToken::new()).await;
		let port = handle.port;
		assert_eq!(
			status(&raw(port, &get(port, "/?state=state-1&code=first")).await),
			"HTTP/1.1 200 OK"
		);
		assert!(
			matches!(handle.wait().await, LoopbackResult::Code(code) if code.expose() == "first")
		);
		handle.close().await;
		assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
		// A second wait still reports the one result.
		assert!(
			matches!(handle.wait().await, LoopbackResult::Code(code) if code.expose() == "first")
		);
	}

	#[tokio::test]
	async fn abort_resolves_aborted_and_closes_the_port() {
		let cancel = CancellationToken::new();
		let mut handle = listener(cancel.clone()).await;
		let port = handle.port;
		cancel.cancel();
		assert!(matches!(handle.wait().await, LoopbackResult::Aborted));
		handle.close().await;
		assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
	}

	#[tokio::test]
	async fn an_already_stopped_run_never_starts_the_timeout() {
		struct Counting(std::sync::atomic::AtomicUsize);
		#[async_trait::async_trait]
		impl Sleeper for Counting {
			async fn sleep(&self, _: u64, _: Option<&CancellationToken>) {
				self.0.fetch_add(1, Ordering::SeqCst);
			}
		}
		let cancel = CancellationToken::new();
		cancel.cancel();
		let sleeper = Arc::new(Counting(std::sync::atomic::AtomicUsize::new(0)));
		let mut handle = start_loopback_listener("s".to_owned(), 1, cancel, sleeper.clone(), 500)
			.await
			.unwrap();
		assert!(matches!(handle.wait().await, LoopbackResult::Aborted));
		assert_eq!(sleeper.0.load(Ordering::SeqCst), 0);
		handle.close().await;
	}

	#[tokio::test]
	async fn the_timeout_resolves_timeout_and_a_callback_releases_its_wait() {
		struct Instant;
		#[async_trait::async_trait]
		impl Sleeper for Instant {
			async fn sleep(&self, _: u64, _: Option<&CancellationToken>) {}
		}
		let mut timed_out = start_loopback_listener(
			"s".to_owned(),
			1,
			CancellationToken::new(),
			Arc::new(Instant),
			500,
		)
		.await
		.unwrap();
		assert!(matches!(timed_out.wait().await, LoopbackResult::Timeout));
		timed_out.close().await;
		// A callback accepted while the timer waits ends that wait: the pending
		// sleep is cancelled (its token fires and the future is dropped).
		let released = Arc::new(AtomicBool::new(false));
		struct Watching(Arc<AtomicBool>);
		struct Release(Arc<AtomicBool>);
		impl Drop for Release {
			fn drop(&mut self) {
				self.0.store(true, Ordering::SeqCst);
			}
		}
		#[async_trait::async_trait]
		impl Sleeper for Watching {
			async fn sleep(&self, _: u64, _: Option<&CancellationToken>) {
				let _guard = Release(self.0.clone());
				std::future::pending::<()>().await;
			}
		}
		let mut handle = start_loopback_listener(
			"state-1".to_owned(),
			300_000,
			CancellationToken::new(),
			Arc::new(Watching(released.clone())),
			500,
		)
		.await
		.unwrap();
		let port = handle.port;
		raw(port, &get(port, "/?state=state-1&code=ok")).await;
		assert!(matches!(handle.wait().await, LoopbackResult::Code(_)));
		handle.close().await;
		for _ in 0..100 {
			if released.load(Ordering::SeqCst) {
				break;
			}
			tokio::time::sleep(std::time::Duration::from_millis(5)).await;
		}
		assert!(released.load(Ordering::SeqCst));
	}
}
