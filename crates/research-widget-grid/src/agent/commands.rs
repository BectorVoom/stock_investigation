//! Port of `agent/commands.ts`: the versioned command schema (a zod
//! discriminated union on `kind` of strict objects) and `parseWidgetCommand`.
//!
//! The failure message quotes zod's first issue, and that text reaches the
//! notebook assistant's repair prompt, so each check below reports what zod
//! 4 reports, in zod's order: the fields in schema-shape order, then unknown
//! keys, then the union-level `update` rule. String bounds count code
//! points: that is how zod 4.6 measures them (an emoji is one character). Checked against messages
//! exported from the real schema (`vectors/widget-grid/commands.json`).

use research_js::json::{Object, Value};
use research_js::whitespace;

use super::types::{WidgetAgentFailure, WidgetAgentFailureCode, WidgetCommand};
use crate::core::layout::MoveDirection;
use crate::core::types::WidgetSize;

const MAX_JSON_DEPTH: usize = 12;
const MAX_JSON_NODES: usize = 20_000;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `isJsonObject`: a plain JSON object of bounded depth (≤ 12) and size
/// (≤ 20 000 nodes) whose numbers are all finite. Iterative, so hostile
/// nesting cannot overflow the stack.
#[must_use]
pub fn is_json_object(value: &Value) -> bool {
	if !matches!(value, Value::Object(_)) {
		return false;
	}
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

/// One zod issue: the path (a field name, or none) and zod's message.
struct Issue {
	field: Option<&'static str>,
	message: String,
}

/// zod's name for what it received, as its messages print it.
fn received(value: Option<&Value>) -> &'static str {
	match value {
		None => "undefined",
		Some(Value::Null) => "null",
		Some(Value::Bool(_)) => "boolean",
		Some(Value::Number(number)) if number.is_nan() => "NaN",
		Some(Value::Number(number)) if number.is_infinite() && *number > 0.0 => "Infinity",
		Some(Value::Number(number)) if number.is_infinite() => "-Infinity",
		Some(Value::Number(_)) => "number",
		Some(Value::String(_)) => "string",
		Some(Value::Array(_)) => "array",
		Some(Value::Object(_)) => "object",
	}
}

fn expected(field: &'static str, kind: &str, value: Option<&Value>) -> Issue {
	Issue {
		field: Some(field),
		message: format!(
			"Invalid input: expected {kind}, received {}",
			received(value)
		),
	}
}

/// `z.string().min(min).max(max)`, optionally after `.trim()`; the parsed
/// (trimmed) string.
fn string_field(
	object: &Object,
	field: &'static str,
	trim: bool,
	(min, max): (usize, usize),
	issues: &mut Vec<Issue>,
) -> Option<String> {
	let value = object.get(field);
	let Some(Value::String(text)) = value else {
		issues.push(expected(field, "string", value));
		return None;
	};
	let text = if trim {
		whitespace::trim(text)
	} else {
		text.as_str()
	};
	// zod 4.6 measures strings in code points (`util.codePointLength`), not
	// in UTF-16 units like JavaScript's `.length`.
	let length = text.chars().count();
	if length < min {
		issues.push(Issue {
			field: Some(field),
			message: format!("Too small: expected string to have >={min} characters"),
		});
		return None;
	}
	if length > max {
		issues.push(Issue {
			field: Some(field),
			message: format!("Too big: expected string to have <={max} characters"),
		});
		return None;
	}
	Some(text.to_owned())
}

/// `z.number().int().min(0).max(1000)`; the first failing check.
fn index_field(object: &Object, field: &'static str, issues: &mut Vec<Issue>) -> Option<usize> {
	let value = object.get(field);
	let number = match value {
		Some(Value::Number(number)) if number.is_finite() => *number,
		_ => {
			issues.push(expected(field, "number", value));
			return None;
		}
	};
	let message = if number.trunc() != number {
		"Invalid input: expected int, received number".to_owned()
	} else if number > MAX_SAFE_INTEGER {
		"Too big: expected int to be <=9007199254740991".to_owned()
	} else if number < -MAX_SAFE_INTEGER {
		"Too small: expected int to be >=-9007199254740991".to_owned()
	} else if number < 0.0 {
		"Too small: expected number to be >=0".to_owned()
	} else if number > 1000.0 {
		"Too big: expected number to be <=1000".to_owned()
	} else {
		// An integer in 0..=1000 (possibly -0): exact in every integer type.
		return format!("{number:.0}").trim_start_matches('-').parse().ok();
	};
	issues.push(Issue {
		field: Some(field),
		message,
	});
	None
}

