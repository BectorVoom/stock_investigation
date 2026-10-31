//! Runner configuration, read once from the process environment (port of
//! `apps/runner/src/config.ts`, shell-wire spec section 1.3). Secrets stay
//! in this object: they are never logged, never placed in prompts and never
//! forwarded to agent CLIs (which get their own allowlisted environment).

use std::collections::BTreeMap;
use std::fmt;

use research_js::whitespace::trim;
use url::{Host, Url};

/// The environment the runner sees: the process environment overlaid with
/// the `--env-file-if-exists` file (existing variables win). A plain map, so
/// nothing ever calls `std::env::set_var`.
pub type Env = BTreeMap<String, String>;

/// Free-plan default: 8 Twelve Data request starts per minute.
pub const DEFAULT_TWELVE_DATA_REQUESTS_PER_MINUTE: u32 = 8;
/// Lower bound of `TWELVE_DATA_REQUESTS_PER_MINUTE`.
pub const TWELVE_DATA_REQUESTS_PER_MINUTE_MIN: u32 = 1;
/// Upper bound of `TWELVE_DATA_REQUESTS_PER_MINUTE`.
pub const TWELVE_DATA_REQUESTS_PER_MINUTE_MAX: u32 = 600;
/// Default `TWELVE_DATA_DAILY_LIMIT`: the Basic (free) plan's 800 credits a
/// UTC day. Paid plans have no daily limit: they set 0.
pub const DEFAULT_TWELVE_DATA_DAILY_LIMIT: u32 = 800;
/// Upper bound of `TWELVE_DATA_DAILY_LIMIT`; 0 means no daily limit.
pub const TWELVE_DATA_DAILY_LIMIT_MAX: u32 = 1_000_000;

/// The problem messages are logged verbatim (zod 4.6.5 default texts).
const API_URL_PROBLEM: &str = "RESEARCH_API_URL must be https (http is allowed for localhost only)";
const TOKEN_PROBLEM: &str = "RUNNER_TOKEN is missing or malformed";
const USER_AGENT_TOO_SMALL: &str = "Too small: expected string to have >=8 characters";
const USER_AGENT_TOO_BIG: &str = "Too big: expected string to have <=200 characters";
const RATE_NOT_A_NUMBER: &str = "Invalid input: expected number, received NaN";
const TAVILY_KEY_PROBLEM: &str = "TAVILY_API_KEY must be 8–280 printable characters without spaces";
const EDINET_KEY_PROBLEM: &str = "EDINET_API_KEY must be 8–200 printable characters without spaces";
const RATE_TOO_SMALL: &str = "Too small: expected number to be >=1";
const RATE_TOO_BIG: &str = "Too big: expected number to be <=600";
/// `DAILY_LIMIT_PROBLEM`: one message for every refusal of the setting.
const DAILY_LIMIT_PROBLEM: &str =
	"TWELVE_DATA_DAILY_LIMIT must be a whole number from 0 to 1000000 (0: no daily limit)";

