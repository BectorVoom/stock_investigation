//! What every streaming HTTPS turn shares (httpTurn.ts): the idle watch, the
//! bounded body read, opening the request, and retrying a request the
//! provider turned away before it generated anything. Each backend keeps only
//! its own wire format, as an [`SseHandler`].
use crate::{
	environment::ProviderEnvironment,
	http::{HttpRequest, TransportError},
	lines::{LineSplitter, MAX_LINE_CHARS},
	turn::*,
};
use async_trait::async_trait;
use futures_util::{StreamExt, stream::BoxStream};
use research_agent_core::runtime::{AgentTurn, TurnSender};
use research_contracts::agent::AgentEvent;
use research_js::whitespace::trim;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

/// No headers/body progress for two minutes ends the turn.
pub const IDLE_TIMEOUT_MS: u64 = 120000;

/// The trimmed key when it can be sent as a header: 8–512 printable ASCII, no spaces.
pub fn read_api_key(value: Option<&String>) -> Option<String> {
	let key = trim(value?);
	if (8..=512).contains(&key.len()) && key.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
		Some(key.to_owned())
	} else {
		None
	}
}
/// Rejected HTTP status mapping, distinct from SSE error status mapping.
pub fn failure_for_http_status(status: u16) -> ProviderFailure {
	if status == 408 {
		ProviderFailure::new("PROVIDER_TIMEOUT")
	} else {
		hint_from_http_status(f64::from(status)).map_or_else(
			|| ProviderFailure::new("PROVIDER_REQUEST_REJECTED"),
			failure_for_hint,
		)
	}
}
/// Only a rejection before any output may be retried.
pub fn is_transient_rejection(failure: &ProviderFailure) -> bool {
	matches!(
		failure.code.as_str(),
		"PROVIDER_UNAVAILABLE" | "PROVIDER_RATE_LIMITED"
	)
}
/// Three exponential waits, bounded by header delay and deadline reserve.
pub fn rejection_retry_delay_ms(
	index: u32,
	retry_after: Option<f64>,
	remaining: f64,
) -> Option<f64> {
	if index >= 3 {
		return None;
	}
	let delay = retry_after.unwrap_or(2000.0 * 2.0_f64.powf(f64::from(index)));
	if delay > 30000.0 || remaining - delay < 30000.0 {
		None
	} else {
		Some(delay)
	}
}
/// Huge digit strings remain infinite/huge and therefore suppress retry.
pub fn parse_retry_after_ms(value: Option<&str>, now: f64) -> Option<f64> {
	let value = trim(value?);
	if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
		return Some(value.parse::<f64>().unwrap_or(f64::INFINITY) * 1000.0);
	}
	let bytes = value.as_bytes();
	if !bytes
		.get(..3)
		.is_some_and(|b| b.iter().all(u8::is_ascii_alphabetic))
		|| bytes.get(3..5) != Some(b", ")
	{
		return None;
	}
	let at = research_js::date::parse(value);
	if at.is_finite() {
		Some((at - now).max(0.0))
	} else {
		None
	}
}

