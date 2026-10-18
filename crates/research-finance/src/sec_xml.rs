//! fast-xml-parser information-table options over its shared validator and tree representation.
use indexmap::IndexMap;
use quick_xml::{Reader,events::Event};
use research_feed::tree::{Object,Value};
use research_js::whitespace::trim;
struct Node { name: String,children: Object,text: String,pending: String }
impl Node {
	fn flush(&mut self) { self.text.push_str(trim(&self.pending)); self.pending.clear(); }
	fn value(mut self) -> Value {
		self.flush();
		if self.children.is_empty() { return Value::Text(self.text); }
		if !self.text.is_empty() { self.children.insert("#text".to_owned(),Value::Text(self.text)); }
		Value::Object(self.children)
	}
}
fn append(object: &mut Object,name: String,value: Value) {
	if let Some(existing) = object.get_mut(&name) {
		match existing { Value::Array(items) => items.push(value),_ => { let old = std::mem::replace(existing,Value::Text(String::new())); *existing = Value::Array(vec![old,value]); } }
	} else { object.insert(name,value); }
}
fn name(bytes: &[u8]) -> Option<String> {
	let raw = std::str::from_utf8(bytes).ok()?;
	let local = raw.split(':').next_back()?;
	if matches!(local,"__proto__"|"constructor"|"prototype") { return None; }
	Some(if ["hasOwnProperty","toString","valueOf","__defineGetter__","__defineSetter__","__lookupGetter__","__lookupSetter__"].contains(&local) { format!("__{local}") } else { local.to_owned() })
}
pub(crate) fn parse(xml: &str) -> Option<Object> {
	let units: Vec<_> = xml.encode_utf16().collect();
	if !research_feed::validator::is_valid_xml(&units) { return None; }
	let normalized = xml.replace("\r\n","\n").replace('\r',"\n");
	let mut reader = Reader::from_str(&normalized);
	reader.config_mut().check_end_names = false;
	let mut stack = vec![Node { name: String::new(),children: IndexMap::new(),text: String::new(),pending: String::new() }];
	loop {
		let event = reader.read_event().ok()?;
		match event {
			Event::Start(ref e) | Event::Empty(ref e) => {
				stack.last_mut()?.flush();
				let name = name(e.name().as_ref())?;
				if matches!(event,Event::Empty(_)) {
					append(&mut stack.last_mut()?.children,name,Value::Text(String::new()));
				} else {
					if stack.len()>16 { return None; }
					stack.push(Node { name,children: IndexMap::new(),text: String::new(),pending: String::new() });
				}
			}
			Event::End(_) => {
				if stack.len()<=1 { return None; }
				let node = stack.pop()?; let name = node.name.clone();
				append(&mut stack.last_mut()?.children,name,node.value());
			}
			Event::Text(e) => stack.last_mut()?.pending.push_str(std::str::from_utf8(e.as_ref()).ok()?),
			Event::GeneralRef(e) => { let pending = &mut stack.last_mut()?.pending; pending.push('&'); pending.push_str(std::str::from_utf8(e.as_ref()).ok()?); pending.push(';'); }
			Event::CData(e) => { let node = stack.last_mut()?; node.flush(); node.text.push_str(std::str::from_utf8(e.as_ref()).ok()?); }
			Event::PI(_) | Event::Decl(_) => stack.last_mut()?.flush(),
			Event::DocType(_) => { research_feed::tree::parse(&units).ok()?; }
			Event::Eof => break,
			_ => {}
		}
	}
	if stack.len()!=1 { return None; }
	stack.pop().map(|n| n.children)
}
