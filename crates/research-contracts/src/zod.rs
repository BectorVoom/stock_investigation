//! A zod-equivalent decoder over JavaScript JSON values (zod 4.6.5).
//!
//! The runner's behaviour depends on more than zod's accept/reject verdict:
//! the parsed value is used (trimmed strings, defaults, schema key order),
//! and issue paths and messages reach repair prompts (`rr-spec-pipeline.md`
//! §4.7). So decoding mirrors zod's algorithm rather than a serde shape:
//!
//! - an object's keys are checked in shape order, then unknown keys of a
//!   strict object are reported once (`unrecognized_keys`);
//! - checks run in declaration order after the type check; a check is
//!   skipped once an issue that "aborts" was raised — every issue except
//!   failed checks, refinements and unknown keys, which zod marks
//!   `continue: true`; length checks (`.min`/`.max`) skip only after an
//!   explicit abort (`.int()` on a fraction), so they also run on a value of
//!   the wrong type that has a length (zod's `when` rule);
//! - **string lengths count Unicode code points**, not UTF-16 units: zod
//!   4.6.5 measures `.min`/`.max` on strings with `codePointLength`
//!   (`"😀😀"` passes `.max(2)`; verified against Node);
//! - unions return the first option without issues, else the only option
//!   that did not abort, else one `invalid_union` issue;
//! - messages are zod's English locale (`zod/v4/locales/en.js`).
//!
//! A decoder is `fn(&mut Cx, Option<&Value>) -> Option<T>`: `None` input is
//! `undefined` (an absent key), `None` output means the value could not be
//! built (its issues are in the context).

use std::borrow::Cow;
use std::fmt;

use research_js::json::{Object, Value};
use research_js::number::to_js_string;
use research_js::whitespace;

/// One step of an issue path: an object key or an array index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathSegment {
	/// An object key.
	Key(String),
	/// An array (or tuple) index.
	Index(usize),
}

impl fmt::Display for PathSegment {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Key(key) => formatter.write_str(key),
			Self::Index(index) => write!(formatter, "{index}"),
		}
	}
}

/// zod's issue codes (the subset these schemas can raise).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IssueCode {
	/// `invalid_type`.
	InvalidType,
	/// `invalid_value` (enum or literal).
	InvalidValue,
	/// `too_big`.
	TooBig,
	/// `too_small`.
	TooSmall,
	/// `invalid_format` (regex, ISO date or datetime).
	InvalidFormat,
	/// `unrecognized_keys` (strict objects).
	UnrecognizedKeys,
	/// `invalid_key` (records).
	InvalidKey,
	/// `invalid_union`.
	InvalidUnion,
	/// `custom` (refinements and custom schemas).
	Custom,
}

impl IssueCode {
	/// The code as zod spells it.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::InvalidType => "invalid_type",
			Self::InvalidValue => "invalid_value",
			Self::TooBig => "too_big",
			Self::TooSmall => "too_small",
			Self::InvalidFormat => "invalid_format",
			Self::UnrecognizedKeys => "unrecognized_keys",
			Self::InvalidKey => "invalid_key",
			Self::InvalidUnion => "invalid_union",
			Self::Custom => "custom",
		}
	}
}

/// How an issue affects later checks (zod's `continue` flag).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Flow {
	/// `continue: true`: later checks still run.
	Continue,
	/// `continue` absent: later checks are skipped, except length checks.
	Implicit,
	/// `continue: false`: every later check is skipped.
	Explicit,
}

/// One validation issue, as zod reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
	/// The issue code.
	pub code: IssueCode,
	/// Where in the input it is.
	pub path: Vec<PathSegment>,
	/// zod's (English) message.
	pub message: String,
	flow: Flow,
}

impl Issue {
	/// The path joined with `separator` (`issue.path.join(".")`).
	#[must_use]
	pub fn path_string(&self, separator: &str) -> String {
		let mut out = String::new();
		for (index, segment) in self.path.iter().enumerate() {
			if index > 0 {
				out.push_str(separator);
			}
			out.push_str(&segment.to_string());
		}
		out
	}
}

impl fmt::Display for Issue {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			formatter,
			"{} at [{}]: {}",
			self.code.as_str(),
			self.path_string("."),
			self.message
		)
	}
}

/// The decoding context: issues raised so far and the current path.
#[derive(Debug, Default)]
pub struct Cx {
	issues: Vec<Issue>,
	path: Vec<PathSegment>,
}

/// A decoder: input value (`None` = absent) to output value.
pub trait Decoder<T>: Fn(&mut Cx, Option<&Value>) -> Option<T> {}
impl<T, F: Fn(&mut Cx, Option<&Value>) -> Option<T>> Decoder<T> for F {}

impl Cx {
	/// A fresh context at the root.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// The issues raised so far, in zod's order.
	#[must_use]
	pub fn issues(&self) -> &[Issue] {
		&self.issues
	}

