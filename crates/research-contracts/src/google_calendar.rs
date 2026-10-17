//! Google Calendar sync (`packages/contracts/src/googleCalendar.ts`, FR-019).

use research_js::json::Value;
use serde::Serialize;

use crate::patterns;
use crate::primitives::{HTTPS_URL, ISO_DATE};
use crate::watchlist::{PERIOD_KEY, parse_stock_id};
use crate::zod::{Cx, StrCheck, decode_object, js_enum, literal, run_string, string};

js_enum! {
	/// `googleCalendarFailureCodeSchema`.
	pub enum GoogleCalendarFailureCode {
		NotConfigured = "GOOGLE_NOT_CONFIGURED",
		AuthTimeout = "GOOGLE_AUTH_TIMEOUT",
		ConsentDenied = "GOOGLE_CONSENT_DENIED",
		ScopeMissing = "GOOGLE_SCOPE_MISSING",
		AuthExpired = "GOOGLE_AUTH_EXPIRED",
		RateLimited = "GOOGLE_RATE_LIMITED",
		RequestFailed = "GOOGLE_REQUEST_FAILED",
		NotConnected = "GOOGLE_NOT_CONNECTED",
	}
}

impl GoogleCalendarFailureCode {
	/// `GOOGLE_CALENDAR_FAILURE_REASONS`: the one fixed sentence per code.
	#[must_use]
	pub const fn reason(self) -> &'static str {
		match self {
			Self::NotConfigured => {
				"Google Calendar is not configured; set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in apps/runner/.env."
			}
			Self::AuthTimeout => "Google sign-in timed out after 5 minutes; try connecting again.",
			Self::ConsentDenied => "Google sign-in was not completed; consent was denied.",
			Self::ScopeMissing => {
				"Google did not grant the calendar permission; reconnect and allow access."
			}
			Self::AuthExpired => "The Google connection expired; reconnect Google Calendar.",
			Self::RateLimited => "The Google Calendar rate limit was reached; try again later.",
			Self::RequestFailed => "The Google Calendar request failed.",
			Self::NotConnected => "Google Calendar is not connected; connect it before syncing.",
		}
	}
}

js_enum! {
	/// `googleCalendarActionSchema`.
	pub enum GoogleCalendarAction {
		Connect = "connect",
		Sync = "sync",
		Disconnect = "disconnect",
	}
}

/// The Google OAuth endpoint every sign-in link starts with.
pub const GOOGLE_AUTH_URL_PREFIX: &str = "https://accounts.google.com/o/oauth2/v2/auth?";

/// The one OAuth scope a sign-in link may ask for.
pub const GOOGLE_CALENDAR_OAUTH_SCOPE: &str =
	"https://www.googleapis.com/auth/calendar.app.created";

/// Upper bound of claimed sync events: every stored event of every watched stock.
pub const GOOGLE_SYNC_MAX_EVENTS: usize =
	crate::watchlist::limits::MAX_STOCKS * crate::watchlist::limits::MAX_EVENTS_PER_STOCK;

const AUTH_URL_PARAMETERS: [&str; 9] = [
	"response_type",
	"client_id",
	"redirect_uri",
	"scope",
	"access_type",
	"prompt",
	"code_challenge",
	"code_challenge_method",
	"state",
];

fn is_printable_ascii(text: &str) -> bool {
	(patterns::PRINTABLE_ASCII.matches)(text)
}

