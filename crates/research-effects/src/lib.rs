//! The runner's event logger: the same JSON lines as
//! `packages/effects/src/logging.ts` (ADR-0030; rr-spec-shell-wire §7).
//!
//! One line per call, `{"at":…,"level":…,"event":…,…fields}` + `"\n"`,
//! byte for byte what the TypeScript `createEventLogger` writes: the same
//! content rule (SEC-010: sensitive field names and long or multi-line
//! strings are dropped and counted in `redacted_fields`), the same key order
//! (JavaScript object order: array-index keys first, ascending, then
//! insertion order), JavaScript number formatting, and the same writer
//! isolation (a failing sink is counted, reported by at most one
//! `log_write_failed` line a minute, and never reaches the caller).
//!
//! Effect itself is not ported: the runner only uses the facade.

mod iso;
mod line;
mod logger;
mod sanitize;

pub use line::{Level, LogValue, format_log_line};
pub use logger::{
	EventLogger, JsonEventLogger, LineSink, LogClock, RecordingLogger, SilentEventLogger,
	StderrSink, SystemClock, silent_event_logger,
};
pub use sanitize::{
	INVALID_LOG_EVENT, MAX_LOG_FIELD_CHARS, SanitizedLogCall, is_log_event_name,
	is_sensitive_field_name, sanitize_log_call,
};