	/// The issues raised so far.
	#[must_use]
	pub fn into_issues(self) -> Vec<Issue> {
		self.issues
	}

	pub(crate) fn push(&mut self, code: IssueCode, message: String, flow: Flow) {
		self.issues.push(Issue {
			code,
			path: self.path.clone(),
			message,
			flow,
		});
	}

	pub(crate) fn push_at_key(&mut self, key: &str, code: IssueCode, message: String, flow: Flow) {
		let mut path = self.path.clone();
		path.push(PathSegment::Key(key.to_owned()));
		self.issues.push(Issue {
			code,
			path,
			message,
			flow,
		});
	}

	pub(crate) fn mark(&self) -> usize {
		self.issues.len()
	}

	/// Whether an issue raised since `mark` stops later checks (`util.aborted`).
	pub(crate) fn aborted_since(&self, mark: usize) -> bool {
		self.issues
			.get(mark..)
			.is_some_and(|issues| issues.iter().any(|issue| issue.flow != Flow::Continue))
	}

	/// Whether an issue raised since `mark` is an explicit abort (`util.explicitlyAborted`).
	pub(crate) fn explicitly_aborted_since(&self, mark: usize) -> bool {
		self.issues
			.get(mark..)
			.is_some_and(|issues| issues.iter().any(|issue| issue.flow == Flow::Explicit))
	}

	pub(crate) fn has_issues_since(&self, mark: usize) -> bool {
		self.issues.len() > mark
	}

	pub(crate) fn take_since(&mut self, mark: usize) -> Vec<Issue> {
		if mark >= self.issues.len() {
			return Vec::new();
		}
		self.issues.split_off(mark)
	}

	pub(crate) fn restore(&mut self, issues: Vec<Issue>) {
		self.issues.extend(issues);
	}

	/// Runs `decode` with `key` appended to the path.
	pub(crate) fn at_key<T>(&mut self, key: &str, decode: impl FnOnce(&mut Self) -> T) -> T {
		self.path.push(PathSegment::Key(key.to_owned()));
		let result = decode(self);
		self.path.pop();
		result
	}

	/// Runs `decode` with `index` appended to the path.
	pub(crate) fn at_index<T>(&mut self, index: usize, decode: impl FnOnce(&mut Self) -> T) -> T {
		self.path.push(PathSegment::Index(index));
		let result = decode(self);
		self.path.pop();
		result
	}

	/// Pushes the `invalid_type` issue of a failed type check.
	pub(crate) fn invalid_type(&mut self, expected: &str, input: Option<&Value>) {
		self.push(
			IssueCode::InvalidType,
			format!(
				"Invalid input: expected {expected}, received {}",
				received(input)
			),
			Flow::Implicit,
		);
	}

	/// Pushes a refinement failure (`custom`, continues) at `path_key` under the current path.
	pub(crate) fn refine_failed(&mut self, path_key: Option<&str>, message: &str) {
		match path_key {
			Some(key) => {
				self.push_at_key(key, IssueCode::Custom, message.to_owned(), Flow::Continue)
			}
			None => self.push(IssueCode::Custom, message.to_owned(), Flow::Continue),
		}
	}
}

/// zod's `parsedType` name of a value, as the `invalid_type` message prints it.
fn received(input: Option<&Value>) -> Cow<'static, str> {
	match input {
		None => Cow::Borrowed("undefined"),
		Some(Value::Null) => Cow::Borrowed("null"),
		Some(Value::Bool(_)) => Cow::Borrowed("boolean"),
		Some(Value::Number(number)) if number.is_nan() => Cow::Borrowed("NaN"),
		// `getTypeName` prints a non-finite number itself ("Infinity").
		Some(Value::Number(number)) if number.is_infinite() => Cow::Owned(to_js_string(*number)),
		Some(Value::Number(_)) => Cow::Borrowed("number"),
		Some(Value::String(_)) => Cow::Borrowed("string"),
		Some(Value::Array(_)) => Cow::Borrowed("array"),
		Some(Value::Object(_)) => Cow::Borrowed("object"),
	}
}

/// `util.stringifyPrimitive`: strings quoted, numbers as JavaScript prints them.
fn quoted(value: &str) -> String {
	format!("\"{value}\"")
}

/// The `invalid_value` message of an enum or literal.
fn invalid_value_message(values: &[&str]) -> String {
	if let [only] = values {
		return format!("Invalid input: expected {}", quoted(only));
	}
	let joined: Vec<String> = values.iter().map(|value| quoted(value)).collect();
	format!("Invalid option: expected one of {}", joined.join("|"))
}

/// `too_big` / `too_small` messages (`en.js`).
fn size_message(big: bool, origin: &str, inclusive: bool, limit: f64) -> String {
	let unit = match origin {
		"string" => Some("characters"),
		"array" => Some("items"),
		_ => None,
	};
	let adjective = match (big, inclusive) {
		(true, true) => "<=",
		(true, false) => "<",
		(false, true) => ">=",
		(false, false) => ">",
	};
	let head = if big { "Too big" } else { "Too small" };
	let limit = to_js_string(limit);
	match unit {
		Some(unit) => format!("{head}: expected {origin} to have {adjective}{limit} {unit}"),
		None => format!("{head}: expected {origin} to be {adjective}{limit}"),
	}
}

