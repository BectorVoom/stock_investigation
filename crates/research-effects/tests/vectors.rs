//! Replays `vectors/logging/lines.json`: the exact lines the TypeScript
//! `createEventLogger` wrote (`node scripts/vectors/index.ts logging`).
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use research_effects::{EventLogger, JsonEventLogger, LogClock, LogValue, RecordingLogger};
use serde_json::Value;

struct FixedClock;

impl LogClock for FixedClock {
	fn now_ms(&self) -> i64 {
		1_791_763_200_000 // 2026-10-12T00:00:00.000Z
	}
}

fn value(wire: &Value) -> LogValue<'static> {
	if let Some(text) = wire.get("s") {
		LogValue::Str(text.as_str().unwrap().to_owned().into())
	} else if let Some(bits) = wire.get("n") {
		LogValue::Num(f64::from_bits(
			u64::from_str_radix(bits.as_str().unwrap(), 16).unwrap(),
		))
	} else if let Some(integer) = wire.get("i") {
		LogValue::Int(integer.as_i64().unwrap())
	} else if let Some(boolean) = wire.get("b") {
		LogValue::Bool(boolean.as_bool().unwrap())
	} else {
		LogValue::Null
	}
}

#[test]
fn lines_match_the_typescript_logger() {
	let path = format!(
		"{}/../../vectors/logging/lines.json",
		env!("CARGO_MANIFEST_DIR")
	);
	let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
	assert!(cases.len() > 1000);
	for case in &cases {
		let recorder = RecordingLogger::new();
		let logger = JsonEventLogger::new(&recorder, FixedClock);
		let owned: Vec<(String, LogValue<'static>)> = case["fields"]
			.as_array()
			.unwrap()
			.iter()
			.map(|pair| (pair[0].as_str().unwrap().to_owned(), value(&pair[1])))
			.collect();
		let fields: Vec<(&str, LogValue<'_>)> = owned
			.iter()
			.map(|(key, value)| (key.as_str(), value.clone()))
			.collect();
		let event = case["event"].as_str().unwrap();
		match case["level"].as_str().unwrap() {
			"info" => logger.info(event, &fields),
			"warn" => logger.warn(event, &fields),
			_ => logger.error(event, &fields),
		}
		assert_eq!(recorder.lines(), [case["line"].as_str().unwrap()], "{case}");
	}
}
