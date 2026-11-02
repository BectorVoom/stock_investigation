//! Canned financial statements and company profiles (port of
//! `tests/e2e/equitySyncFixtures.ts`, ADR-0048, ADR-0059): the
//! `financial-sync` sources answer the completions of
//! `examples/fixtures/equity-sync/e2e-{sec,jquants}.json` and the JP
//! directory refresh's profile source answers
//! `tests/e2e/fixtures/jquants-equities-master.json` instead of SEC and
//! J-Quants — no keys, no network — so both E2E runners store the same rows.
//!
//! - SEC: every US company gets the file's filings, `more: false`; its
//!   business description (ADR-0053) comes with a sync whose claim's
//!   `describedDocumentId` is not the description's 10-K (as the real source
//!   reads a 10-K only once). The identity keeps the file's name and fiscal
//!   year end, but its CIK is derived from the claim's symbol
//!   ([`fixture_sec_cik`]), so two tracked companies never claim one CIK.
//! - J-Quants: every Japanese company gets the file's filings (what
//!   `jquantsSummariesToSync` makes of Nintendo's live summaries), `more:
//!   false`, no description; the identity's code is the claim's own.
//! - Profiles: the live master rows through the real
//!   [`jquants_master_to_profiles`], one request.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use research_contracts::equity_financials::{
	EquityBusinessDescription, EquityFilingResult, EquityProvider, EquitySyncFailureCode,
	EquitySyncIdentity, EquitySyncRequest, is_jquants_issue_code, is_sec_cik,
};
use research_contracts::stock_company_profile::StockCompanyProfile;
use research_finance::equity_sync::{
	EquitySyncData, EquitySyncFailure, EquitySyncQuery, EquitySyncSource,
};
use research_finance::jquants_financials::{
	CompanyProfileSource, JquantsProfilesData, JquantsProfilesFailure, JquantsProfilesQuery,
	jquants_master_to_profiles,
};
use research_js::json::Value;

use crate::fixtures::FixtureError;

/// Repository-relative directory of the two completion files.
pub const EQUITY_SYNC_FIXTURE_DIR: &str = "examples/fixtures/equity-sync";
/// Repository-relative file of the canned Listed Issue Master rows.
pub const JQUANTS_MASTER_FIXTURE: &str = "tests/e2e/fixtures/jquants-equities-master.json";

/// The Japanese company the specs open, whose filings the J-Quants fixture
/// holds (Nintendo, `E2E_JQUANTS_SYMBOL`).
pub const E2E_JQUANTS_SYMBOL: &str = "7974";

/// `fixtureSecCik`: "99" + a base-31 hash of the symbol's UTF-16 code units
/// modulo 10^8 (a 10-digit CIK in a range no real filer uses).
#[must_use]
pub fn fixture_sec_cik(symbol: &str) -> String {
	let hash = symbol.encode_utf16().fold(0u64, |hash, unit| {
		(hash * 31 + u64::from(unit)) % 100_000_000
	});
	format!("99{hash:08}")
}

/// One provider's canned completion.
struct EquitySyncFixture {
	identity: EquitySyncIdentity,
	filings: Vec<EquityFilingResult>,
	/// SEC's file has one; J-Quants' has none (`null`).
	description: Option<EquityBusinessDescription>,
}

fn load_fixture(path: &Path, provider: EquityProvider) -> Result<EquitySyncFixture, FixtureError> {
	let malformed = || FixtureError::Malformed(path.to_path_buf());
	let text =
		std::fs::read_to_string(path).map_err(|_| FixtureError::Unreadable(path.to_path_buf()))?;
	let value = research_js::json::parse(&text).map_err(|_| malformed())?;
	let object = value.as_object().ok_or_else(malformed)?;
	let identity: EquitySyncIdentity =
		research_contracts::validate(object.get("identity").ok_or_else(malformed)?)
			.map_err(|_| malformed())?;
	let filings = object
		.get("filings")
		.and_then(Value::as_array)
		.ok_or_else(malformed)?
		.iter()
		.map(research_contracts::validate::<EquityFilingResult>)
		.collect::<Result<Vec<_>, _>>()
		.map_err(|_| malformed())?;
	let description = match object.get("description") {
		Some(Value::Null) => None,
		Some(value) => Some(research_contracts::validate(value).map_err(|_| malformed())?),
		None => return Err(malformed()),
	};
	let shape_ok = match provider {
		EquityProvider::Sec => is_sec_cik(&identity.source_company_id) && description.is_some(),
		EquityProvider::Jquants => {
			is_jquants_issue_code(&identity.source_company_id)
				&& identity.name.is_none()
				&& description.is_none()
		}
	};
	if !shape_ok || filings.is_empty() {
		return Err(malformed());
	}
	Ok(EquitySyncFixture {
		identity,
		filings,
		description,
	})
}

