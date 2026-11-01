//! Canned financial statements (port of `tests/e2e/equitySyncFixtures.ts`,
//! ADR-0048): the `financial-sync` sources answer the completions of
//! `examples/fixtures/equity-sync/e2e-{sec,edinet}.json` instead of SEC and
//! EDINET — no keys, no network — so both E2E runners store the same rows.
//!
//! - every company of a provider gets that provider's filings, `more: false`;
//! - the file's business description (ADR-0053) comes with every EDINET
//!   sync, and with an SEC sync whose claim's `describedDocumentId` is not
//!   the description's 10-K (as the real source reads a 10-K only once);
//! - the identity keeps the file's name and fiscal year end, but its
//!   `sourceCompanyId` is derived from the claim's symbol
//!   ([`fixture_source_company_id`]), so two tracked companies of one
//!   provider never claim the same CIK or EDINET code;
//! - the `edinet-index` job (ADR-0058 §4) lists every EDINET filing of the
//!   file on the claim's newest date, under the securities code of the
//!   specs' Japanese company ([`E2E_EDINET_SYMBOL`] + "0") and its fixture
//!   EDINET code, so that company's `financial-sync` becomes due; the other
//!   dates list nothing. An amendment's row states no period, as EDINET's does.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use research_contracts::edinet_index::{
	EdinetIndexDayResult, EdinetIndexDocType, EdinetIndexDocument,
};
use research_contracts::equity_financials::{
	EquityBusinessDescription, EquityFilingResult, EquityProvider, EquityReportForm,
	EquitySyncIdentity, EquitySyncRequest, is_edinet_code, is_sec_cik,
};
use research_finance::edinet_index::{EdinetIndexData, EdinetIndexQuery, EdinetIndexSource};
use research_finance::equity_sync::{
	EquitySyncData, EquitySyncFailure, EquitySyncQuery, EquitySyncSource,
};
use research_js::json::Value;

use crate::fixtures::FixtureError;

/// Repository-relative directory of the two completion files.
pub const EQUITY_SYNC_FIXTURE_DIR: &str = "examples/fixtures/equity-sync";

/// `fixtureSourceCompanyId`: a base-31 hash of the symbol's UTF-16 code
/// units modulo 10^8, as "99" + 8 digits (a 10-digit CIK) or "E9" + the last
/// 4 digits (an EDINET code) — synthetic ranges no real filer uses.
#[must_use]
pub fn fixture_source_company_id(provider: EquityProvider, symbol: &str) -> String {
	let hash = symbol.encode_utf16().fold(0u64, |hash, unit| {
		(hash * 31 + u64::from(unit)) % 100_000_000
	});
	match provider {
		EquityProvider::Sec => format!("99{hash:08}"),
		EquityProvider::Edinet => format!("E9{:04}", hash % 10_000),
	}
}

