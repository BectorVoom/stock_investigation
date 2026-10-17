//! The JSON line: `JSON.stringify({at, level, event, ...fields}) + "\n"`.

use std::borrow::Cow;

use research_js::{json_text, number};

/// A log level as the line spells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Level {
	/// `debug` (the runner does not use it).
	Debug,
	/// `info`.
	Info,
	/// `warn`.
	Warn,
	/// `error`.
	Error,
}

impl Level {
	/// The `level` value.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Debug => "debug",
			Self::Info => "info",
			Self::Warn => "warn",
			Self::Error => "error",
		}
	}
}

/// A field value: the TypeScript `string | number | boolean | null`.
/// Identifiers, codes and counts only — never tokens, prompts or retrieved
/// content (SEC-010).
#[derive(Clone, Debug, PartialEq)]
pub enum LogValue<'a> {
	/// A string (dropped when longer than 200 UTF-16 units or multi-line).
	Str(Cow<'a, str>),
	/// A count or other integer, printed as JavaScript prints that number.
	Int(i64),
	/// Any other number (`NaN` and the infinities print `null`, as
	/// `JSON.stringify` writes them).
	Num(f64),
	/// A boolean.
	Bool(bool),
	/// `null`.
	Null,
}

impl<'a> From<&'a str> for LogValue<'a> {
	fn from(value: &'a str) -> Self {
		Self::Str(Cow::Borrowed(value))
	}
}

impl From<String> for LogValue<'_> {
	fn from(value: String) -> Self {
		Self::Str(Cow::Owned(value))
	}
}

impl From<i64> for LogValue<'_> {
	fn from(value: i64) -> Self {
		Self::Int(value)
	}
}

impl From<f64> for LogValue<'_> {
	fn from(value: f64) -> Self {
		Self::Num(value)
	}
}

impl From<bool> for LogValue<'_> {
	fn from(value: bool) -> Self {
		Self::Bool(value)
	}
}

impl<'a, T: Into<LogValue<'a>>> From<Option<T>> for LogValue<'a> {
	fn from(value: Option<T>) -> Self {
		value.map_or(Self::Null, Into::into)
	}
}

/// Largest integer every double represents exactly.
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

fn push_value(out: &mut String, value: &LogValue<'_>) {
	match value {
		LogValue::Str(text) => json_text::push_quoted(out, text),
		LogValue::Int(integer) if integer.unsigned_abs() <= MAX_SAFE_INTEGER.unsigned_abs() => {
			out.push_str(&number::integer_to_js_string(*integer));
		}
		// A JavaScript number cannot hold a larger integer exactly; print
		// the double it would be.
		#[allow(clippy::cast_precision_loss)]
		LogValue::Int(integer) => out.push_str(&json_text::number(*integer as f64)),
		LogValue::Num(value) => out.push_str(&json_text::number(*value)),
		LogValue::Bool(true) => out.push_str("true"),
		LogValue::Bool(false) => out.push_str("false"),
		LogValue::Null => out.push_str("null"),
	}
}

/// A canonical array index (`"0"`, `"42"`, below 2³² − 1): JavaScript
/// objects enumerate such keys first, in ascending numeric order.
fn array_index(key: &str) -> Option<u32> {
	let bytes = key.as_bytes();
	if bytes.is_empty() || bytes.len() > 10 || (bytes.len() > 1 && bytes.first() == Some(&b'0')) {
		return None;
	}
	if !bytes.iter().all(u8::is_ascii_digit) {
		return None;
	}
	key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// `JSON.stringify({at, level, event, ...fields}) + "\n"`, where `fields`
/// went through the content rule.
#[must_use]
pub fn format_log_line(
	at: &str,
	level: Level,
	event: &str,
	fields: &[(&str, LogValue<'_>)],
) -> String {
	let mut entries: Vec<(&str, LogValue<'_>)> = Vec::with_capacity(fields.len() + 3);
	entries.push(("at", LogValue::Str(Cow::Borrowed(at))));
	entries.push(("level", LogValue::Str(Cow::Borrowed(level.as_str()))));
	entries.push(("event", LogValue::Str(Cow::Borrowed(event))));
	for (key, value) in fields {
		match entries.iter_mut().find(|(existing, _)| existing == key) {
			Some(slot) => slot.1 = value.clone(),
			None => entries.push((key, value.clone())),
		}
	}
	// JavaScript object key order: array indices first, ascending, then the
	// rest in insertion order (a stable sort keeps that order).
	entries.sort_by_key(|(key, _)| array_index(key).map_or((1, 0), |index| (0, index)));
	let mut line = String::with_capacity(64 + 32 * entries.len());
	line.push('{');
	for (position, (key, value)) in entries.iter().enumerate() {
		if position > 0 {
			line.push(',');
		}
		json_text::push_quoted(&mut line, key);
		line.push(':');
		push_value(&mut line, value);
	}
	line.push_str("}\n");
	line
}