/// Validated runner configuration.
#[derive(Clone, PartialEq, Eq)]
pub struct RunnerConfig {
	/// Base URL of the deployed Worker, e.g. `https://research.example.workers.dev`.
	pub api_url: String,
	/// The runner's bearer token.
	pub runner_token: String,
	/// Optional Cloudflare Access service token id, when the runner path sits behind Access.
	pub access_client_id: Option<String>,
	/// Optional Cloudflare Access service token secret.
	pub access_client_secret: Option<String>,
	/// SEC fair-access policy requires a contact User-Agent; without it SEC tools are disabled.
	pub sec_user_agent: Option<String>,
	/// Owner opt-in to backends whose own tools could not be verified as disabled.
	pub allow_unverified_tool_isolation: bool,
	/// Parent of the per-job scratch directories.
	pub scratch_root: Option<String>,
	/// Where retrieved public pages are archived; without it web page retrieval is disabled.
	pub pages_directory: Option<String>,
	/// FRED API key for Home market data.
	pub fred_api_key: Option<String>,
	/// Twelve Data API key for Home market data.
	pub twelve_data_api_key: Option<String>,
	/// Finnhub API key for earnings dates (FR-018).
	pub finnhub_api_key: Option<String>,
	/// Tavily API key for `web.search` (ADR-0025); without it only `news.search` is offered.
	pub tavily_api_key: Option<String>,
	/// EDINET API v2 subscription key (ADR-0048); without it Japanese
	/// companies' financial syncs fail with `FINANCIAL_SOURCE_NOT_CONFIGURED`.
	pub edinet_api_key: Option<String>,
	/// Google OAuth "Desktop app" client id (FR-019).
	pub google_oauth_client_id: Option<String>,
	/// Google OAuth "Desktop app" client secret.
	pub google_oauth_client_secret: Option<String>,
	/// Runner-side refresh-token file (mode 0600; the launch plan sets it).
	pub google_token_file: String,
	/// Twelve Data request starts per minute (free plan: 8).
	pub twelve_data_requests_per_minute: u32,
	/// Twelve Data request starts per UTC day (Basic plan: 800); 0: none.
	pub twelve_data_daily_limit: u32,
}

/// Every credential is redacted: a derived `Debug` would print them.
impl fmt::Debug for RunnerConfig {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		let secret = |value: &Option<String>| value.as_ref().map(|_| "[REDACTED]");
		formatter
			.debug_struct("RunnerConfig")
			.field("api_url", &self.api_url)
			.field("runner_token", &"[REDACTED]")
			.field("access_client_id", &secret(&self.access_client_id))
			.field("access_client_secret", &secret(&self.access_client_secret))
			.field("sec_user_agent", &self.sec_user_agent)
			.field(
				"allow_unverified_tool_isolation",
				&self.allow_unverified_tool_isolation,
			)
			.field("scratch_root", &self.scratch_root)
			.field("pages_directory", &self.pages_directory)
			.field("fred_api_key", &secret(&self.fred_api_key))
			.field("twelve_data_api_key", &secret(&self.twelve_data_api_key))
			.field("finnhub_api_key", &secret(&self.finnhub_api_key))
			.field("tavily_api_key", &secret(&self.tavily_api_key))
			.field("edinet_api_key", &secret(&self.edinet_api_key))
			.field(
				"google_oauth_client_id",
				&secret(&self.google_oauth_client_id),
			)
			.field(
				"google_oauth_client_secret",
				&secret(&self.google_oauth_client_secret),
			)
			.field("google_token_file", &self.google_token_file)
			.field(
				"twelve_data_requests_per_minute",
				&self.twelve_data_requests_per_minute,
			)
			.field("twelve_data_daily_limit", &self.twelve_data_daily_limit)
			.finish()
	}
}