/// A request the provider refused before any output (`AttemptEnd::rejected`).
pub(crate) struct Rejected {
	/// What the turn reports when it is not retried.
	pub(crate) failure: ProviderFailure,
	/// The provider's Retry-After, in milliseconds.
	pub(crate) retry_after: Option<f64>,
	/// Report an unknown cost before the failure (the request may have been read).
	pub(crate) usage: bool,
}
/// Usage then the terminal event.
pub(crate) async fn send_end(
	sender: &TurnSender,
	cost: Option<f64>,
	failure: Option<ProviderFailure>,
) {
	sender
		.send_closing(AgentEvent::Usage {
			known_cost_usd: cost,
		})
		.await;
	sender
		.send_closing(failure.map_or(AgentEvent::Completed, ProviderFailure::event))
		.await;
}
/// One backend's reading of SSE lines.
#[async_trait]
pub(crate) trait SseHandler: Send {
	/// Handles one line; `false` stops reading.
	async fn line(&mut self, line: &str, sender: &TurnSender) -> bool;
}
/// How the body read ended when nothing else decided the turn.
#[derive(Default)]
pub(crate) struct BodyEnd {
	/// More than MAX_RAW_STREAM_CHARS bytes arrived.
	pub(crate) too_large: bool,
	/// The transport failed mid-body.
	pub(crate) read_failed: bool,
}
/// What one request produced.
pub(crate) enum Streamed {
	/// The body was read; the handler holds the rest of the outcome.
	Read(BodyEnd),
	/// The attempt ended before any body: finished (events sent), or rejected.
	Ended(Option<Rejected>),
}
fn idle_deadline() -> tokio::time::Instant {
	tokio::time::Instant::now() + Duration::from_millis(IDLE_TIMEOUT_MS)
}
async fn read_lines<H: SseHandler>(
	mut body: BoxStream<'static, Result<Vec<u8>, TransportError>>,
	guard: &TurnGuard,
	idle: std::pin::Pin<&mut tokio::time::Sleep>,
	handler: &mut H,
	sender: &TurnSender,
) -> BodyEnd {
	let mut idle = idle;
	let mut end = BodyEnd::default();
	let mut splitter = LineSplitter::new(MAX_LINE_CHARS);
	let mut received = 0usize;
	'read: loop {
		let chunk = tokio::select! { biased;
			_=guard.cancel.cancelled()=>break,
			_=&mut idle=>{ guard.stop(StopReason::Idle);break; },
			chunk=body.next()=>chunk,
		};
		match chunk {
			None => {
				for line in splitter.finish() {
					if !handler.line(&line, sender).await {
						break;
					}
				}
				break;
			}
			Some(Err(_)) => {
				end.read_failed = true;
				break;
			}
			Some(Ok(bytes)) => {
				idle.as_mut().reset(idle_deadline());
				received += bytes.len();
				if received > MAX_RAW_STREAM_CHARS {
					end.too_large = true;
					break;
				}
				for line in splitter.push(&bytes) {
					if !handler.line(&line, sender).await {
						break 'read;
					}
				}
			}
		}
	}
	end
}
/// Sends one request and reads its body through `handler`. Everything before
/// the body — the turn stopping, a network error, a rejecting status (with its
/// Retry-After), a missing body — is classified here, as `openStream` does.
pub(crate) async fn stream_request<H: SseHandler>(
	environment: &ProviderEnvironment,
	request: HttpRequest,
	failure_for_status: fn(u16) -> ProviderFailure,
	guard: &TurnGuard,
	handler: &mut H,
	sender: &TurnSender,
) -> Streamed {
	let idle = tokio::time::sleep_until(idle_deadline());
	tokio::pin!(idle);
	let response = tokio::select! { biased;
		_=guard.cancel.cancelled()=>None,
		_=&mut idle=>{ guard.stop(StopReason::Idle);None },
		result=environment.http.send(request,guard.cancel.clone())=>Some(result),
	};
	let response = match response {
		None => {
			// The request may have reached the provider, so the cost is unknown rather than absent.
			send_end(
				sender,
				None,
				Some(failure_for_stop(
					guard.reason().unwrap_or(StopReason::Aborted),
				)),
			)
			.await;
			return Streamed::Ended(None);
		}
		Some(Err(_)) => {
			return Streamed::Ended(Some(Rejected {
				failure: ProviderFailure::new("PROVIDER_UNAVAILABLE"),
				retry_after: None,
				usage: false,
			}));
		}
		Some(Ok(response)) => response,
	};
	if !(200..300).contains(&response.status) {
		// Rejected before generation started: nothing was produced, so no usage is reported.
		return Streamed::Ended(Some(Rejected {
			failure: failure_for_status(response.status),
			retry_after: parse_retry_after_ms(
				response.headers.get("retry-after").map(String::as_str),
				now_ms(),
			),
			usage: false,
		}));
	}
	let Some(body) = response.body else {
		send_end(
			sender,
			None,
			Some(ProviderFailure::new("PROVIDER_OUTPUT_INVALID")),
		)
		.await;
		return Streamed::Ended(None);
	};
	let end = read_lines(body, guard, idle.as_mut(), handler, sender).await;
	Streamed::Read(end)
}
/// One request of a turn; `None` = finished (events sent), `Some` = rejected before output.
#[async_trait]
pub(crate) trait HttpAttempt: Send + Sync + 'static {
	/// Sends the request and reports its events through `sender`.
	async fn attempt(&self, guard: &TurnGuard, sender: &TurnSender) -> Option<Rejected>;
}
/// Runs `attempt` until it finishes, retrying a transient rejection before
/// any output (three waits, within the deadline), as `runHttpTurn` does.
pub(crate) fn run_http_turn<A: HttpAttempt>(
	cancel: &CancellationToken,
	deadline: f64,
	attempt: A,
) -> AgentTurn {
	let attempt = Arc::new(attempt);
	AgentTurn::spawn(cancel, move |sender| async move {
		let guard = TurnGuard::new(sender.cancel_token().clone(), deadline, now_ms());
		for index in 0..=3 {
			let Some(rejected) = attempt.attempt(&guard, &sender).await else {
				break;
			};
			let delay = if is_transient_rejection(&rejected.failure) {
				rejection_retry_delay_ms(index, rejected.retry_after, deadline - now_ms())
			} else {
				None
			};
			let Some(delay) = delay else {
				if rejected.usage {
					sender
						.send_closing(AgentEvent::Usage {
							known_cost_usd: None,
						})
						.await;
				}
				sender.send_closing(rejected.failure.event()).await;
				break;
			};
			let stopped = tokio::select! { biased;_=guard.cancel.cancelled()=>true,_=tokio::time::sleep(Duration::from_secs_f64(delay.max(0.0)/1000.0))=>false };
			if stopped {
				// Nothing is in flight during the wait, so there is no usage to report.
				sender
					.send_closing(
						failure_for_stop(guard.reason().unwrap_or(StopReason::Aborted)).event(),
					)
					.await;
				break;
			}
		}
		guard.stop(StopReason::Finished);
	})
}
