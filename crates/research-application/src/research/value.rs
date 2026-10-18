//! Small accessors for schema-validated model drafts and presentation JSON.
use super::PipelineError;
use research_js::json::{Object, Value};
use serde::Serialize;

pub(super) fn o<const N: usize>(fields: [(&str, Value); N]) -> Value {
	Value::Object(Object::from_members(
		fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
	))
}
pub(super) fn s(v: impl Into<String>) -> Value {
	Value::String(v.into())
}
pub(super) fn n(v: f64) -> Value {
	Value::Number(v)
}
pub(super) fn a(v: impl IntoIterator<Item = Value>) -> Value {
	Value::Array(v.into_iter().collect())
}
pub(super) static NULL: Value = Value::Null;
pub(super) fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
	if let Value::Object(v) = v {
		v.get(key).unwrap_or(&NULL)
	} else {
		&NULL
	}
}
pub(super) fn str_(v: &Value) -> &str {
	v.as_str().unwrap_or_default()
}
pub(super) fn field<'a>(v: &'a Value, key: &str) -> &'a str {
	str_(get(v, key))
}
pub(super) fn list(v: &Value) -> &[Value] {
	v.as_array().unwrap_or_default()
}
pub(super) fn items<'a>(v: &'a Value, key: &str) -> &'a [Value] {
	list(get(v, key))
}
pub(super) fn num(v: &Value) -> Option<f64> {
	if let Value::Number(n) = v {
		Some(*n)
	} else {
		None
	}
}
pub(super) fn set(v: &mut Value, key: &str, value: Value) {
	if let Value::Object(o) = v {
		o.insert(key, value);
	}
}
pub(super) fn strings(v: &Value) -> Vec<String> {
	list(v).iter().map(|v| str_(v).to_owned()).collect()
}
pub(super) fn json<T: Serialize + ?Sized>(v: &T) -> Result<Value, PipelineError> {
	Ok(research_contracts::json::to_js_value(v)?)
}
pub(super) fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
	let mut seen = std::collections::HashSet::new();
	values
		.into_iter()
		.filter(|id| seen.insert(id.clone()))
		.collect()
}
pub(super) fn ids(values: impl IntoIterator<Item = String>) -> Value {
	a(unique(values).into_iter().take(40).map(s))
}
