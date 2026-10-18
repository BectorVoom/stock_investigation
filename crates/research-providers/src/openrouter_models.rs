//! Public free-model catalog with shared refresh and stale-on-failure cache.
use crate::{
	http::*,
	schema::*,
	turn::{is_valid_model_id, now_ms},
};
use futures_util::{
	FutureExt, StreamExt,
	future::{BoxFuture, Shared},
};
use research_js::{
	json::{self, Value},
	whitespace::trim,
};
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// Ten-minute successful cache lifetime.
pub const FREE_MODEL_CACHE_TTL_MS: f64 = 600000.0;
/// Failed refreshes are suppressed for one minute.
pub const FREE_MODEL_FAILURE_TTL_MS: f64 = 60000.0;
/// Catalog timeout includes the body.
pub const FREE_MODEL_FETCH_TIMEOUT_MS: u64 = 10000;
/// Maximum catalog body bytes.
pub const FREE_MODEL_MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
/// A free endpoint id is case sensitive and never trimmed here.
pub fn is_openrouter_free_model_id(id: &str) -> bool {
	id == "openrouter/free" || (id.len() > 5 && id.ends_with(":free"))
}
fn zero_price(value: Option<&Value>) -> bool {
	match value {
		Some(Value::Number(n)) => n.is_finite() && *n == 0.0,
		Some(Value::String(s)) => {
			let s = trim(s);
			if s.is_empty() {
				return false;
			}
			if let Some(digits) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
				return !digits.is_empty() && digits.bytes().all(|b| b == b'0');
			}
			if let Some(digits) = s
				.strip_prefix("0o")
				.or_else(|| s.strip_prefix("0O"))
				.or_else(|| s.strip_prefix("0b"))
				.or_else(|| s.strip_prefix("0B"))
			{
				return !digits.is_empty() && digits.bytes().all(|b| b == b'0');
			}
			// JS Number accepts decimal syntax but rejects Rust's `inf` spelling.
			s.parse::<f64>().is_ok_and(|v| v.is_finite() && v == 0.0)
		}
		_ => false,
	}
}
/// Validates every entry independently; cap in payload order, then sort.
pub fn parse_free_model_ids(value: &Value) -> Vec<String> {
	let Some(entries) = value
		.as_object()
		.and_then(|o| o.get("data"))
		.and_then(Value::as_array)
	else {
		return vec![];
	};
	let mut ids = HashSet::new();
	for entry in entries {
		let parse = || -> Result<Option<&str>, Malformed> {
			let entry = object(entry)?;
			let id = string(entry, "id")?;
			let pricing = optional_object(entry, "pricing")?;
			if let Some(pricing) = pricing {
				for key in ["prompt", "completion"] {
					if let Some(value) = pricing.get(key) {
						if value.as_str().is_none() && value.as_f64().is_none_or(|v| !v.is_finite())
						{
							return Err(Malformed);
						}
					}
				}
			}
			let architecture = optional_object(entry, "architecture")?;
			let modalities = architecture.and_then(|o| o.get("output_modalities"));
			let has_text = if let Some(modalities) = modalities {
				let modalities = modalities.as_array().ok_or(Malformed)?;
				let mut text = false;
				for v in modalities {
					text |= v.as_str().ok_or(Malformed)? == "text";
				}
				text
			} else {
				true
			};
			Ok(
				if is_valid_model_id(id)
					&& is_openrouter_free_model_id(id)
					&& zero_price(pricing.and_then(|p| p.get("prompt")))
					&& zero_price(pricing.and_then(|p| p.get("completion")))
					&& has_text
				{
					Some(id)
				} else {
					None
				},
			)
		};
		if let Ok(Some(id)) = parse() {
			ids.insert(id.to_owned());
			if ids.len() >= 300 {
				break;
			}
		}
	}
	let mut ids: Vec<_> = ids.into_iter().collect();
	ids.sort();
	ids
}
#[derive(Default)]
struct CatalogState {
	cached: Option<Vec<String>>,
	cached_at: f64,
	failed_at: Option<f64>,
	inflight: Option<Shared<BoxFuture<'static, Option<Vec<String>>>>>,
}
/// One shared refresh among concurrent callers; failures never escape list().
#[derive(Clone)]
pub struct FreeModelCatalog {
	http: Arc<dyn HttpClient>,
	state: Arc<Mutex<CatalogState>>,
	clock: Arc<dyn Fn() -> f64 + Send + Sync>,
}
impl FreeModelCatalog {
	/// Uses the production wall clock.
	pub fn new(http: Arc<dyn HttpClient>) -> Self {
		Self::with_clock(http, Arc::new(now_ms))
	}
	/// A clock is injected so TTL behaviour is deterministic for callers.
	pub fn with_clock(
		http: Arc<dyn HttpClient>,
		clock: Arc<dyn Fn() -> f64 + Send + Sync>,
	) -> Self {
		Self {
			http,
			state: Arc::new(Mutex::new(CatalogState::default())),
			clock,
		}
	}
	/// Returns a fresh list, stale last-good list, or None; never rejects.
	pub async fn list(&self) -> Option<Vec<String>> {
		let mut state = self.state.lock().await;
		if let Some(refresh) = state.inflight.clone() {
			drop(state);
			return refresh.await;
		}
		let now = (self.clock)();
		if state.cached.is_some() && now - state.cached_at < FREE_MODEL_CACHE_TTL_MS
			|| state
				.failed_at
				.is_some_and(|at| now - at < FREE_MODEL_FAILURE_TTL_MS)
		{
			return state.cached.clone();
		}
		let catalog = self.clone();
		let refresh = async move {
			let cancel = CancellationToken::new();
			let result = tokio::time::timeout(
				Duration::from_millis(FREE_MODEL_FETCH_TIMEOUT_MS),
				fetch_catalog(catalog.http.clone(), cancel.clone()),
			)
			.await
			.ok()
			.flatten();
			cancel.cancel();
			let mut state = catalog.state.lock().await;
			if let Some(ids) = result {
				state.cached = Some(ids);
				state.cached_at = (catalog.clock)();
				state.failed_at = None;
			} else {
				state.failed_at = Some((catalog.clock)());
			}
			state.inflight = None;
			state.cached.clone()
		}
		.boxed()
		.shared();
		state.inflight = Some(refresh.clone());
		drop(state);
		refresh.await
	}
}
async fn fetch_catalog(
	http: Arc<dyn HttpClient>,
	cancel: CancellationToken,
) -> Option<Vec<String>> {
	let response = http
		.send(
			HttpRequest {
				method: "GET".to_owned(),
				url: MODELS_URL.to_owned(),
				headers: [("accept".to_owned(), "application/json".to_owned())].into(),
				body: String::new(),
			},
			cancel,
		)
		.await
		.ok()?;
	if !(200..300).contains(&response.status) {
		return None;
	}
	let mut body = response.body?;
	let mut bytes = Vec::new();
	while let Some(chunk) = body.next().await {
		let chunk = chunk.ok()?;
		if bytes.len() + chunk.len() > FREE_MODEL_MAX_BODY_BYTES {
			return None;
		}
		bytes.extend_from_slice(&chunk);
	}
	let value = json::parse_bytes(&bytes).ok()?;
	let ids = parse_free_model_ids(&value);
	if ids.is_empty() { None } else { Some(ids) }
}
