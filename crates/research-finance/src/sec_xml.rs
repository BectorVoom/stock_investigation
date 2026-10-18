//! The 13F information-table XML tree: fast-xml-parser's validator verdict
//! followed by its object tree for the information-table options
//! (`informationTableParser` in `sec13f.ts`).
use research_feed::{info_table, tree::Object, validator};

/// The parsed document, or `None` where the TypeScript's
/// `XMLValidator.validate(xml) !== true` or `parser.parse` throw.
pub(crate) fn parse(xml: &str) -> Option<Object> {
	let units: Vec<u16> = xml.encode_utf16().collect();
	if !validator::is_valid_xml(&units) {
		return None;
	}
	info_table::parse(&units).ok()
}
