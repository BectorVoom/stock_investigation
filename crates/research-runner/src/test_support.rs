//! Helpers shared by the unit tests of this crate.

use std::sync::Arc;

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
	#[allow(dead_code)]
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
