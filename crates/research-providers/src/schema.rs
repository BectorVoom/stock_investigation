//! Small loose-object checks matching the provider's zod schemas.
use research_js::json::{Object, Value};

#[derive(Debug)]
pub(crate) struct Malformed;
pub(crate) fn object(value: &Value) -> Result<&Object, Malformed> {
	value.as_object().ok_or(Malformed)
}
pub(crate) fn string<'a>(obj: &'a Object, key: &str) -> Result<&'a str, Malformed> {
	obj.get(key).and_then(Value::as_str).ok_or(Malformed)
}
pub(crate) fn optional_string<'a>(
	obj: &'a Object,
	key: &str,
) -> Result<Option<&'a str>, Malformed> {
	obj.get(key)
		.map(|v| v.as_str().ok_or(Malformed))
		.transpose()
}
pub(crate) fn optional_object<'a>(
	obj: &'a Object,
	key: &str,
) -> Result<Option<&'a Object>, Malformed> {
	obj.get(key).map(object).transpose()
}
pub(crate) fn strings(obj: &Object, keys: &[&str]) -> Result<(), Malformed> {
	for key in keys {
		optional_string(obj, key)?;
	}
	Ok(())
}
pub(crate) fn parse(line: &str) -> Result<Value, Malformed> {
	research_js::json::parse(line).map_err(|_| Malformed)
}
pub(crate) fn contains_ascii_case(text: &str, needle: &str) -> bool {
	text.as_bytes()
		.windows(needle.len())
		.any(|part| part.eq_ignore_ascii_case(needle.as_bytes()))
}
