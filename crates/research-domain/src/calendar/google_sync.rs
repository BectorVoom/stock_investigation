//! Port of the runner half of `packages/domain/src/calendar/googleSync.ts`
//! (FR-019 section 2.3): the event-id encoding and the sync plan.
//!
//! The runner receives the desired event bodies in the claim (the API builds
//! them with `googleEventBody` and the shared ICS text builder) and only runs
//! [`plan_google_sync`]; `googleEventBody` and
//! `canonicalGoogleSyncDigestInput` stay in the TypeScript API.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

const BASE32HEX_ALPHABET: &[u8; 32] = b"0123456789abcdefghijklmnopqrstuv";

/// `INVALID_BYTES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("INVALID_BYTES")]
pub struct Base32HexError;

/// `INVALID_DIGEST`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("INVALID_DIGEST")]
pub struct GoogleEventIdError;

/// `DUPLICATE_ID`: two desired bodies, or two managed events, share an id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("DUPLICATE_ID")]
pub struct GoogleSyncPlanError;

/// `encodeBase32Hex`: base32hex (lowercase `0-9a-v`, RFC 4648 §7) without
/// padding. The length must be a multiple of 5; 20 bytes give the 32-char
/// Google event id. (Bytes are `u8`, so the TypeScript's 0..=255 integer
/// check is the type.)
///
/// # Errors
///
/// [`Base32HexError`] when the length is not a multiple of 5.
pub fn encode_base32_hex(bytes: &[u8]) -> Result<String, Base32HexError> {
	if bytes.len() % 5 != 0 {
		return Err(Base32HexError);
	}
	let mut output = String::with_capacity(bytes.len() / 5 * 8);
	// One 5-byte chunk (40 bits) at a time, most significant character first.
	for chunk in bytes.chunks_exact(5) {
		let value = chunk
			.iter()
			.fold(0u64, |value, byte| (value << 8) | u64::from(*byte));
		for shift in (0..8).rev() {
			let index = usize::try_from((value >> (shift * 5)) & 31).unwrap_or(0);
			output.push(char::from(
				BASE32HEX_ALPHABET.get(index).copied().unwrap_or(b'0'),
			));
		}
	}
	Ok(output)
}

/// `googleEventId`: base32hex of the first 20 SHA-256 digest bytes, so a
/// re-sync never duplicates an event. Takes the digest, so the domain never
/// hashes.
///
/// # Errors
///
/// [`GoogleEventIdError`] unless exactly 20 bytes are given.
pub fn google_event_id(digest20: &[u8]) -> Result<String, GoogleEventIdError> {
	if digest20.len() != 20 {
		return Err(GoogleEventIdError);
	}
	encode_base32_hex(digest20).map_err(|_| GoogleEventIdError)
}

/// `GoogleEventBody.privateProperties`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GooglePrivateProperties {
	/// Always `"earnings"`.
	pub research_workspace: String,
	/// The watchlist stock id, e.g. `us:AAPL`.
	pub stock_id: String,
	/// The fiscal period key.
	pub period_key: String,
}

/// The full Google event body for one dated earnings announcement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleEventBody {
	/// 32 chars of `0-9a-v`.
	pub id: String,
	/// Event title.
	pub summary: String,
	/// Event description.
	pub description: String,
	/// All-day start (ISO date).
	pub start_date: String,
	/// Next civil day (Google all-day `end.date` is exclusive).
	pub end_date: String,
	/// Private extended properties.
	pub private_properties: GooglePrivateProperties,
	/// Publisher of the source.
	pub source_title: String,
	/// Source URL.
	pub source_url: String,
}

/// Status of a managed event Google returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManagedEventStatus {
	/// A live event.
	Confirmed,
	/// A deleted event (`showDeleted=true`).
	Cancelled,
}

/// Whether an event blocks time (`GoogleEventTransparency`). Every body this
/// app writes is `transparent`, like the `.ics`; Google's default (and what it
/// reports for events written before the body carried the field) is `opaque`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoogleEventTransparency {
	/// Shown as free.
	Transparent,
	/// Shown as busy.
	Opaque,
}

impl GoogleEventTransparency {
	/// The wire value.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Transparent => "transparent",
			Self::Opaque => "opaque",
		}
	}
}

/// The transparency of every event body this app writes (`GOOGLE_EVENT_TRANSPARENCY`).
pub const GOOGLE_EVENT_TRANSPARENCY: GoogleEventTransparency = GoogleEventTransparency::Transparent;

/// One managed event Google returned (`events.list` with `showDeleted=true`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedGoogleEvent {
	/// Google event id.
	pub id: String,
	/// Confirmed or cancelled.
	pub status: ManagedEventStatus,
	/// All-day start (ISO date).
	pub start_date: String,
	/// All-day end (ISO date, exclusive).
	pub end_date: String,
	/// Event title.
	pub summary: String,
	/// Event description.
	pub description: String,
	/// Free or busy.
	pub transparency: GoogleEventTransparency,
}

/// What a sync must write; every list is ordered by id ascending.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoogleSyncPlan<'a> {
	/// Desired bodies to insert.
	pub inserts: Vec<&'a GoogleEventBody>,
	/// Desired bodies to update (PATCH).
	pub updates: Vec<&'a GoogleEventBody>,
	/// Confirmed managed ids with no desired body.
	pub deletes: Vec<&'a str>,
	/// Desired ids already confirmed and identical.
	pub unchanged: Vec<&'a str>,
}