/* ---------- JavaScript conversions the length checks need ---------- */

/// `Number(text)` (StringToNumber) for the rare `{length: "…"}` input.
fn string_to_number(text: &str) -> f64 {
	let trimmed = whitespace::trim(text);
	if trimmed.is_empty() {
		return 0.0;
	}
	match trimmed {
		"Infinity" | "+Infinity" => return f64::INFINITY,
		"-Infinity" => return f64::NEG_INFINITY,
		_ => {}
	}
	let bytes = trimmed.as_bytes();
	if let [b'0', prefix, digits @ ..] = bytes {
		let radix = match prefix {
			b'x' | b'X' => Some(16),
			b'o' | b'O' => Some(8),
			b'b' | b'B' => Some(2),
			_ => None,
		};
		if let Some(radix) = radix {
			if digits.is_empty() {
				return f64::NAN;
			}
			let mut value = 0.0f64;
			for digit in digits {
				let Some(digit) = char::from(*digit).to_digit(radix) else {
					return f64::NAN;
				};
				value = value * f64::from(radix) + f64::from(digit);
			}
			return value;
		}
	}
	if is_decimal_literal(bytes) {
		trimmed.parse::<f64>().unwrap_or(f64::NAN)
	} else {
		f64::NAN
	}
}

/// ECMA-262 StrDecimalLiteral (without Infinity).
fn is_decimal_literal(bytes: &[u8]) -> bool {
	let mut index = 0;
	if matches!(bytes.first(), Some(b'+' | b'-')) {
		index += 1;
	}
	let integer_start = index;
	while bytes.get(index).is_some_and(u8::is_ascii_digit) {
		index += 1;
	}
	let mut digits = index - integer_start;
	if bytes.get(index) == Some(&b'.') {
		index += 1;
		let fraction_start = index;
		while bytes.get(index).is_some_and(u8::is_ascii_digit) {
			index += 1;
		}
		digits += index - fraction_start;
	}
	if digits == 0 {
		return false;
	}
	if matches!(bytes.get(index), Some(b'e' | b'E')) {
		index += 1;
		if matches!(bytes.get(index), Some(b'+' | b'-')) {
			index += 1;
		}
		let exponent_start = index;
		while bytes.get(index).is_some_and(u8::is_ascii_digit) {
			index += 1;
		}
		if index == exponent_start {
			return false;
		}
	}
	index == bytes.len()
}

/// `Number(value)` for the primitive forms a `length` property can take.
/// Arrays and objects go through `ToPrimitive`; only the forms a JSON value
/// can reach cheaply are followed (`[]` is 0, `[x]` is `Number(x)`, any
/// other object is NaN).
fn to_number(value: &Value) -> f64 {
	match value {
		Value::Null => 0.0,
		Value::Bool(flag) => f64::from(u8::from(*flag)),
		Value::Number(number) => *number,
		Value::String(text) => string_to_number(text),
		Value::Array(items) => match items.as_slice() {
			[] => 0.0,
			[Value::Array(_) | Value::Object(_)] => f64::NAN,
			[Value::Null] => 0.0,
			[Value::String(text)] => string_to_number(text),
			[Value::Number(number)] => *number,
			[Value::Bool(_)] => f64::NAN,
			_ => f64::NAN,
		},
		Value::Object(_) => f64::NAN,
	}
}

/// The length a `.min`/`.max` check measures, and the issue origin: code
/// points for strings, elements for arrays, an own `length` property for
/// anything else that has one (zod's `when: hasLength`).
fn length_of(value: Option<&Value>, current_string: Option<&str>) -> Option<(f64, &'static str)> {
	if let Some(text) = current_string {
		return Some((count_as_f64(text.chars().count()), "string"));
	}
	match value? {
		Value::String(text) => Some((count_as_f64(text.chars().count()), "string")),
		Value::Array(items) => Some((count_as_f64(items.len()), "array")),
		Value::Object(object) => object
			.get("length")
			.map(|length| (to_number(length), "unknown")),
		_ => None,
	}
}

/// A count as a double (every count here is far below 2^53).
#[allow(clippy::cast_precision_loss)]
fn count_as_f64(count: usize) -> f64 {
	count as f64
}

