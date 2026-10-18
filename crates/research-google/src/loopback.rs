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
	let task = tokio::spawn(async move {
		let mut clients = JoinSet::new();
		let timer_cancel = CancellationToken::new();
		let timer = sleep.sleep(timeout_ms, Some(&timer_cancel));
		tokio::pin!(timer);
		let terminal = loop {
			tokio::select! {
				biased;
				() = cancel.cancelled() => break Some(LoopbackResult::Aborted),
				() = stop.cancelled() => break Some(LoopbackResult::Aborted),
				() = &mut timer => break Some(LoopbackResult::Timeout),
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