/// One provider's canned source.
pub struct FixtureEquitySyncSource {
	provider: EquityProvider,
	fixture: EquitySyncFixture,
}

#[async_trait]
impl EquitySyncSource for FixtureEquitySyncSource {
	fn provider(&self) -> EquityProvider {
		self.provider
	}

	async fn sync(&self, query: EquitySyncQuery<'_>) -> Result<EquitySyncData, EquitySyncFailure> {
		let (source_company_id, description) = match &query.target.source {
			EquitySyncRequest::Sec(request) => {
				let described = request.described_document_id.as_deref();
				let description = self.fixture.description.clone().filter(|description| {
					described != Some(description.source.source_document_id.as_str())
				});
				(fixture_sec_cik(&query.target.symbol), description)
			}
			EquitySyncRequest::Jquants(request) => (request.code.clone(), None),
		};
		if query.target.source.provider() != self.provider {
			return Err(EquitySyncFailure::own(
				EquitySyncFailureCode::SourceFailed,
				0,
			));
		}
		Ok(EquitySyncData {
			identity: Some(EquitySyncIdentity {
				source_company_id,
				..self.fixture.identity.clone()
			}),
			filings: self.fixture.filings.clone(),
			more: false,
			requests: 0,
			description,
			description_unread: None,
		})
	}
}

/// Both providers' canned sources, keyed like the runner's registry.
///
/// # Errors
/// A missing or malformed completion file.
pub fn fixture_equity_sync_sources(
	repo_root: &Path,
) -> Result<HashMap<EquityProvider, Arc<dyn EquitySyncSource>>, FixtureError> {
	let directory: PathBuf = repo_root.join(EQUITY_SYNC_FIXTURE_DIR);
	let mut sources: HashMap<EquityProvider, Arc<dyn EquitySyncSource>> = HashMap::new();
	for (provider, file) in [
		(EquityProvider::Sec, "e2e-sec.json"),
		(EquityProvider::Jquants, "e2e-jquants.json"),
	] {
		let fixture = load_fixture(&directory.join(file), provider)?;
		sources.insert(
			provider,
			Arc::new(FixtureEquitySyncSource { provider, fixture }),
		);
	}
	Ok(sources)
}

/// The canned Listed Issue Master (`fixtureCompanyProfileSource`): the
/// fixture rows' profiles, one request.
pub struct FixtureCompanyProfileSource {
	profiles: Vec<StockCompanyProfile>,
}

#[async_trait]
impl CompanyProfileSource for FixtureCompanyProfileSource {
	async fn fetch_profiles(
		&self,
		_query: JquantsProfilesQuery<'_>,
	) -> Result<JquantsProfilesData, JquantsProfilesFailure> {
		Ok(JquantsProfilesData {
			profiles: self.profiles.clone(),
			requests: 1,
		})
	}
}

/// The canned profile source over the master fixture rows.
///
/// # Errors
/// A missing master file, or one that is not an array of rows.
pub fn fixture_company_profile_source(
	repo_root: &Path,
) -> Result<FixtureCompanyProfileSource, FixtureError> {
	let path = repo_root.join(JQUANTS_MASTER_FIXTURE);
	let text =
		std::fs::read_to_string(&path).map_err(|_| FixtureError::Unreadable(path.clone()))?;
	let value =
		research_js::json::parse(&text).map_err(|_| FixtureError::Malformed(path.clone()))?;
	let rows = value
		.as_array()
		.ok_or_else(|| FixtureError::Malformed(path.clone()))?;
	Ok(FixtureCompanyProfileSource {
		profiles: jquants_master_to_profiles(rows),
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn sec_ciks_follow_the_typescript_hash() {
		// hash("AAPL") = ((65*31+65)*31+80)*31+76 = 2_001_436
		assert_eq!(fixture_sec_cik("AAPL"), "9902001436");
		assert!(is_sec_cik(&fixture_sec_cik(E2E_JQUANTS_SYMBOL)));
	}

	#[test]
	fn both_completion_files_and_the_master_load() {
		let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
		let sources = fixture_equity_sync_sources(&root).unwrap();
		assert_eq!(sources.len(), 2);
		let profiles = fixture_company_profile_source(&root).unwrap().profiles;
		assert!(
			profiles
				.iter()
				.any(|profile| profile.symbol == E2E_JQUANTS_SYMBOL)
		);
	}
}