/// Runs one `.min(limit)` / `.max(limit)` length check.
fn length_check(cx: &mut Cx, big: bool, limit: usize, measured: (f64, &'static str)) {
	let (length, origin) = measured;
	let limit = count_as_f64(limit);
	// Written as zod writes them, so NaN (an odd `length`) fails both.
	let passes = if big {
		length <= limit
	} else {
		length >= limit
	};
	if !passes {
		let code = if big {
			IssueCode::TooBig
		} else {
			IssueCode::TooSmall
		};
		cx.push(code, size_message(big, origin, true, limit), Flow::Continue);
	}
}

/* ---------- Strings ---------- */

/// A string pattern with its JavaScript source (`/…/`), matched by hand.
#[derive(Debug)]
pub struct Pattern {
	/// `regex.toString()`, as zod prints it in messages.
	pub source: &'static str,
	/// Whether the whole string matches.
	pub matches: fn(&str) -> bool,
}

/// One check of a string schema, in declaration order.
#[derive(Debug, Clone, Copy)]
pub enum StrCheck {
	/// `.trim()`: JavaScript trim (a transform, never an issue).
	Trim,
	/// `.min(n)` in code points.
	Min(usize),
	/// `.max(n)` in code points.
	Max(usize),
	/// `.regex(pattern, message?)`.
	Regex(&'static Pattern, Option<&'static str>),
	/// `z.iso.date()`.
	IsoDate,
	/// `z.iso.datetime({ offset: true })`.
	IsoDateTime,
	/// `.refine(predicate, { message })` on the string itself.
	Refine(fn(&str) -> bool, &'static str),
}

/// `z.string()` with `checks`.
pub(crate) fn run_string(
	cx: &mut Cx,
	input: Option<&Value>,
	checks: &[StrCheck],
) -> Option<String> {
	let mut value = match input {
		Some(Value::String(text)) => Some(text.clone()),
		_ => {
			cx.invalid_type("string", input);
			None
		}
	};
	// A type failure is an implicit abort: only length checks still run.
	let aborted = value.is_none();
	for check in checks {
		match *check {
			StrCheck::Min(limit) | StrCheck::Max(limit) => {
				if let Some(measured) = length_of(input, value.as_deref()) {
					length_check(cx, matches!(check, StrCheck::Max(_)), limit, measured);
				}
			}
			_ if aborted => {}
			StrCheck::Trim => {
				if let Some(text) = value.as_mut() {
					let trimmed = whitespace::trim(text);
					if trimmed.len() != text.len() {
						*text = trimmed.to_owned();
					}
				}
			}
			StrCheck::Regex(pattern, message) => {
				if let Some(text) = value.as_deref()
					&& !(pattern.matches)(text)
				{
					let message = message.map_or_else(
						|| format!("Invalid string: must match pattern {}", pattern.source),
						str::to_owned,
					);
					cx.push(IssueCode::InvalidFormat, message, Flow::Continue);
				}
			}
			StrCheck::IsoDate => {
				if let Some(text) = value.as_deref()
					&& !crate::patterns::is_iso_date(text)
				{
					cx.push(
						IssueCode::InvalidFormat,
						"Invalid ISO date".to_owned(),
						Flow::Continue,
					);
				}
			}
			StrCheck::IsoDateTime => {
				if let Some(text) = value.as_deref()
					&& !crate::patterns::is_iso_date_time(text)
				{
					cx.push(
						IssueCode::InvalidFormat,
						"Invalid ISO datetime".to_owned(),
						Flow::Continue,
					);
				}
			}
			StrCheck::Refine(predicate, message) => {
				if let Some(text) = value.as_deref()
					&& !predicate(text)
				{
					cx.push(IssueCode::Custom, message.to_owned(), Flow::Continue);
				}
			}
		}
	}
	value
}

/// A `z.string()` decoder with `checks`.
pub(crate) fn string(
	checks: &'static [StrCheck],
) -> impl Fn(&mut Cx, Option<&Value>) -> Option<String> {
	move |cx, input| run_string(cx, input, checks)
}

/* ---------- Numbers ---------- */

/// One check of a number schema, in declaration order.
#[derive(Debug, Clone, Copy)]
pub enum NumCheck {
	/// `.int()`: a safe integer.
	Int,
	/// `.min(n)` / `.nonnegative()` (`>= n`).
	Gte(f64),
	/// `.positive()` (`> n`).
	Gt(f64),
	/// `.max(n)` (`<= n`).
	Lte(f64),
}

/// 2^53 − 1.
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `z.number()` with `checks` (`.finite()` is a no-op in zod 4).
pub(crate) fn run_number(cx: &mut Cx, input: Option<&Value>, checks: &[NumCheck]) -> Option<f64> {
	let Some(Value::Number(value)) =
		input.filter(|value| value.as_f64().is_some_and(f64::is_finite))
	else {
		cx.invalid_type("number", input);
		return None;
	};
	let value = *value;
	let mut aborted = false;
	for check in checks {
		if aborted {
			break;
		}
		match *check {
			NumCheck::Int => {
				if value.fract() != 0.0 {
					cx.push(
						IssueCode::InvalidType,
						"Invalid input: expected int, received number".to_owned(),
						Flow::Explicit,
					);
					aborted = true;
				} else if value.abs() > MAX_SAFE_INTEGER {
					let big = value > 0.0;
					let limit = if big {
						MAX_SAFE_INTEGER
					} else {
						-MAX_SAFE_INTEGER
					};
					let code = if big {
						IssueCode::TooBig
					} else {
						IssueCode::TooSmall
					};
					cx.push(code, size_message(big, "int", true, limit), Flow::Continue);
				}
			}
			NumCheck::Gte(limit) if value < limit => {
				cx.push(
					IssueCode::TooSmall,
					size_message(false, "number", true, limit),
					Flow::Continue,
				);
			}
			NumCheck::Gt(limit) if value <= limit => {
				cx.push(
					IssueCode::TooSmall,
					size_message(false, "number", false, limit),
					Flow::Continue,
				);
			}
			NumCheck::Lte(limit) if value > limit => {
				cx.push(
					IssueCode::TooBig,
					size_message(true, "number", true, limit),
					Flow::Continue,
				);
			}
			_ => {}
		}
	}
	Some(value)
}

/// A `z.number()` decoder with `checks`, as a double.
pub(crate) fn number(
	checks: &'static [NumCheck],
) -> impl Fn(&mut Cx, Option<&Value>) -> Option<f64> {
	move |cx, input| run_number(cx, input, checks)
}

/// A double that passed `.int()` (or failed only its range) as `u64`,
/// clamped into `0..=2^53` so a value is always produced when zod would
/// keep going.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub(crate) fn clamp_u64(value: f64) -> u64 {
	// In range and integral by construction: the cast is exact.
	value.clamp(0.0, MAX_SAFE_INTEGER + 1.0).trunc() as u64
}

/// An integer decoder (`z.number().int()` plus `checks`) producing `u64`.
pub(crate) fn uint(checks: &'static [NumCheck]) -> impl Fn(&mut Cx, Option<&Value>) -> Option<u64> {
	move |cx, input| run_number(cx, input, checks).map(clamp_u64)
}

/// `z.union([z.literal(a), z.literal(b), …])` of numbers.
pub(crate) fn number_literals(
	values: &'static [f64],
) -> impl Fn(&mut Cx, Option<&Value>) -> Option<f64> {
	move |cx, input| {
		let found = input
			.and_then(Value::as_f64)
			.filter(|number| values.contains(number));
		if found.is_none() {
			// Every literal option fails without `continue`.
			cx.push(
				IssueCode::InvalidUnion,
				"Invalid input".to_owned(),
				Flow::Implicit,
			);
		}
		found
	}
}

/* ---------- Other primitives ---------- */

/// `z.boolean()`.
pub(crate) fn boolean(cx: &mut Cx, input: Option<&Value>) -> Option<bool> {
	match input {
		Some(Value::Bool(flag)) => Some(*flag),
		_ => {
			cx.invalid_type("boolean", input);
			None
		}
	}
}

/// `z.enum(values)` (or a single `z.literal`): the index of the value.
pub(crate) fn run_enum(cx: &mut Cx, input: Option<&Value>, values: &[&str]) -> Option<usize> {
	let index = input
		.and_then(Value::as_str)
		.and_then(|text| values.iter().position(|value| *value == text));
	if index.is_none() {
		cx.push(
			IssueCode::InvalidValue,
			invalid_value_message(values),
			Flow::Implicit,
		);
	}
	index
}

/// `z.literal(value)` for a string.
pub(crate) fn literal(value: &'static str) -> impl Fn(&mut Cx, Option<&Value>) -> Option<()> {
	move |cx, input| run_enum(cx, input, &[value]).map(|_| ())
}

/// `schema.nullable()`.
pub(crate) fn nullable<T>(
	inner: impl Decoder<T>,
) -> impl Fn(&mut Cx, Option<&Value>) -> Option<Option<T>> {
	move |cx, input| match input {
		Some(Value::Null) => Some(None),
		_ => inner(cx, input).map(Some),
	}
}

/// `schema.optional()`: absent stays absent.
pub(crate) fn optional<T>(
	inner: impl Decoder<T>,
) -> impl Fn(&mut Cx, Option<&Value>) -> Option<Option<T>> {
	move |cx, input| match input {
		None => Some(None),
		Some(_) => inner(cx, input).map(Some),
	}
}

/// Absent, `null` or a value: what `.nullish()` (or `.nullable().optional()`)
/// accepts, where absence and null mean different things.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Tri<T> {
	/// The key is absent (serialised by leaving it out).
	#[default]
	Absent,
	/// The key holds `null`.
	Null,
	/// The key holds a value.
	Value(T),
}