fn is_url_safe(text: &str, min: usize, max: usize) -> bool {
	(min..=max).contains(&text.len())
		&& text
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// `/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/`.
fn is_loopback_redirect(text: &str) -> bool {
	text.strip_prefix("http://127.0.0.1:")
		.and_then(|rest| rest.strip_suffix('/'))
		.is_some_and(|port| {
			port.as_bytes().split_first().is_some_and(|(first, rest)| {
				(b'1'..=b'9').contains(first)
					&& rest.len() <= 4
					&& rest.iter().all(u8::is_ascii_digit)
			})
		})
}

/// `isGoogleSignInUrl`: only the sign-in link the runner is meant to build
/// (the Google endpoint, the code flow with PKCE S256, the single
/// app-created-calendars scope, a loopback redirect; every parameter at
/// most once and nothing unlisted).
#[must_use]
pub fn is_google_sign_in_url(value: &str) -> bool {
	if !value.starts_with(GOOGLE_AUTH_URL_PREFIX) || !is_printable_ascii(value) {
		return false;
	}
	let Ok(url) = url::Url::parse(value) else {
		return false;
	};
	// `url.hash !== ""`: an empty fragment reads as "" in JavaScript too.
	if url.fragment().is_some_and(|fragment| !fragment.is_empty())
		|| !url.username().is_empty()
		|| url.password().is_some_and(|password| !password.is_empty())
	{
		return false;
	}
	let mut seen: Vec<(String, String)> = Vec::new();
	for (name, parameter) in url.query_pairs() {
		if !AUTH_URL_PARAMETERS.contains(&name.as_ref())
			|| seen.iter().any(|(known, _)| *known == name)
		{
			return false;
		}
		seen.push((name.into_owned(), parameter.into_owned()));
	}
	let get = |name: &str| {
		seen.iter()
			.find(|(key, _)| key == name)
			.map(|(_, value)| value.as_str())
	};
	let client_id = get("client_id").unwrap_or("");
	let client_id_len = research_js::utf16::utf16_len(client_id);
	get("response_type") == Some("code")
		&& get("scope") == Some(GOOGLE_CALENDAR_OAUTH_SCOPE)
		&& get("code_challenge_method") == Some("S256")
		&& is_url_safe(get("code_challenge").unwrap_or(""), 43, 43)
		&& is_url_safe(get("state").unwrap_or(""), 16, 128)
		&& is_loopback_redirect(get("redirect_uri").unwrap_or(""))
		&& client_id_len > 0
		&& client_id_len <= 200
		&& get("access_type").unwrap_or("offline") == "offline"
		&& get("prompt").unwrap_or("consent") == "consent"
}

/// `googleCalendarIdSchema`.
pub(crate) const GOOGLE_CALENDAR_ID: &[StrCheck] = &[
	StrCheck::Min(1),
	StrCheck::Max(256),
	StrCheck::Regex(
		&patterns::PRINTABLE_ASCII,
		Some("calendar id must be printable ASCII"),
	),
];

/// `googleCalendarIdSchema` decoder.
pub(crate) fn google_calendar_id(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, GOOGLE_CALENDAR_ID)
}

/// The desired-digest rule (`/^[0-9a-f]{64}$/`).
pub(crate) const DESIRED_DIGEST: &[StrCheck] = &[StrCheck::Regex(
	&patterns::SHA256_HEX,
	Some("desired digest must be sha256 hex"),
)];

/// `google-auth-url` event URL rule.
pub(crate) const AUTH_URL: &[StrCheck] = &[
	StrCheck::Max(2000),
	StrCheck::Refine(
		is_google_sign_in_url,
		"auth URL must be the runner's Google sign-in link",
	),
];

const EVENT_ID: &[StrCheck] = &[StrCheck::Regex(
	&patterns::GOOGLE_EVENT_ID,
	Some("event id must be 32 base32hex chars"),
)];
const SUMMARY: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(300)];
const DESCRIPTION: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(2000)];
const SOURCE_TITLE: &[StrCheck] = &[StrCheck::Trim, StrCheck::Min(1), StrCheck::Max(200)];
const EVENT_STOCK_ID: &[StrCheck] = &[
	StrCheck::Max(64),
	StrCheck::Refine(
		|value| parse_stock_id(value).is_some(),
		"invalid watchlist stock id",
	),
];

/// The private extended properties of a synced event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleEventPrivateProperties {
	/// Always `"earnings"` (serialised as such).
	#[serde(serialize_with = "earnings_literal")]
	pub research_workspace: (),
	/// The watchlist stock id.
	pub stock_id: String,
	/// The period key.
	pub period_key: String,
}

fn earnings_literal<S: serde::Serializer>(_: &(), serializer: S) -> Result<S::Ok, S::Error> {
	serializer.serialize_str("earnings")
}

impl GoogleEventPrivateProperties {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			research_workspace: "researchWorkspace" => literal("earnings"),
			stock_id: "stockId" => string(EVENT_STOCK_ID),
			period_key: "periodKey" => string(PERIOD_KEY),
		})
	}
}

/// `googleEventBodySchema`: one desired Google event as claimed for a sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleEventBody {
	/// 32 base32hex characters.
	pub id: String,
	/// Summary (1..300).
	pub summary: String,
	/// Description (1..2000).
	pub description: String,
	/// All-day start date.
	pub start_date: String,
	/// All-day end date.
	pub end_date: String,
	/// Private extended properties.
	pub private_properties: GoogleEventPrivateProperties,
	/// Source title (trimmed, 1..200).
	pub source_title: String,
	/// https source URL.
	pub source_url: String,
}

impl GoogleEventBody {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			id: "id" => string(EVENT_ID),
			summary: "summary" => string(SUMMARY),
			description: "description" => string(DESCRIPTION),
			start_date: "startDate" => string(ISO_DATE),
			end_date: "endDate" => string(ISO_DATE),
			private_properties: "privateProperties" => GoogleEventPrivateProperties::decode,
			source_title: "sourceTitle" => string(SOURCE_TITLE),
			source_url: "sourceUrl" => string(HTTPS_URL),
		})
	}
}
