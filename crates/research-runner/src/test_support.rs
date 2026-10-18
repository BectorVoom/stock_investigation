//! Helpers shared by the unit tests of this crate.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use research_effects::{EventLogger, JsonEventLogger, LogClock, RecordingLogger};

/// 2026-10-12T00:00:00.000Z, the instant of the TypeScript log tests.
const FIXED_NOW_MS: i64 = 1_791_763_200_000;

struct FixedClock;

impl LogClock for FixedClock {
	fn now_ms(&self) -> i64 {
		FIXED_NOW_MS
	}
}

/// A real [`JsonEventLogger`] writing to memory, so tests assert the exact
/// lines `runner.log` would contain.
pub(crate) struct RecordedLogger {
	sink: Arc<RecordingLogger>,
	logger: Arc<dyn EventLogger>,
}

impl RecordedLogger {
	pub(crate) fn new() -> Self {
		let sink = Arc::new(RecordingLogger::new());
		let logger: Arc<dyn EventLogger> =
			Arc::new(JsonEventLogger::new(Arc::clone(&sink), FixedClock));
		Self { sink, logger }
	}

	pub(crate) fn logger(&self) -> Arc<dyn EventLogger> {
		Arc::clone(&self.logger)
	}

	pub(crate) fn lines(&self) -> Vec<String> {
		self.sink.lines()
	}

	/// Event names in the order they were logged.
	pub(crate) fn events(&self) -> Vec<String> {
		self.lines()
			.iter()
			.filter_map(|line| {
				let start = line.find("\"event\":\"")? + 9;
				let rest = line.get(start..)?;
				Some(rest.get(..rest.find('"')?)?.to_owned())
			})
			.collect()
	}
}

/* ---------- a fake Worker over a real socket ---------- */

/// What the fake Worker saw.
#[derive(Clone, Debug)]
pub(crate) struct Recorded {
	pub(crate) path: String,
	pub(crate) headers: Vec<(String, String)>,
	pub(crate) body: String,
}

impl Recorded {
	pub(crate) fn header(&self, name: &str) -> Option<&str> {
		self.headers
			.iter()
			.find(|(key, _)| key == name)
			.map(|(_, value)| value.as_str())
	}
}

#[derive(Clone)]
pub(crate) enum Reply {
	Json(u16, String),
	Redirect(String),
	Raw(u16, String),
	Hang,
	/// Headers promise 100 bytes, 10 arrive, then the socket closes.
	Truncated(u16),
	/// Headers promise 100 bytes, 10 arrive, then silence.
	StallBody(u16),
}

pub(crate) fn json(status: u16, payload: &str) -> Reply {
	Reply::Json(status, payload.to_owned())
}

pub(crate) struct FakeWorker {
	pub(crate) url: String,
	pub(crate) seen: Arc<Mutex<Vec<Recorded>>>,
}

impl FakeWorker {
	pub(crate) fn requests(&self) -> Vec<Recorded> {
		self.seen.lock().unwrap().clone()
	}
}

/// Serves the scripted replies in order (the last one repeats), one request per connection.
pub(crate) async fn serve(script: Vec<Reply>) -> FakeWorker {
	let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
	let url = format!("http://{}", listener.local_addr().unwrap());
	let seen = Arc::new(Mutex::new(Vec::<Recorded>::new()));
	let record = Arc::clone(&seen);
	tokio::spawn(async move {
		loop {
			let Ok((mut stream, _)) = listener.accept().await else {
				return;
			};
			let mut buffer = Vec::new();
			let mut chunk = [0_u8; 4096];
			let (head_end, length) = loop {
				let read = stream.read(&mut chunk).await.unwrap_or(0);
				if read == 0 {
					break (0, 0);
				}
				buffer.extend_from_slice(&chunk[..read]);
				let text = String::from_utf8_lossy(&buffer).into_owned();
				if let Some(end) = text.find("\r\n\r\n") {
					let length = text[..end]
						.lines()
						.find_map(|line| {
							line.to_ascii_lowercase()
								.strip_prefix("content-length:")
								.and_then(|value| value.trim().parse::<usize>().ok())
						})
						.unwrap_or(0);
					break (end + 4, length);
				}
			};
			if head_end == 0 {
				continue;
			}
			while buffer.len() < head_end + length {
				let read = stream.read(&mut chunk).await.unwrap_or(0);
				if read == 0 {
					break;
				}
				buffer.extend_from_slice(&chunk[..read]);
			}
			let text = String::from_utf8_lossy(&buffer).into_owned();
			let mut lines = text[..head_end].lines();
			let request_line = lines.next().unwrap_or_default().to_owned();
			let headers = lines
				.filter_map(|line| line.split_once(':'))
				.map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
				.collect();
			let index = {
				let mut seen = record.lock().unwrap();
				seen.push(Recorded {
					path: request_line
						.split(' ')
						.nth(1)
						.unwrap_or_default()
						.to_owned(),
					headers,
					body: text[head_end..].to_owned(),
				});
				seen.len() - 1
			};
			let reply = script
				.get(index)
				.or_else(|| script.last())
				.cloned()
				.unwrap_or(Reply::Hang);
			let response = match reply {
				Reply::Json(status, body) => format!(
					"HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
					body.len()
				),
				Reply::Raw(status, body) => format!(
					"HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
					body.len()
				),
				Reply::Redirect(location) => format!(
					"HTTP/1.1 302 Found\r\nlocation: {location}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
				),
				Reply::Truncated(status) => format!(
					"HTTP/1.1 {status} X\r\ncontent-length: 100\r\nconnection: close\r\n\r\n0123456789"
				),
				Reply::StallBody(status) => {
					let head =
						format!("HTTP/1.1 {status} X\r\ncontent-length: 100\r\n\r\n0123456789");
					let _ = stream.write_all(head.as_bytes()).await;
					tokio::spawn(async move {
						let mut sink = [0_u8; 64];
						while stream.read(&mut sink).await.unwrap_or(0) > 0 {}
					});
					continue;
				}
				Reply::Hang => {
					// Keep the socket open and silent until the client gives up.
					tokio::spawn(async move {
						let mut sink = [0_u8; 64];
						while stream.read(&mut sink).await.unwrap_or(0) > 0 {}
					});
					continue;
				}
			};
			let _ = stream.write_all(response.as_bytes()).await;
			let _ = stream.shutdown().await;
		}
	});
	FakeWorker { url, seen }
}