impl<T> Tri<T> {
	/// Whether the key is absent.
	#[must_use]
	pub const fn is_absent(&self) -> bool {
		matches!(self, Self::Absent)
	}

	/// The value, when one is present.
	#[must_use]
	pub const fn value(&self) -> Option<&T> {
		match self {
			Self::Value(value) => Some(value),
			_ => None,
		}
	}

	/// The key always written: `null` when there is no value
	/// (TypeScript `field: value ?? null`).
	#[must_use]
	pub fn or_null(value: Option<T>) -> Self {
		value.map_or(Self::Null, Self::Value)
	}

	/// The key written only with a value (TypeScript
	/// `...(value === null ? {} : { field: value })`).
	#[must_use]
	pub fn or_absent(value: Option<T>) -> Self {
		value.map_or(Self::Absent, Self::Value)
	}
}

impl<T: serde::Serialize> serde::Serialize for Tri<T> {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		match self {
			Self::Absent | Self::Null => serializer.serialize_none(),
			Self::Value(value) => value.serialize(serializer),
		}
	}
}

/// `schema.nullable().optional()` / `schema.nullish()`.
pub(crate) fn nullish<T>(
	inner: impl Decoder<T>,
) -> impl Fn(&mut Cx, Option<&Value>) -> Option<Tri<T>> {
	move |cx, input| match input {
		None => Some(Tri::Absent),
		Some(Value::Null) => Some(Tri::Null),
		Some(_) => inner(cx, input).map(Tri::Value),
	}
}