/// One provider's canned completion.
struct EquitySyncFixture {
	identity: EquitySyncIdentity,
	filings: Vec<EquityFilingResult>,
	description: EquityBusinessDescription,
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
	let source_id_ok = match provider {
		EquityProvider::Sec => is_sec_cik(&identity.source_company_id),
		EquityProvider::Edinet => is_edinet_code(&identity.source_company_id),
	};
	let filings = object
		.get("filings")
		.and_then(Value::as_array)
		.ok_or_else(malformed)?
		.iter()
		.map(research_contracts::validate::<EquityFilingResult>)
		.collect::<Result<Vec<_>, _>>()
		.map_err(|_| malformed())?;
	let description: EquityBusinessDescription =
		research_contracts::validate(object.get("description").ok_or_else(malformed)?)
			.map_err(|_| malformed())?;
	if !source_id_ok || filings.is_empty() {
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
		Ok(EquitySyncData {
			identity: Some(EquitySyncIdentity {
				source_company_id: fixture_source_company_id(self.provider, &query.target.symbol),
				..self.fixture.identity.clone()
			}),
			filings: self.fixture.filings.clone(),
			more: false,
			requests: 0,
			unreadable_documents: Vec::new(),
			description: match &query.target.source {
				EquitySyncRequest::Sec(request)
					if request.described_document_id.as_deref()
						== Some(self.fixture.description.source.source_document_id.as_str()) =>
				{
					None
				}
				_ => Some(self.fixture.description.clone()),
			},
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
		(EquityProvider::Edinet, "e2e-edinet.json"),
	] {
		let fixture = load_fixture(&directory.join(file), provider)?;
		sources.insert(
			provider,
			Arc::new(FixtureEquitySyncSource { provider, fixture }),
		);
	}
	Ok(sources)
}

/// The Japanese company the E2E specs open (`E2E_EDINET_SYMBOL`).
pub const E2E_EDINET_SYMBOL: &str = "7974";

/// The canned EDINET index (`fixtureEdinetIndexSource`): the file's filings
/// on the claim's newest date, for [`E2E_EDINET_SYMBOL`].
pub struct FixtureEdinetIndexSource {
	documents: Vec<EdinetIndexDocument>,
}

#[async_trait]
impl EdinetIndexSource for FixtureEdinetIndexSource {
	async fn list(
		&self,
		query: EdinetIndexQuery<'_>,
	) -> Result<EdinetIndexData, EquitySyncFailure> {
		Ok(EdinetIndexData {
			days: query
				.days
				.iter()
				.enumerate()
				.map(|(index, date)| EdinetIndexDayResult {
					date: date.clone(),
					documents: if index == 0 {
						self.documents.clone()
					} else {
						Vec::new()
					},
				})
				.collect(),
			failed_days: Vec::new(),
			skipped_days: 0,
			dropped_rows: 0,
			requests: 0,
		})
	}
}

/// The canned EDINET index over the EDINET completion file.
///
/// # Errors
/// A missing or malformed completion file.
pub fn fixture_edinet_index_source(
	repo_root: &Path,
) -> Result<FixtureEdinetIndexSource, FixtureError> {
	let fixture = load_fixture(
		&repo_root
			.join(EQUITY_SYNC_FIXTURE_DIR)
			.join("e2e-edinet.json"),
		EquityProvider::Edinet,
	)?;
	let filer_name = fixture
		.identity
		.name
		.clone()
		.unwrap_or_else(|| "Fixture filer".to_owned());
	let documents = fixture
		.filings
		.iter()
		.map(|filing| {
			let metadata = &filing.metadata;
			let original = metadata.form == EquityReportForm::SecuritiesReport;
			EdinetIndexDocument {
				doc_id: metadata.source_document_id.clone(),
				sec_code: format!("{E2E_EDINET_SYMBOL}0"),
				edinet_code: fixture_source_company_id(EquityProvider::Edinet, E2E_EDINET_SYMBOL),
				filer_name: filer_name.clone(),
				doc_type_code: if original {
					EdinetIndexDocType::SecuritiesReport
				} else {
					EdinetIndexDocType::AmendedSecuritiesReport
				},
				period_start: if original {
					metadata.period_start.clone()
				} else {
					None
				},
				period_end: original.then(|| metadata.period_end.clone()),
				submitted_at: metadata
					.submitted_at
					.clone()
					.unwrap_or_else(|| format!("{}T15:00:00+09:00", metadata.filed_on)),
				parent_doc_id: metadata.amends_source_document_id.clone(),
			}
		})
		.collect();
	Ok(FixtureEdinetIndexSource { documents })
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn source_ids_follow_the_typescript_hash() {
		// hash("AAPL") = ((65*31+65)*31+80)*31+76 = 2_001_436
		assert_eq!(
			fixture_source_company_id(EquityProvider::Sec, "AAPL"),
			"9902001436"
		);
		assert_eq!(
			fixture_source_company_id(EquityProvider::Edinet, "AAPL"),
			"E91436"
		);
		assert!(is_sec_cik(&fixture_source_company_id(
			EquityProvider::Sec,
			"7974"
		)));
		assert!(is_edinet_code(&fixture_source_company_id(
			EquityProvider::Edinet,
			"7974"
		)));
	}

	#[test]
	fn both_completion_files_load() {
		let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
		let sources = fixture_equity_sync_sources(&root).unwrap();
		assert_eq!(sources.len(), 2);
		let index = fixture_edinet_index_source(&root).unwrap();
		assert!(!index.documents.is_empty());
		assert!(
			index
				.documents
				.iter()
				.all(|document| document.sec_code == "79740")
		);
	}
}