fn size_field(object: &Object, field: &'static str, issues: &mut Vec<Issue>) -> Option<WidgetSize> {
	let size = object
		.get(field)
		.and_then(Value::as_str)
		.and_then(WidgetSize::parse);
	if size.is_none() {
		issues.push(Issue {
			field: Some(field),
			message: "Invalid option: expected one of \"small\"|\"medium\"|\"large\"".to_owned(),
		});
	}
	size
}

fn direction_field(object: &Object, issues: &mut Vec<Issue>) -> Option<MoveDirection> {
	let direction = match object.get("direction").and_then(Value::as_str) {
		Some("earlier") => Some(MoveDirection::Earlier),
		Some("later") => Some(MoveDirection::Later),
		_ => None,
	};
	if direction.is_none() {
		issues.push(Issue {
			field: Some("direction"),
			message: "Invalid option: expected one of \"earlier\"|\"later\"".to_owned(),
		});
	}
	direction
}

fn config_field(object: &Object, issues: &mut Vec<Issue>) -> Option<Object> {
	let value = object.get("config")?;
	match value {
		Value::Object(config) if is_json_object(value) => Some(config.clone()),
		_ => {
			issues.push(Issue {
				field: Some("config"),
				message: "must be a JSON object".to_owned(),
			});
			None
		}
	}
}

/// An optional field: absent means `None` without an issue.
fn optional<T>(
	object: &Object,
	field: &'static str,
	issues: &mut Vec<Issue>,
	parse: impl FnOnce(&Object, &mut Vec<Issue>) -> Option<T>,
) -> Option<T> {
	if object.contains_key(field) {
		parse(object, issues)
	} else {
		None
	}
}

const KINDS: [&str; 7] = [
	"add",
	"remove",
	"move",
	"reorder",
	"resize",
	"update",
	"duplicate",
];

fn shape_of(kind: &str) -> &'static [&'static str] {
	match kind {
		"add" => &["kind", "type", "title", "size", "config", "toIndex"],
		"remove" => &["kind", "widgetId"],
		"move" => &["kind", "widgetId", "direction"],
		"reorder" => &["kind", "widgetId", "toIndex"],
		"resize" => &["kind", "widgetId", "size"],
		"update" => &["kind", "widgetId", "title", "config"],
		_ => &["kind", "widgetId", "title", "toIndex"],
	}
}

fn widget_id(object: &Object, issues: &mut Vec<Issue>) -> Option<String> {
	string_field(object, "widgetId", false, (1, 120), issues)
}

fn title(object: &Object, issues: &mut Vec<Issue>) -> Option<String> {
	string_field(object, "title", true, (1, 200), issues)
}

/// Parses one strict member; `None` when an issue was recorded.
fn parse_member(kind: &str, object: &Object, issues: &mut Vec<Issue>) -> Option<WidgetCommand> {
	let command = match kind {
		"add" => {
			let widget_type = string_field(object, "type", false, (1, 80), issues);
			let title = title(object, issues);
			let size = optional(object, "size", issues, |object, issues| {
				size_field(object, "size", issues)
			});
			let config = optional(object, "config", issues, config_field);
			let to_index = optional(object, "toIndex", issues, |object, issues| {
				index_field(object, "toIndex", issues)
			});
			WidgetCommand::Add {
				widget_type: widget_type?,
				title: title?,
				size,
				config,
				to_index,
			}
		}
		"remove" => WidgetCommand::Remove {
			widget_id: widget_id(object, issues)?,
		},
		"move" => {
			let widget_id = widget_id(object, issues);
			let direction = direction_field(object, issues);
			WidgetCommand::Move {
				widget_id: widget_id?,
				direction: direction?,
			}
		}
		"reorder" => {
			let widget_id = widget_id(object, issues);
			let to_index = index_field(object, "toIndex", issues);
			WidgetCommand::Reorder {
				widget_id: widget_id?,
				to_index: to_index?,
			}
		}
		"resize" => {
			let widget_id = widget_id(object, issues);
			let size = size_field(object, "size", issues);
			WidgetCommand::Resize {
				widget_id: widget_id?,
				size: size?,
			}
		}
		"update" => {
			let widget_id = widget_id(object, issues);
			let title = optional(object, "title", issues, title);
			let config = optional(object, "config", issues, config_field);
			WidgetCommand::Update {
				widget_id: widget_id?,
				title,
				config,
			}
		}
		_ => {
			let widget_id = widget_id(object, issues);
			let title = optional(object, "title", issues, title);
			let to_index = optional(object, "toIndex", issues, |object, issues| {
				index_field(object, "toIndex", issues)
			});
			WidgetCommand::Duplicate {
				widget_id: widget_id?,
				title,
				to_index,
			}
		}
	};
	// An optional field that failed leaves `None` behind: the issue decides.
	issues.is_empty().then_some(command)
}