/* ---------- Arrays, tuples, records ---------- */

/// One length check of an array schema.
#[derive(Debug, Clone, Copy)]
pub enum ArrCheck {
	/// `.min(n)`.
	Min(usize),
	/// `.max(n)`.
	Max(usize),
}

/// `z.array(element)` with `checks`.
pub(crate) fn run_array<T>(
	cx: &mut Cx,
	input: Option<&Value>,
	element: &impl Decoder<T>,
	checks: &[ArrCheck],
) -> Option<Vec<T>> {
	let mark = cx.mark();
	let mut built = None;
	if let Some(Value::Array(items)) = input {
		let mut out = Vec::with_capacity(items.len());
		let mut complete = true;
		for (index, item) in items.iter().enumerate() {
			match cx.at_index(index, |cx| element(cx, Some(item))) {
				Some(value) if complete => out.push(value),
				Some(_) => {}
				None => complete = false,
			}
		}
		if complete {
			built = Some(out);
		}
	} else {
		cx.invalid_type("array", input);
	}
	// Length checks run unless an element aborted explicitly (zod's `when`).
	if !cx.explicitly_aborted_since(mark)
		&& let Some(measured) = length_of(input, None)
	{
		for check in checks {
			match *check {
				ArrCheck::Min(limit) => length_check(cx, false, limit, measured),
				ArrCheck::Max(limit) => length_check(cx, true, limit, measured),
			}
		}
	}
	built
}

/// A `z.array(element)` decoder with `checks`.
pub(crate) fn array<T>(
	element: impl Decoder<T>,
	checks: &'static [ArrCheck],
) -> impl Fn(&mut Cx, Option<&Value>) -> Option<Vec<T>> {
	move |cx, input| run_array(cx, input, &element, checks)
}

/// `z.tuple([first, second])`.
pub(crate) fn tuple2<A, B>(
	first: impl Decoder<A>,
	second: impl Decoder<B>,
) -> impl Fn(&mut Cx, Option<&Value>) -> Option<(A, B)> {
	move |cx, input| {
		let Some(Value::Array(items)) = input else {
			cx.invalid_type("tuple", input);
			return None;
		};
		if items.len() < 2 {
			cx.push(
				IssueCode::TooSmall,
				size_message(false, "array", true, 2.0),
				Flow::Implicit,
			);
			return None;
		}
		if items.len() > 2 {
			cx.push(
				IssueCode::TooBig,
				size_message(true, "array", true, 2.0),
				Flow::Implicit,
			);
		}
		let a = cx.at_index(0, |cx| first(cx, items.first()));
		let b = cx.at_index(1, |cx| second(cx, items.get(1)));
		Some((a?, b?))
	}
}

/// `z.record(key, value)`: entries in JavaScript order; `__proto__` is
/// skipped as zod skips it.
pub(crate) fn record<T>(
	key_checks: &'static [StrCheck],
	value: impl Decoder<T>,
) -> impl Fn(&mut Cx, Option<&Value>) -> Option<Vec<(String, T)>> {
	move |cx, input| {
		let Some(Value::Object(object)) = input else {
			cx.invalid_type("record", input);
			return None;
		};
		let mut out = Vec::with_capacity(object.len());
		let mut complete = true;
		for (key, item) in object.iter() {
			if key == "__proto__" {
				continue;
			}
			let mut key_cx = Cx::new();
			let key_value = Value::String(key.to_owned());
			let checked = run_string(&mut key_cx, Some(&key_value), key_checks);
			if !key_cx.issues.is_empty() {
				cx.push_at_key(
					key,
					IssueCode::InvalidKey,
					"Invalid key in record".to_owned(),
					Flow::Implicit,
				);
				continue;
			}
			match cx.at_key(key, |cx| value(cx, Some(item))) {
				Some(decoded) => out.push((checked.unwrap_or_else(|| key.to_owned()), decoded)),
				None => complete = false,
			}
		}
		complete.then_some(out)
	}
}

