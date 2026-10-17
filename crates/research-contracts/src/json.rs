//! Bounded JSON (`jsonValueSchema`, `jsonObjectSchema`) and JavaScript-exact
//! JSON output for contract values.
//!
//! Free-form JSON (UI props, notebook commands, tool arguments) stays a
//! [`research_js::json::Value`] after the bounded-JSON check, the Rust
//! counterpart of the TypeScript "no `any`" rule. [`to_js_json`] writes any
//! contract value as `JSON.stringify` would write zod's parsed value: field
//! (shape) order, JavaScript number formatting, JavaScript escaping.

use research_js::json::{Object, Value};
use research_js::number::to_js_string;
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};

use crate::zod::{Cx, Flow, IssueCode};

/// `MAX_JSON_DEPTH`.
pub const MAX_JSON_DEPTH: usize = 12;
/// `MAX_JSON_NODES`.
pub const MAX_JSON_NODES: usize = 20_000;

/// `isBoundedJson`: depth ≤ 12 (the root is depth 0), at most 20 000 nodes,
/// finite numbers. Iterative, like the TypeScript, so a deeply nested value
/// is rejected instead of overflowing the stack.
#[must_use]
pub fn is_bounded_json(value: &Value) -> bool {
	let mut pending: Vec<(&Value, usize)> = vec![(value, 0)];
	let mut nodes = 0usize;
	while let Some((current, depth)) = pending.pop() {
		nodes += 1;
		if nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH {
			return false;
		}
		match current {
			Value::Number(number) if !number.is_finite() => return false,
			Value::Array(items) => pending.extend(items.iter().map(|item| (item, depth + 1))),
			Value::Object(object) => pending.extend(object.values().map(|item| (item, depth + 1))),
			_ => {}
		}
	}
	true
}

/// A bounded JSON value (`jsonValueSchema`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct JsonValue(pub Value);

/// A bounded plain JSON object (`jsonObjectSchema`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct JsonObject(pub Object);

const JSON_VALUE_MESSAGE: &str =
	"must be JSON no deeper than 12 levels and no larger than 20000 values";
const JSON_OBJECT_MESSAGE: &str = "must be a bounded JSON object";

impl JsonValue {
	/// `jsonValueSchema` (a `z.custom` check: its issue continues).
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		match input {
			Some(value) if is_bounded_json(value) => Some(Self(value.clone())),
			_ => {
				cx.push(
					IssueCode::Custom,
					JSON_VALUE_MESSAGE.to_owned(),
					Flow::Continue,
				);
				None
			}
		}
	}
}

impl JsonObject {
	/// `jsonObjectSchema` (a `z.custom` check: its issue continues).
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		match input {
			Some(value @ Value::Object(object)) if is_bounded_json(value) => {
				Some(Self(object.clone()))
			}
			_ => {
				cx.push(
					IssueCode::Custom,
					JSON_OBJECT_MESSAGE.to_owned(),
					Flow::Continue,
				);
				None
			}
		}
	}
}

/// Serialises a JSON value (recursion is bounded: values reaching here
/// passed the depth check or were built by the runner).
struct ValueRef<'a>(&'a Value);

impl Serialize for ValueRef<'_> {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		match self.0 {
			Value::Null => serializer.serialize_unit(),
			Value::Bool(flag) => serializer.serialize_bool(*flag),
			Value::Number(number) => serializer.serialize_f64(*number),
			Value::String(text) => serializer.serialize_str(text),
			Value::Array(items) => {
				let mut seq = serializer.serialize_seq(Some(items.len()))?;
				for item in items {
					seq.serialize_element(&ValueRef(item))?;
				}
				seq.end()
			}
			Value::Object(object) => ObjectRef(object).serialize(serializer),
		}
	}
}

struct ObjectRef<'a>(&'a Object);

impl Serialize for ObjectRef<'_> {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		let mut map = serializer.serialize_map(Some(self.0.len()))?;
		for (key, value) in self.0.iter() {
			map.serialize_entry(key, &ValueRef(value))?;
		}
		map.end()
	}
}

impl Serialize for JsonValue {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		ValueRef(&self.0).serialize(serializer)
	}
}

impl Serialize for JsonObject {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		ObjectRef(&self.0).serialize(serializer)
	}
}

/// A `z.record(string, T)` value: entries in JavaScript property order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Record<T>(pub Vec<(String, T)>);

impl<T: Serialize> Serialize for Record<T> {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		// A JavaScript object enumerates array-index keys first; keep that
		// order for a record built in Rust too.
		let mut order: Vec<&(String, T)> = self.0.iter().collect();
		order.sort_by_key(|(key, _)| {
			research_js::json::array_index(key).map_or(u64::MAX, u64::from)
		});
		let mut map = serializer.serialize_map(Some(order.len()))?;
		for (key, value) in order {
			map.serialize_entry(key, value)?;
		}
		map.end()
	}
}

/// Writes numbers as JavaScript does (`1e+21`, `5`, `-0` as `0`).
struct JsFormatter;

impl serde_json::ser::Formatter for JsFormatter {
	fn write_f64<W: ?Sized + std::io::Write>(
		&mut self,
		writer: &mut W,
		value: f64,
	) -> std::io::Result<()> {
		writer.write_all(research_js::json_text::number(value).as_bytes())
	}

	fn write_f32<W: ?Sized + std::io::Write>(
		&mut self,
		writer: &mut W,
		value: f32,
	) -> std::io::Result<()> {
		writer.write_all(to_js_string(f64::from(value)).as_bytes())
	}
}

/// `JSON.stringify` of a contract value as zod would have parsed it.
///
/// # Errors
/// Only when a `Serialize` implementation fails (never for contract types).
pub fn to_js_json<T: Serialize + ?Sized>(value: &T) -> Result<String, serde_json::Error> {
	let mut out = Vec::new();
	let mut serializer = serde_json::Serializer::with_formatter(&mut out, JsFormatter);
	value.serialize(&mut serializer)?;
	// serde_json writes valid UTF-8; the lossy path is never taken.
	Ok(String::from_utf8(out).unwrap_or_default())
}

/// The JavaScript JSON value of a contract value (for prompts that embed
/// parsed contract data, and for tests).
///
/// # Errors
/// Only when a `Serialize` implementation fails.
pub fn to_js_value<T: Serialize + ?Sized>(value: &T) -> Result<Value, serde_json::Error> {
	let text = to_js_json(value)?;
	research_js::json::parse(&text).map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bounds_depth_and_size() {
		let deep = research_js::json::parse(&format!("{}1{}", "[".repeat(12), "]".repeat(12)))
			.unwrap_or_default();
		assert!(is_bounded_json(&deep));
		let deeper = research_js::json::parse(&format!("{}1{}", "[".repeat(13), "]".repeat(13)))
			.unwrap_or_default();
		assert!(!is_bounded_json(&deeper));
		assert!(!is_bounded_json(&Value::Number(f64::INFINITY)));
	}

	#[test]
	fn writes_numbers_like_javascript() {
		let text = to_js_json(&(1e21_f64, 5.0_f64, -0.0_f64, 0.1_f64, "é\u{2028}\u{1F}"))
			.unwrap_or_default();
		assert_eq!(text, "[1e+21,5,0,0.1,\"é\u{2028}\\u001f\"]");
	}
}