/// JavaScript's `<` on strings: UTF-16 code unit order. It differs from
/// Rust's byte (code point) order only between U+E000..=U+FFFF and astral
/// characters, which Google-returned ids could in principle contain.
fn compare_code_units(left: &str, right: &str) -> Ordering {
	if left.is_ascii() && right.is_ascii() {
		return left.cmp(right);
	}
	left.encode_utf16().cmp(right.encode_utf16())
}

fn bodies_equal(desired: &GoogleEventBody, existing: &ManagedGoogleEvent) -> bool {
	existing.transparency == GOOGLE_EVENT_TRANSPARENCY
		&& desired.start_date == existing.start_date
		&& desired.end_date == existing.end_date
		&& desired.summary == existing.summary
		&& desired.description == existing.description
}

/// `planGoogleSync`: insert when the id is unknown; update when known and
/// (cancelled, busy — `opaque`, while every body is `transparent` — or any
/// compared field — start/end/summary/description — differs); delete when a confirmed managed event's id is not desired; a
/// cancelled event that is not desired is ignored. Deterministic order.
///
/// # Errors
///
/// [`GoogleSyncPlanError`] when desired or existing ids repeat.
pub fn plan_google_sync<'a>(
	desired: &'a [GoogleEventBody],
	existing: &'a [ManagedGoogleEvent],
) -> Result<GoogleSyncPlan<'a>, GoogleSyncPlanError> {
	let mut desired_ids = HashSet::with_capacity(desired.len());
	for body in desired {
		if !desired_ids.insert(body.id.as_str()) {
			return Err(GoogleSyncPlanError);
		}
	}
	let mut existing_by_id = HashMap::with_capacity(existing.len());
	for event in existing {
		if existing_by_id.insert(event.id.as_str(), event).is_some() {
			return Err(GoogleSyncPlanError);
		}
	}
	let mut ordered: Vec<&GoogleEventBody> = desired.iter().collect();
	// Ids are unique here, so a stable sort and the TypeScript comparator agree.
	ordered.sort_by(|left, right| compare_code_units(&left.id, &right.id));
	let mut plan = GoogleSyncPlan {
		inserts: Vec::new(),
		updates: Vec::new(),
		deletes: Vec::new(),
		unchanged: Vec::new(),
	};
	for body in ordered {
		match existing_by_id.get(body.id.as_str()) {
			None => plan.inserts.push(body),
			Some(known)
				if known.status == ManagedEventStatus::Cancelled || !bodies_equal(body, known) =>
			{
				plan.updates.push(body);
			}
			Some(_) => plan.unchanged.push(body.id.as_str()),
		}
	}
	plan.deletes = existing
		.iter()
		.filter(|event| {
			event.status == ManagedEventStatus::Confirmed
				&& !desired_ids.contains(event.id.as_str())
		})
		.map(|event| event.id.as_str())
		.collect();
	plan.deletes
		.sort_by(|left, right| compare_code_units(left, right));
	Ok(plan)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn encodes_base32hex_and_event_ids() {
		assert_eq!(encode_base32_hex(&[]), Ok(String::new()));
		assert_eq!(encode_base32_hex(&[0xFF; 5]), Ok("vvvvvvvv".to_owned()));
		assert_eq!(encode_base32_hex(&[0, 1, 2]), Err(Base32HexError));
		assert_eq!(google_event_id(&[0; 20]).map(|id| id.len()), Ok(32));
		assert_eq!(google_event_id(&[0; 21]), Err(GoogleEventIdError));
	}

	#[test]
	fn orders_deletes_by_code_units() {
		let event = |id: &str| ManagedGoogleEvent {
			id: id.to_owned(),
			status: ManagedEventStatus::Confirmed,
			start_date: String::new(),
			end_date: String::new(),
			summary: String::new(),
			description: String::new(),
			transparency: GoogleEventTransparency::Transparent,
		};
		let existing = [event("\u{1F600}"), event("\u{FF21}"), event("a")];
		let plan = plan_google_sync(&[], &existing).unwrap();
		assert_eq!(plan.deletes, ["a", "\u{1F600}", "\u{FF21}"]);
		assert_eq!(
			plan_google_sync(&[], &[event("a"), event("a")]),
			Err(GoogleSyncPlanError)
		);
	}

	#[test]
	fn updates_a_busy_event_that_is_otherwise_unchanged() {
		let body = |id: &str| GoogleEventBody {
			id: id.to_owned(),
			summary: "S".to_owned(),
			description: "D".to_owned(),
			start_date: "2026-10-29".to_owned(),
			end_date: "2026-10-30".to_owned(),
			private_properties: GooglePrivateProperties {
				research_workspace: "earnings".to_owned(),
				stock_id: "us:AAPL".to_owned(),
				period_key: "2026-q4".to_owned(),
			},
			source_title: "Finnhub".to_owned(),
			source_url: "https://finnhub.io/".to_owned(),
		};
		let listed = |id: &str, transparency| ManagedGoogleEvent {
			id: id.to_owned(),
			status: ManagedEventStatus::Confirmed,
			start_date: "2026-10-29".to_owned(),
			end_date: "2026-10-30".to_owned(),
			summary: "S".to_owned(),
			description: "D".to_owned(),
			transparency,
		};
		let desired = [body("a"), body("b")];
		let existing = [
			listed("a", GoogleEventTransparency::Opaque),
			listed("b", GoogleEventTransparency::Transparent),
		];
		let plan = plan_google_sync(&desired, &existing).unwrap();
		assert_eq!(
			plan.updates
				.iter()
				.map(|b| b.id.as_str())
				.collect::<Vec<_>>(),
			["a"]
		);
		assert_eq!(plan.unchanged, ["b"]);
	}
}