/* ---------- Objects and unions ---------- */

/// The object behind a value (`invalid_type expected object` otherwise).
pub(crate) fn object_input<'v>(cx: &mut Cx, input: Option<&'v Value>) -> Option<&'v Object> {
	match input {
		Some(Value::Object(object)) => Some(object),
		_ => {
			cx.invalid_type("object", input);
			None
		}
	}
}

/// Reports the keys of a strict object outside `known`, once, after the
/// per-key issues (`unrecognized_keys` continues).
pub(crate) fn unrecognized(cx: &mut Cx, object: &Object, known: &[&str]) {
	let unknown: Vec<&str> = object.keys().filter(|key| !known.contains(key)).collect();
	if unknown.is_empty() {
		return;
	}
	let listed: Vec<String> = unknown.iter().map(|key| quoted(key)).collect();
	let plural = if unknown.len() > 1 { "s" } else { "" };
	cx.push(
		IssueCode::UnrecognizedKeys,
		format!("Unrecognized key{plural}: {}", listed.join(", ")),
		Flow::Continue,
	);
}

/// `z.discriminatedUnion(discriminator, options)` whose options are tagged
/// with the string literals `tags`: `decode` receives the index of the tag
/// and decodes the same input as that option.
pub(crate) fn run_discriminated<T>(
	cx: &mut Cx,
	input: Option<&Value>,
	discriminator: &str,
	tags: &[&str],
	decode: impl FnOnce(&mut Cx, usize) -> Option<T>,
) -> Option<T> {
	let object = object_input(cx, input)?;
	let tag = object
		.get(discriminator)
		.and_then(Value::as_str)
		.and_then(|tag| tags.iter().position(|candidate| *candidate == tag));
	match tag {
		Some(index) => decode(cx, index),
		None => {
			let options: Vec<String> = tags.iter().map(|tag| format!("'{tag}'")).collect();
			cx.push_at_key(
				discriminator,
				IssueCode::InvalidUnion,
				format!(
					"Invalid discriminator value. Expected {}",
					options.join(" | ")
				),
				Flow::Implicit,
			);
			None
		}
	}
}

/// One option of [`run_union`].
pub(crate) type UnionOption<'a, T> = &'a dyn Fn(&mut Cx, Option<&Value>) -> Option<T>;