/// `blankToNull`: JavaScript `trim()`, blank means unset.
fn blank_to_null(env: &Env, key: &str) -> Option<String> {
	let trimmed = trim(env.get(key).map_or("", String::as_str));
	(!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `URL.canParse` plus the scheme rule. Plain HTTP would expose the runner
/// token; it is allowed only for a local dev Worker.
fn is_acceptable_api_url(text: &str) -> bool {
	let Ok(url) = Url::parse(text) else {
		return false;
	};
	let loopback = match url.host() {
		Some(Host::Domain(domain)) => domain == "localhost",
		Some(Host::Ipv4(address)) => address.octets() == [127, 0, 0, 1],
		Some(Host::Ipv6(address)) => {
			address.is_loopback() && address.segments() == [0, 0, 0, 0, 0, 0, 0, 1]
		}
		None => false,
	};
	url.scheme() == "https" || (url.scheme() == "http" && loopback)
}

/// `/^[A-Za-z0-9_]{20,200}$/` (JavaScript `$` has no trailing-newline allowance).
fn is_well_formed_token(token: &str) -> bool {
	(20..=200).contains(&token.len())
		&& token
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// `/^[\x21-\x7e]{min,max}$/`: printable ASCII without spaces (bytes are
/// characters then).
fn is_printable_key(key: &str, min: usize, max: usize) -> bool {
	(min..=max).contains(&key.len()) && key.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

/// `requestsPerMinute`: blank is the default; anything else must be 1..3
/// ASCII digits (JavaScript `\d`) for the range check to judge, else NaN.
fn requests_per_minute(env: &Env) -> Result<u32, &'static str> {
	let trimmed = trim(
		env.get("TWELVE_DATA_REQUESTS_PER_MINUTE")
			.map_or("", String::as_str),
	);
	if trimmed.is_empty() {
		return Ok(DEFAULT_TWELVE_DATA_REQUESTS_PER_MINUTE);
	}
	if trimmed.len() > 3 || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
		return Err(RATE_NOT_A_NUMBER);
	}
	let value: u32 = trimmed.parse().map_err(|_| RATE_NOT_A_NUMBER)?;
	if value < TWELVE_DATA_REQUESTS_PER_MINUTE_MIN {
		Err(RATE_TOO_SMALL)
	} else if value > TWELVE_DATA_REQUESTS_PER_MINUTE_MAX {
		Err(RATE_TOO_BIG)
	} else {
		Ok(value)
	}
}

/// `dailyLimit`: blank is the default; anything else must be 1..7 ASCII
/// digits within the bounds.
fn daily_limit(env: &Env) -> Result<u32, &'static str> {
	let trimmed = trim(env.get("TWELVE_DATA_DAILY_LIMIT").map_or("", String::as_str));
	if trimmed.is_empty() {
		return Ok(DEFAULT_TWELVE_DATA_DAILY_LIMIT);
	}
	if trimmed.len() > 7 || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
		return Err(DAILY_LIMIT_PROBLEM);
	}
	let value: u32 = trimmed.parse().map_err(|_| DAILY_LIMIT_PROBLEM)?;
	if value > TWELVE_DATA_DAILY_LIMIT_MAX {
		Err(DAILY_LIMIT_PROBLEM)
	} else {
		Ok(value)
	}
}

