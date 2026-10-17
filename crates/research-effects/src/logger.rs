//! `createEventLogger`, `silentEventLogger` and the sinks.

use std::io::Write;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::iso::epoch_ms_to_iso;
use crate::line::{Level, LogValue, format_log_line};
use crate::sanitize::sanitize_log_call;

/// At most one fallback line per minute, however often the writer fails.
const LOG_WRITE_FALLBACK_INTERVAL_MS: i64 = 60_000;

/// The logger every runner component takes. Logging never fails and never
/// panics; a persistent sink failure is observable through
/// [`EventLogger::log_failures`].
pub trait EventLogger: Send + Sync {
	/// Logs `event` at `info`.
	fn info(&self, event: &str, fields: &[(&str, LogValue<'_>)]);
	/// Logs `event` at `warn`.
	fn warn(&self, event: &str, fields: &[(&str, LogValue<'_>)]);
	/// Logs `event` at `error`.
	fn error(&self, event: &str, fields: &[(&str, LogValue<'_>)]);
	/// How many lines the sink failed to write since the logger was built.
	fn log_failures(&self) -> u64;
}

/// Where lines go. One call per complete line.
pub trait LineSink: Send + Sync {
	/// Writes one complete line (it ends with `\n`).
	///
	/// # Errors
	///
	/// Any I/O failure; the logger counts it and carries on.
	fn write_line(&self, line: &str) -> std::io::Result<()>;
}

/// The process's stderr: each line is one `write_all` under the stderr
/// lock, so lines from rayon threads and tokio tasks never interleave
/// (never `eprintln!`, which panics on a closed pipe).
#[derive(Clone, Copy, Debug, Default)]
pub struct StderrSink;

impl LineSink for StderrSink {
	fn write_line(&self, line: &str) -> std::io::Result<()> {
		let mut stderr = std::io::stderr().lock();
		stderr.write_all(line.as_bytes())?;
		stderr.flush()
	}
}

/// The time source of the `at` field.
pub trait LogClock: Send + Sync {
	/// Epoch milliseconds now (`Date.now()`).
	fn now_ms(&self) -> i64;
}

/// The system clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl LogClock for SystemClock {
	fn now_ms(&self) -> i64 {
		let elapsed = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default();
		i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
	}
}

/// `createEventLogger(write, now)`.
pub struct JsonEventLogger<S, C, F = StderrSink> {
	sink: S,
	clock: C,
	fallback: F,
	failures: AtomicU64,
	/// Epoch ms of the last fallback line (`-Infinity` = never).
	last_fallback_at_ms: Mutex<Option<i64>>,
}

impl<S: LineSink, C: LogClock> JsonEventLogger<S, C, StderrSink> {
	/// A logger writing to `sink`, falling back to stderr for the
	/// `log_write_failed` line (the TypeScript's `console.error`).
	pub fn new(sink: S, clock: C) -> Self {
		Self::with_fallback(sink, clock, StderrSink)
	}
}

impl<S: LineSink, C: LogClock, F: LineSink> JsonEventLogger<S, C, F> {
	/// A logger with its own fallback sink (for tests).
	pub fn with_fallback(sink: S, clock: C, fallback: F) -> Self {
		Self {
			sink,
			clock,
			fallback,
			failures: AtomicU64::new(0),
			last_fallback_at_ms: Mutex::new(None),
		}
	}

	fn log(&self, level: Level, event: &str, fields: &[(&str, LogValue<'_>)]) {
		let sanitized = sanitize_log_call(event, fields);
		let at = epoch_ms_to_iso(self.clock.now_ms());
		let line = format_log_line(&at, level, sanitized.event, &sanitized.fields);
		if self.sink.write_line(&line).is_err() {
			self.on_write_error();
		}
	}

	fn on_write_error(&self) {
		self.failures.fetch_add(1, Ordering::Relaxed);
		let at_ms = self.clock.now_ms();
		{
			// A poisoned lock only means another thread panicked mid-update;
			// the timestamp inside is still usable.
			let mut last = self
				.last_fallback_at_ms
				.lock()
				.unwrap_or_else(std::sync::PoisonError::into_inner);
			if last.is_some_and(|last| at_ms - last < LOG_WRITE_FALLBACK_INTERVAL_MS) {
				return;
			}
			*last = Some(at_ms);
		}
		// `console.error(JSON.stringify({at, level: "error", event: "log_write_failed"}))`,
		// best effort: the counter is the only record of its own failure.
		let at = epoch_ms_to_iso(self.clock.now_ms());
		let line = format_log_line(&at, Level::Error, "log_write_failed", &[]);
		let _ = self.fallback.write_line(&line);
	}
}

impl<S: LineSink, C: LogClock, F: LineSink> EventLogger for JsonEventLogger<S, C, F> {
	fn info(&self, event: &str, fields: &[(&str, LogValue<'_>)]) {
		self.log(Level::Info, event, fields);
	}

	fn warn(&self, event: &str, fields: &[(&str, LogValue<'_>)]) {
		self.log(Level::Warn, event, fields);
	}

	fn error(&self, event: &str, fields: &[(&str, LogValue<'_>)]) {
		self.log(Level::Error, event, fields);
	}

	fn log_failures(&self) -> u64 {
		self.failures.load(Ordering::Relaxed)
	}
}

/// `silentEventLogger`: writes nothing.
#[derive(Clone, Copy, Debug, Default)]
pub struct SilentEventLogger;

impl EventLogger for SilentEventLogger {
	fn info(&self, _event: &str, _fields: &[(&str, LogValue<'_>)]) {}
	fn warn(&self, _event: &str, _fields: &[(&str, LogValue<'_>)]) {}
	fn error(&self, _event: &str, _fields: &[(&str, LogValue<'_>)]) {}
	fn log_failures(&self) -> u64 {
		0
	}
}

/// `silentEventLogger`.
#[must_use]
pub const fn silent_event_logger() -> SilentEventLogger {
	SilentEventLogger
}

/// A sink that keeps every line, for assertions.
#[derive(Debug, Default)]
pub struct RecordingLogger {
	lines: Mutex<Vec<String>>,
}

impl RecordingLogger {
	/// An empty recorder.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// The lines written so far.
	#[must_use]
	pub fn lines(&self) -> Vec<String> {
		self.lines
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner)
			.clone()
	}
}

impl LineSink for RecordingLogger {
	fn write_line(&self, line: &str) -> std::io::Result<()> {
		self.lines
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner)
			.push(line.to_owned());
		Ok(())
	}
}

impl<T: LineSink> LineSink for &T {
	fn write_line(&self, line: &str) -> std::io::Result<()> {
		(**self).write_line(line)
	}
}

impl<T: LineSink + ?Sized> LineSink for std::sync::Arc<T> {
	fn write_line(&self, line: &str) -> std::io::Result<()> {
		(**self).write_line(line)
	}
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::AtomicI64;

	use super::*;

	struct FixedClock(AtomicI64);

	impl LogClock for &FixedClock {
		fn now_ms(&self) -> i64 {
			self.0.load(Ordering::Relaxed)
		}
	}

	struct FailingSink;

	impl LineSink for FailingSink {
		fn write_line(&self, _line: &str) -> std::io::Result<()> {
			Err(std::io::Error::other("down"))
		}
	}

	const NOW: i64 = 1_791_763_200_000; // 2026-10-12T00:00:00.000Z

	#[test]
	fn writes_the_pinned_line_format() {
		let recorder = RecordingLogger::new();
		let clock = FixedClock(AtomicI64::new(NOW));
		let logger = JsonEventLogger::new(&recorder, &clock);
		logger.info("runner_started", &[]);
		logger.warn("slow", &[("retryInMs", 500.into())]);
		logger.info(
			"job_claimed",
			&[("runId", "run_1".into()), ("attempt", 2.into())],
		);
		logger.info(
			"Bad",
			&[("token", "rk_secret".into()), ("at", "forged".into())],
		);
		assert_eq!(
			recorder.lines(),
			[
				"{\"at\":\"2026-10-12T00:00:00.000Z\",\"level\":\"info\",\"event\":\"runner_started\"}\n",
				"{\"at\":\"2026-10-12T00:00:00.000Z\",\"level\":\"warn\",\"event\":\"slow\",\"retryInMs\":500}\n",
				"{\"at\":\"2026-10-12T00:00:00.000Z\",\"level\":\"info\",\"event\":\"job_claimed\",\"runId\":\"run_1\",\"attempt\":2}\n",
				"{\"at\":\"2026-10-12T00:00:00.000Z\",\"level\":\"info\",\"event\":\"invalid_log_event\",\"rejected\":\"string\",\"redacted_fields\":1}\n",
			]
		);
	}

	#[test]
	fn counts_failures_and_throttles_the_fallback() {
		let fallback = RecordingLogger::new();
		let clock = FixedClock(AtomicI64::new(NOW));
		let logger = JsonEventLogger::with_fallback(FailingSink, &clock, &fallback);
		logger.info("job_claimed", &[]);
		logger.info("job_claimed", &[]);
		assert_eq!(logger.log_failures(), 2);
		assert_eq!(
			fallback.lines(),
			[
				"{\"at\":\"2026-10-12T00:00:00.000Z\",\"level\":\"error\",\"event\":\"log_write_failed\"}\n"
			]
		);
		clock.0.fetch_add(61_000, Ordering::Relaxed);
		logger.error("job_crashed", &[]);
		assert_eq!(logger.log_failures(), 3);
		assert_eq!(fallback.lines().len(), 2);
		assert_eq!(silent_event_logger().log_failures(), 0);
	}
}