/// `z.union(options)`: the first option without issues; else the only one
/// that did not abort (with its issues); else one `invalid_union`.
pub(crate) fn run_union<T>(
	cx: &mut Cx,
	input: Option<&Value>,
	options: &[UnionOption<'_, T>],
) -> Option<T> {
	let mut attempts: Vec<(Option<T>, Vec<Issue>, bool)> = Vec::with_capacity(options.len());
	for option in options {
		let mark = cx.mark();
		let result = option(cx, input);
		if !cx.has_issues_since(mark) {
			return result;
		}
		let aborted = cx.aborted_since(mark);
		attempts.push((result, cx.take_since(mark), aborted));
	}
	let mut survivors = attempts.into_iter().filter(|(_, _, aborted)| !aborted);
	if let (Some((value, issues, _)), None) = (survivors.next(), survivors.next()) {
		cx.restore(issues);
		return value;
	}
	cx.push(
		IssueCode::InvalidUnion,
		"Invalid input".to_owned(),
		Flow::Implicit,
	);
	None
}

/// Runs `refine(value)` when the schema has not aborted since `mark`
/// (`.refine` and `.superRefine` checks).
pub(crate) fn refine<T>(
	cx: &mut Cx,
	mark: usize,
	value: Option<&T>,
	check: impl FnOnce(&mut Cx, &T),
) {
	if let Some(value) = value
		&& !cx.aborted_since(mark)
	{
		check(cx, value);
	}
}

/// Declares a JavaScript string enum: the Rust enum, its zod values in
/// order, a decoder and string serialisation.
macro_rules! js_enum {
	($(#[$meta:meta])* $vis:vis enum $name:ident { $($(#[$vmeta:meta])* $variant:ident = $value:literal),+ $(,)? }) => {
		$(#[$meta])*
		#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
		$vis enum $name {
			$($(#[$vmeta])* #[doc = concat!("`\"", $value, "\"`")] $variant),+
		}

		impl $name {
			/// The zod enum values, in declaration order.
			pub const VALUES: &'static [&'static str] = &[$($value),+];
			const ALL: &'static [$name] = &[$($name::$variant),+];

			/// The value as it travels on the wire.
			#[must_use]
			pub const fn as_str(self) -> &'static str {
				match self {
					$($name::$variant => $value),+
				}
			}

			/// The variant named `value`, if any.
			#[must_use]
			pub fn from_str_value(value: &str) -> Option<Self> {
				Self::VALUES
					.iter()
					.position(|candidate| *candidate == value)
					.and_then(|index| Self::ALL.get(index).copied())
			}

			/// zod decoder for this enum.
			pub fn decode(
				cx: &mut $crate::zod::Cx,
				input: Option<&research_js::json::Value>,
			) -> Option<Self> {
				$crate::zod::run_enum(cx, input, Self::VALUES).and_then(|index| Self::ALL.get(index).copied())
			}
		}

		impl serde::Serialize for $name {
			fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
				serializer.serialize_str(self.as_str())
			}
		}

		impl std::fmt::Display for $name {
			fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
				formatter.write_str(self.as_str())
			}
		}
	};
}
pub(crate) use js_enum;

/// Decodes a strict (or, with `loose`, key-stripping) object into a struct:
/// every field is decoded in the listed (shape) order under its key, then
/// unknown keys are reported. `[tags]` lists shape keys that are checked
/// elsewhere (a discriminator) and so are known but not decoded here.
macro_rules! decode_object {
	($cx:expr, $input:expr, $mode:ident, [$($tag:literal),*], $head:ident $(:: $tail:ident)* { $($field:ident : $key:literal => $decoder:expr),* $(,)? }) => {{
		let cx: &mut $crate::zod::Cx = $cx;
		let input: Option<&research_js::json::Value> = $input;
		match $crate::zod::object_input(cx, input) {
			None => None,
			Some(object) => {
				$(
					let $field = cx.at_key($key, |cx| ($decoder)(cx, object.get($key)));
				)*
				$crate::zod::decode_object!(@unknown $mode, cx, object, [$($tag,)* $($key),*]);
				match ($($field,)*) {
					($(Some($field),)*) => Some($head $(:: $tail)* { $($field),* }),
					#[allow(unreachable_patterns)]
					_ => None,
				}
			}
		}
	}};
	(@unknown strict, $cx:ident, $object:ident, [$($key:literal),* $(,)?]) => {
		$crate::zod::unrecognized($cx, $object, &[$($key),*]);
	};
	(@unknown loose, $cx:ident, $object:ident, [$($key:literal),* $(,)?]) => {};
}
pub(crate) use decode_object;

/// Decodes the listed fields of an object that is already known to be an
/// object (a member of a union whose common fields are decoded elsewhere).
macro_rules! decode_fields {
	($cx:expr, $object:expr, $head:ident $(:: $tail:ident)* { $($field:ident : $key:literal => $decoder:expr),* $(,)? }) => {{
		let cx: &mut $crate::zod::Cx = $cx;
		let object: &research_js::json::Object = $object;
		$(
			let $field = cx.at_key($key, |cx| ($decoder)(cx, object.get($key)));
		)*
		match ($($field,)*) {
					($(Some($field),)*) => Some($head $(:: $tail)* { $($field),* }),
					#[allow(unreachable_patterns)]
					_ => None,
				}
	}};
}
pub(crate) use decode_fields;

#[cfg(test)]
mod tests {
	use super::*;

	fn issues_of<T>(decode: impl Decoder<T>, text: &str) -> Vec<(String, String, String)> {
		let value = research_js::json::parse(text).unwrap_or_default();
		let mut cx = Cx::new();
		let _ = decode(&mut cx, Some(&value));
		cx.into_issues()
			.into_iter()
			.map(|issue| {
				(
					issue.code.as_str().to_owned(),
					issue.path_string("."),
					issue.message,
				)
			})
			.collect()
	}

	#[test]
	fn string_lengths_count_code_points() {
		const MAX2: &[StrCheck] = &[StrCheck::Max(2)];
		assert!(issues_of(string(MAX2), "\"😀😀\"").is_empty());
		assert_eq!(
			issues_of(string(MAX2), "\"😀😀😀\""),
			[(
				"too_big".to_owned(),
				String::new(),
				"Too big: expected string to have <=2 characters".to_owned()
			)]
		);
	}

	#[test]
	fn length_checks_run_on_wrong_types() {
		const CHECKS: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(3)];
		assert_eq!(
			issues_of(string(CHECKS), "[1,2,3,4]"),
			[
				(
					"invalid_type".to_owned(),
					String::new(),
					"Invalid input: expected string, received array".to_owned()
				),
				(
					"too_big".to_owned(),
					String::new(),
					"Too big: expected array to have <=3 items".to_owned()
				),
			]
		);
	}

	#[test]
	fn integers_are_safe() {
		const INT: &[NumCheck] = &[NumCheck::Int];
		assert_eq!(
			issues_of(number(INT), "9007199254740992"),
			[(
				"too_big".to_owned(),
				String::new(),
				"Too big: expected int to be <=9007199254740991".to_owned()
			)]
		);
		assert_eq!(issues_of(number(INT), "1.5").len(), 1);
		assert_eq!(string_to_number(" 0x1F "), 31.0);
		assert!(string_to_number("1e").is_nan());
	}
}