/// Reads and validates the configuration. On failure returns every problem,
/// in the zod object's field order, without echoing any value.
///
/// # Errors
/// One short single-line message per invalid setting.
pub fn load(env: &Env) -> Result<RunnerConfig, Vec<String>> {
	let mut problems = Vec::new();

	let api_url = trim(env.get("RESEARCH_API_URL").map_or("", String::as_str)).to_owned();
	if !is_acceptable_api_url(&api_url) {
		problems.push(API_URL_PROBLEM.to_owned());
	}
	let runner_token = trim(env.get("RUNNER_TOKEN").map_or("", String::as_str)).to_owned();
	if !is_well_formed_token(&runner_token) {
		problems.push(TOKEN_PROBLEM.to_owned());
	}
	let access_client_id = blank_to_null(env, "CF_ACCESS_CLIENT_ID");
	let access_client_secret = blank_to_null(env, "CF_ACCESS_CLIENT_SECRET");
	let sec_user_agent = blank_to_null(env, "SEC_USER_AGENT");
	if let Some(agent) = &sec_user_agent {
		// zod 4 counts string length in Unicode code points.
		let length = agent.chars().count();
		if length < 8 {
			problems.push(USER_AGENT_TOO_SMALL.to_owned());
		} else if length > 200 {
			problems.push(USER_AGENT_TOO_BIG.to_owned());
		}
	}
	let tavily_api_key = blank_to_null(env, "TAVILY_API_KEY");
	// It travels as `Authorization: Bearer <key>`: printable ASCII, no spaces.
	if tavily_api_key
		.as_deref()
		.is_some_and(|key| !is_printable_key(key, 8, 280))
	{
		problems.push(TAVILY_KEY_PROBLEM.to_owned());
	}
	let edinet_api_key = blank_to_null(env, "EDINET_API_KEY");
	// It travels as the `Subscription-Key` query parameter: printable ASCII, no spaces.
	if edinet_api_key
		.as_deref()
		.is_some_and(|key| !is_printable_key(key, 8, 200))
	{
		problems.push(EDINET_KEY_PROBLEM.to_owned());
	}
	let allow_unverified_tool_isolation = env
		.get("ALLOW_UNVERIFIED_TOOL_ISOLATION")
		.map(String::as_str)
		== Some("1");
	let google_token_file = {
		let trimmed = trim(env.get("GOOGLE_TOKEN_FILE").map_or("", String::as_str));
		if trimmed.is_empty() {
			"google-token.json".to_owned()
		} else {
			trimmed.to_owned()
		}
	};
	let twelve_data_requests_per_minute = match requests_per_minute(env) {
		Ok(value) => value,
		Err(problem) => {
			problems.push(problem.to_owned());
			DEFAULT_TWELVE_DATA_REQUESTS_PER_MINUTE
		}
	};
	let twelve_data_daily_limit = match daily_limit(env) {
		Ok(value) => value,
		Err(problem) => {
			problems.push(problem.to_owned());
			DEFAULT_TWELVE_DATA_DAILY_LIMIT
		}
	};
	if !problems.is_empty() {
		return Err(problems);
	}
	Ok(RunnerConfig {
		api_url,
		runner_token,
		access_client_id,
		access_client_secret,
		sec_user_agent,
		allow_unverified_tool_isolation,
		scratch_root: blank_to_null(env, "RUNNER_SCRATCH_ROOT"),
		pages_directory: blank_to_null(env, "RUNNER_PAGES_DIR"),
		fred_api_key: blank_to_null(env, "FRED_API_KEY"),
		twelve_data_api_key: blank_to_null(env, "TWELVE_DATA_API_KEY"),
		finnhub_api_key: blank_to_null(env, "FINNHUB_API_KEY"),
		tavily_api_key,
		edinet_api_key,
		google_oauth_client_id: blank_to_null(env, "GOOGLE_OAUTH_CLIENT_ID"),
		google_oauth_client_secret: blank_to_null(env, "GOOGLE_OAUTH_CLIENT_SECRET"),
		google_token_file,
		twelve_data_requests_per_minute,
		twelve_data_daily_limit,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn env(pairs: &[(&str, &str)]) -> Env {
		pairs
			.iter()
			.map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
			.collect()
	}

	const BASE: [(&str, &str); 2] = [
		("RESEARCH_API_URL", "https://research.example.test"),
		("RUNNER_TOKEN", "token_with_enough_characters_01"),
	];

	fn with(extra: &[(&str, &str)]) -> Env {
		let mut pairs = BASE.to_vec();
		pairs.extend_from_slice(extra);
		env(&pairs)
	}

	#[test]
	fn every_problem_is_a_short_single_line_that_echoes_no_value() {
		let bad = [
			env(&[]),
			env(&[("RESEARCH_API_URL", "notaurl")]),
			env(&[("RESEARCH_API_URL", "http://example.test/api")]),
			env(&[
				("RESEARCH_API_URL", "https://research.example.test"),
				("RUNNER_TOKEN", "short"),
			]),
			env(&[
				("RESEARCH_API_URL", "https://research.example.test"),
				("RUNNER_TOKEN", "token_with_a_line_break\ninjected"),
			]),
		];
		let mut seen = 0;
		for environment in &bad {
			for problem in load(environment).unwrap_err() {
				assert!(problem.encode_utf16().count() <= 200);
				assert!(!problem.contains('\n') && !problem.contains('\r'));
				seen += 1;
			}
		}
		assert!(seen > 0);
	}

	#[test]
	fn a_malformed_token_is_reported_without_echoing_it() {
		let problems = load(&env(&[
			("RESEARCH_API_URL", "https://research.example.test"),
			("RUNNER_TOKEN", "short"),
		]))
		.unwrap_err();
		assert_eq!(problems, vec![TOKEN_PROBLEM.to_owned()]);
	}

	#[test]
	fn twelve_data_daily_limit_defaults_to_the_basic_plan_and_zero_means_none() {
		assert_eq!(load(&with(&[])).unwrap().twelve_data_daily_limit, 800);
		for (value, expected) in [("", 800), (" 5000 ", 5000), ("0", 0), ("1000000", 1_000_000)] {
			let loaded = load(&with(&[("TWELVE_DATA_DAILY_LIMIT", value)])).unwrap();
			assert_eq!(loaded.twelve_data_daily_limit, expected, "{value:?}");
		}
		for value in ["1000001", "-1", "8.5", "many", "1e3"] {
			let problems = load(&with(&[("TWELVE_DATA_DAILY_LIMIT", value)])).unwrap_err();
			assert_eq!(problems, vec![DAILY_LIMIT_PROBLEM.to_owned()], "{value:?}");
		}
	}

	#[test]
	fn market_data_defaults_and_overrides() {
		let blank = load(&with(&[])).unwrap();
		assert_eq!(blank.fred_api_key, None);
		assert_eq!(blank.twelve_data_api_key, None);
		assert_eq!(blank.finnhub_api_key, None);
		assert_eq!(blank.twelve_data_requests_per_minute, 8);
		let keyed = load(&with(&[
			("FRED_API_KEY", "fred-key"),
			("TWELVE_DATA_API_KEY", "twelve-key"),
			("FINNHUB_API_KEY", "finnhub-key"),
			("TWELVE_DATA_REQUESTS_PER_MINUTE", "30"),
		]))
		.unwrap();
		assert_eq!(keyed.fred_api_key.as_deref(), Some("fred-key"));
		assert_eq!(keyed.twelve_data_api_key.as_deref(), Some("twelve-key"));
		assert_eq!(keyed.finnhub_api_key.as_deref(), Some("finnhub-key"));
		assert_eq!(keyed.twelve_data_requests_per_minute, 30);
	}

	#[test]
	fn a_bad_rate_is_rejected_without_echoing_it() {
		for value in ["0", "601", "1000", "8.5", "many"] {
			let problems = load(&with(&[("TWELVE_DATA_REQUESTS_PER_MINUTE", value)])).unwrap_err();
			assert_eq!(problems.len(), 1, "{value}");
			assert!(!problems[0].contains(value) || value == "1");
		}
	}

	#[test]
	fn google_settings_default_the_token_file() {
		let blank = load(&with(&[])).unwrap();
		assert_eq!(blank.google_oauth_client_id, None);
		assert_eq!(blank.google_oauth_client_secret, None);
		assert_eq!(blank.google_token_file, "google-token.json");
		let keyed = load(&with(&[
			("GOOGLE_OAUTH_CLIENT_ID", "google-client-id"),
			("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret"),
			("GOOGLE_TOKEN_FILE", "data/google-token.json"),
		]))
		.unwrap();
		assert_eq!(
			keyed.google_oauth_client_id.as_deref(),
			Some("google-client-id")
		);
		assert_eq!(keyed.google_token_file, "data/google-token.json");
	}

	#[test]
	fn debug_never_prints_a_secret() {
		let config = load(&with(&[
			("FRED_API_KEY", "fred-key-secret"),
			("CF_ACCESS_CLIENT_SECRET", "access-secret"),
		]))
		.unwrap();
		let printed = format!("{config:?}");
		assert!(!printed.contains("fred-key-secret"));
		assert!(!printed.contains("access-secret"));
		assert!(!printed.contains("token_with_enough_characters_01"));
	}

	#[test]
	fn loopback_http_is_allowed_everything_else_needs_https() {
		for url in [
			"http://localhost:8788",
			"http://127.0.0.1:8788",
			"http://[::1]:8788",
			"http://127.1:8788",
			"https://research.example.test",
		] {
			assert!(is_acceptable_api_url(url), "{url}");
		}
		for url in [
			"http://example.test",
			"ftp://localhost",
			"",
			"localhost:8788",
			"http://[::2]",
		] {
			assert!(!is_acceptable_api_url(url), "{url}");
		}
	}
}