fn invalid(message: String) -> WidgetAgentFailure {
	WidgetAgentFailure::new(WidgetAgentFailureCode::InvalidCommand, message)
}

/// `parseWidgetCommand`: parses untrusted input into a command. On failure
/// returns `INVALID_COMMAND` with a message naming the offending field (from
/// zod's first issue path, or the unknown keys, or the discriminator).
///
/// # Errors
///
/// [`WidgetAgentFailure`] with code `INVALID_COMMAND`.
pub fn parse_widget_command(input: &Value) -> Result<WidgetCommand, WidgetAgentFailure> {
	let Value::Object(object) = input else {
		return Err(invalid(format!(
			"invalid command: \"command\" Invalid input: expected object, received {}",
			received(Some(input))
		)));
	};
	let Some(kind) = object
		.get("kind")
		.and_then(Value::as_str)
		.filter(|kind| KINDS.contains(kind))
	else {
		return Err(invalid(
			"invalid command: \"kind\" Invalid discriminator value. Expected 'add' | 'remove' | 'move' | 'reorder' | 'resize' | 'update' | 'duplicate'"
				.to_owned(),
		));
	};
	let mut issues = Vec::new();
	let command = parse_member(kind, object, &mut issues);
	if let Some(issue) = issues.first() {
		let field = issue.field.unwrap_or("command");
		return Err(invalid(format!(
			"invalid command: \"{field}\" {}",
			issue.message
		)));
	}
	let shape = shape_of(kind);
	let unknown: Vec<String> = object
		.keys()
		.filter(|key| !shape.contains(key))
		.map(|key| format!("\"{key}\""))
		.collect();
	if !unknown.is_empty() {
		return Err(invalid(format!(
			"invalid command: unknown field {}.",
			unknown.join(", ")
		)));
	}
	match command {
		Some(WidgetCommand::Update {
			title: None,
			config: None,
			..
		}) => Err(invalid(
			"invalid command: \"command\" at least one of \"title\" or \"config\" is required"
				.to_owned(),
		)),
		Some(command) => Ok(command),
		None => Err(invalid(
			"invalid command: the command is not an object.".to_owned(),
		)),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parse(text: &str) -> Result<WidgetCommand, String> {
		parse_widget_command(&research_js::json::parse(text).unwrap())
			.map_err(|failure| failure.message)
	}

	#[test]
	fn parses_and_reports_like_zod() {
		assert_eq!(
			parse(r#"{"kind":"add","type":"note","title":"  Hello  "}"#),
			Ok(WidgetCommand::Add {
				widget_type: "note".to_owned(),
				title: "Hello".to_owned(),
				size: None,
				config: None,
				to_index: None
			})
		);
		assert_eq!(
			parse(r#"{"kind":"remove","widgetId":"w","d":1,"a":2}"#),
			Err("invalid command: unknown field \"d\", \"a\".".to_owned())
		);
		assert_eq!(
			parse(r#"{"kind":"update","widgetId":"w"}"#),
			Err(
				"invalid command: \"command\" at least one of \"title\" or \"config\" is required"
					.to_owned()
			)
		);
		assert_eq!(
			parse(r#"{"kind":"add","type":"t","title":"x","toIndex":1e400}"#),
			Err(
				"invalid command: \"toIndex\" Invalid input: expected number, received Infinity"
					.to_owned()
			)
		);
		assert_eq!(
			parse("[]"),
			Err(
				"invalid command: \"command\" Invalid input: expected object, received array"
					.to_owned()
			)
		);
	}

	#[test]
	fn bounds_json_objects() {
		let deep = format!("{}1{}", "{\"a\":".repeat(13), "}".repeat(13));
		assert!(!is_json_object(&research_js::json::parse(&deep).unwrap()));
		let ok = format!("{}1{}", "{\"a\":".repeat(12), "}".repeat(12));
		assert!(is_json_object(&research_js::json::parse(&ok).unwrap()));
		assert!(!is_json_object(&research_js::json::parse("[1]").unwrap()));
	}
}
