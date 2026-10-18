//! SEC EDGAR tools (port of `packages/adapters/src/tools/secTools.ts`):
//! annual financials for a US ticker and 13F-HR holdings of an investment
//! manager. Both reach only www.sec.gov / data.sec.gov (the SEC client pins
//! the fetcher to those hosts) and fail closed with `NOT_CONFIGURED` when the
//! owner has not supplied an SEC User-Agent.
//!
//! Every number in the output is either a figure SEC published, with its
//! concept, period, filing and evidence id, or a ratio computed by the domain
//! from two such figures. Anything else is `null` plus a reason (DATA-011).

use std::sync::Arc;

use async_trait::async_trait;
use research_agent_core::tools::{
	CollectedEvidence, Tool, ToolContext, ToolCostCategory, ToolFailure, ToolMeta,
	ToolNetworkAllowlist, ToolOutput, ToolSideEffect,
};
use research_application::ports::Hasher;
use research_contracts::records::{
	FilerScheme, FinancialMetricCode, FinancialObservation, FinancialUnit, Holding, InvestorFiling,
	IssuerIdentifier, IssuerScheme, ListingVerification, ReportingEntityIdentifier, Security,
	SourceClass, exchanges_of,
};
use research_domain::finance::filings::{
	ReportedPositionChange, ReportedPositionContext, describe_reported_position_change,
};
use research_domain::finance::types::{ActualOrEstimate, Market};
use research_domain::text::truncate::truncate_text;
use research_finance::market_data::{SharePriceQuery, SharePriceSource};
use research_finance::sec_13f::{
	ReportedPositionComparison, Sec13FFiling, Sec13FReport, Sec13FSource,
};
use research_finance::sec_client::{SEC_PUBLISHER, SecError, iso_date_to_instant};
use research_finance::sec_financials::{
	FigureResult, SecAnnualFigure, SecCompanyFinancials, SecFinancialsSource,
};
use research_js::json::{Object, Value};
use research_js::number::{to_fixed, to_js_string};
use research_js::whitespace::trim;

use crate::shared::{EvidenceInput, bound_model_text, collect_evidence, tool_failure};

/// The hosts both tools may reach (`SEC_HOSTS`).
const SEC_HOSTS: [&str; 2] = ["www.sec.gov", "data.sec.gov"];
/// Contract limit on holdings per filing record.
const MAX_HOLDINGS_PER_FILING: usize = 60;
/// Slots kept for positions that dropped out, so they are not crowded out by large books.
const MAX_NO_LONGER_REPORTED: usize = 10;
const MAX_CHANGES_IN_MODEL_TEXT: usize = 12;

const PER_FORMULA: &str = "share price / diluted EPS of the latest reported fiscal year";
/// A configured price source would still need a reviewed EPS/adjustment-basis policy before use.
const PER_NOT_IMPLEMENTED_REASON: &str = "A share-price source is configured, but computing PER from it is not implemented in this version; no ratio is reported.";

/// What the SEC tools read from.
pub struct SecToolDeps {
	/// Company-facts source.
	pub financials: Arc<dyn SecFinancialsSource>,
	/// 13F-HR source.
	pub filings: Arc<dyn Sec13FSource>,
	/// Price source (unconfigured in V1).
	pub share_price: Arc<dyn SharePriceSource>,
	/// Hashes retrieved evidence text.
	pub hasher: Arc<dyn Hasher>,
}

/// The parsed arguments of a single-string-key strict object (`z.strictObject`
/// with one trimmed string field, plus an optional id field): `None` when the
/// value is not an object, has other keys, or a field fails its check.
pub(crate) fn parse_symbol_args(
	args: &Value,
	key: &str,
	pattern: impl Fn(&str) -> bool,
	optional_id: bool,
) -> Option<Value> {
	let object = args.as_object()?;
	let allowed = |name: &str| name == key || (optional_id && name == "securityId");
	if !object.keys().all(allowed) {
		return None;
	}
	let symbol = trim(object.get(key)?.as_str()?);
	if !pattern(symbol) {
		return None;
	}
	let mut parsed = Object::new();
	parsed.insert(key, Value::String(symbol.to_owned()));
	if optional_id && let Some(id) = object.get("securityId") {
		let id = id.as_str()?;
		if !(research_contracts::patterns::ID.matches)(id) {
			return None;
		}
		parsed.insert("securityId", Value::String(id.to_owned()));
	}
	Some(Value::Object(parsed))
}

pub(crate) fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolFailure> {
	args.as_object()
		.and_then(|object| object.get(key))
		.and_then(Value::as_str)
		.ok_or_else(|| tool_failure("INVALID_ARGS", "arguments failed validation", false))
}

fn sec_failure(error: &SecError) -> ToolFailure {
	tool_failure(error.code.as_str(), &error.detail, error.retryable)
}

/// SEC's exchange text mapped to the contract's venue name by exact,
/// case-insensitive match only.
fn contract_exchange(sec_exchange: Option<&str>) -> Option<&'static str> {
	let wanted = trim(sec_exchange?).to_lowercase();
	exchanges_of(Market::Us)
		.iter()
		.copied()
		.find(|venue| venue.to_lowercase() == wanted)
}

/// ` (1.5 billion)` for large magnitudes, `""` below a million.
fn scaled(amount: f64) -> String {
	let magnitude = amount.abs();
	let (divisor, word) = if magnitude >= 1e12 {
		(1e12, "trillion")
	} else if magnitude >= 1e9 {
		(1e9, "billion")
	} else if magnitude >= 1e6 {
		(1e6, "million")
	} else {
		return String::new();
	};
	// `Number((amount / divisor).toFixed(3))`.
	let rounded = to_fixed(amount / divisor, 3)
		.parse::<f64>()
		.unwrap_or(f64::NAN);
	format!(" ({} {word})", to_js_string(rounded))
}

fn describe_figure(label: &str, figure: &FigureResult) -> String {
	match figure {
		Err(error) => format!("{label}: unavailable \u{2014} {}.", error.reason),
		Ok(value) => {
			let unit = match value.unit {
				research_finance::sec_financials::SecFigureUnit::Currency => value.currency.clone(),
				research_finance::sec_financials::SecFigureUnit::CurrencyPerShare => {
					format!("{} per share", value.currency)
				}
			};
			let filing_year = value.filing_fiscal_year.map_or_else(String::new, |year| {
				format!(
					" (SEC fiscal-year label of that filing: {})",
					to_js_string(year)
				)
			});
			format!(
				"{label}: {} = {} {unit}{} for the fiscal year ended {}, period {} to {}; form {}, accession {}, filed {}{filing_year}.",
				value.concept,
				to_js_string(value.amount),
				scaled(value.amount),
				value.period.period_end,
				value.period.period_start,
				value.period.period_end,
				value.form,
				value.accession_number,
				value.filed_at
			)
		}
	}
}

/// The figure filed most recently; the first of equals in revenue, income, EPS order.
fn latest_filed_figure(financials: &SecCompanyFinancials) -> Option<&SecAnnualFigure> {
	let selected = &financials.selected;
	[
		&selected.revenue,
		&selected.net_income,
		&selected.eps_diluted,
	]
	.into_iter()
	.filter_map(|figure| figure.as_ref().ok())
	.fold(None, |best: Option<&SecAnnualFigure>, figure| match best {
		Some(current) if current.filed_at >= figure.filed_at => Some(current),
		_ => Some(figure),
	})
}

fn reported_observation(
	context: &ToolContext,
	security_id: &str,
	metric: FinancialMetricCode,
	figure: &FigureResult,
	source_evidence_id: &str,
) -> FinancialObservation {
	let unit = if metric == FinancialMetricCode::EpsDiluted {
		FinancialUnit::CurrencyPerShare
	} else {
		FinancialUnit::Currency
	};
	let observation_id = context.ids.next_id("fo");
	match figure {
		Err(error) => FinancialObservation {
			observation_id,
			security_id: security_id.to_owned(),
			metric_code: metric,
			value: None,
			unavailable_reason: Some(truncate_text(&error.reason, 300).into_owned()),
			unit,
			currency: None,
			accounting_standard: None,
			period: None,
			actual_or_estimate: ActualOrEstimate::Actual,
			market_data_as_of: None,
			formula: None,
			source_evidence_id: Some(source_evidence_id.to_owned()),
		},
		Ok(value) => FinancialObservation {
			observation_id,
			security_id: security_id.to_owned(),
			metric_code: metric,
			value: Some(value.amount),
			unavailable_reason: None,
			unit,
			currency: Some(value.currency.clone()),
			accounting_standard: Some(value.accounting_standard),
			period: Some(value.period.clone()),
			actual_or_estimate: ActualOrEstimate::Actual,
			market_data_as_of: None,
			formula: None,
			source_evidence_id: Some(source_evidence_id.to_owned()),
		},
	}
}

fn margin_observation(
	context: &ToolContext,
	security_id: &str,
	financials: &SecCompanyFinancials,
	source_evidence_id: &str,
) -> FinancialObservation {
	let observation_id = context.ids.next_id("fo");
	let base =
		|value, unavailable_reason, accounting_standard, period, formula| FinancialObservation {
			observation_id: observation_id.clone(),
			security_id: security_id.to_owned(),
			metric_code: FinancialMetricCode::NetProfitMargin,
			value,
			unavailable_reason,
			unit: FinancialUnit::Ratio,
			currency: None,
			accounting_standard,
			period,
			actual_or_estimate: ActualOrEstimate::Actual,
			market_data_as_of: None,
			formula,
			source_evidence_id: Some(source_evidence_id.to_owned()),
		};
	match &financials.selected.net_profit_margin {
		Err(error) => base(
			None,
			Some(truncate_text(&error.reason, 300).into_owned()),
			None,
			None,
			Some("net income / revenue".to_owned()),
		),
		Ok(margin) => {
			let revenue_concept = financials
				.selected
				.revenue
				.as_ref()
				.map_or("revenue", |figure| figure.concept.as_str());
			let formula = truncate_text(
				&format!(
					"{}: us-gaap:NetIncomeLoss (attributable to parent, incl. discontinued operations) / {revenue_concept}, same fiscal year",
					research_domain::finance::net_margin::NetProfitMargin::FORMULA
				),
				200,
			)
			.into_owned();
			base(
				Some(margin.margin_ratio),
				None,
				Some(margin.accounting_standard),
				Some(margin.period.clone()),
				Some(formula),
			)
		}
	}
}

pub(crate) fn is_ticker(text: &str) -> bool {
	(1..=12).contains(&text.len())
		&& text
			.bytes()
			.all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

fn is_manager_cik(text: &str) -> bool {
	let digits = text
		.get(..3)
		.filter(|prefix| prefix.eq_ignore_ascii_case("CIK"))
		.map_or(text, |_| text.get(3..).unwrap_or(""));
	(1..=10).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
}

struct CompanyFinancialsTool {
	deps: Arc<SecToolDeps>,
	meta: ToolMeta,
}

#[async_trait]
impl Tool for CompanyFinancialsTool {
	fn meta(&self) -> &ToolMeta {
		&self.meta
	}

	fn parse_args(&self, args: &Value) -> Option<Value> {
		parse_symbol_args(args, "ticker", is_ticker, false)
	}

	async fn execute(&self, args: Value, context: ToolContext) -> Result<ToolOutput, ToolFailure> {
		let ticker = string_arg(&args, "ticker")?;
		let financials = self
			.deps
			.financials
			.latest_annual_financials(ticker, Some(&context.cancel))
			.await
			.map_err(|error| sec_failure(&error))?;
		let issuer = &financials.issuer;

		// The exchange is part of a security's identity (FR-005). SEC must state
		// one we know; otherwise no record is produced rather than a
		// plausible-looking venue.
		let exchange = contract_exchange(issuer.sec_exchange.as_deref());
		let Some(exchange) = exchange.filter(|_| {
			issuer.ticker.len() <= 12
				&& !issuer.ticker.is_empty()
				&& issuer
					.ticker
					.bytes()
					.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
		}) else {
			let stated = issuer.sec_exchange.as_deref().map_or_else(
				|| "no exchange".to_owned(),
				|text| format!("exchange \"{}\"", truncate_text(text, 40)),
			);
			return Err(tool_failure(
				"SECURITY_NOT_IDENTIFIABLE",
				&format!(
					"SEC lists {stated} for this ticker, which is not a supported listing venue; no security or financial records were created"
				),
				false,
			));
		};

		let retrieved_at = (context.now_iso)();
		let issuer_name = truncate_text(&issuer.name, 300).into_owned();
		let exchange_text = issuer.sec_exchange.as_deref().unwrap_or("not stated");
		let directory_evidence = collect_evidence(
			self.deps.hasher.as_ref(),
			EvidenceInput {
				evidence_id: context.ids.next_id("ev"),
				source_url: financials.ticker_directory_url.clone(),
				title: format!(
					"SEC company tickers and exchanges \u{2014} {}",
					issuer.ticker
				),
				publisher: SEC_PUBLISHER.to_owned(),
				published_at: None,
				retrieved_at: retrieved_at.clone(),
				effective_at: None,
				source_class: SourceClass::Other,
				retrieved_text: format!(
					"SEC ticker directory entry: ticker {}; issuer {}; CIK {}; exchange {exchange_text}.",
					issuer.ticker, issuer.name, issuer.cik
				),
				// SEC data is US-government public information; passages may be kept.
				retain_quotes: true,
				excerpt: Some(format!(
					"Ticker {}; issuer {issuer_name}; CIK {}; exchange {exchange_text}.",
					issuer.ticker, issuer.cik
				)),
			},
		);

		let latest = latest_filed_figure(&financials);
		let selected = &financials.selected;
		let margin_line = match &selected.net_profit_margin {
			Ok(margin) => format!(
				"Derived by this tool, not stated in the source: net profit margin = net income / revenue = {} ({}%).",
				to_fixed(margin.margin_ratio, 4),
				to_fixed(margin.margin_ratio * 100.0, 2)
			),
			Err(error) => format!("Net profit margin: not computed \u{2014} {}.", error.reason),
		};
		let fact_lines = [
			format!(
				"SEC EDGAR XBRL company facts for {} (CIK {}).",
				issuer.name, issuer.cik
			),
			describe_figure("Revenue", &selected.revenue),
			describe_figure("Net income", &selected.net_income),
			describe_figure("Diluted EPS", &selected.eps_diluted),
			margin_line,
		];
		let facts_evidence = collect_evidence(
			self.deps.hasher.as_ref(),
			EvidenceInput {
				evidence_id: context.ids.next_id("ev"),
				source_url: financials.company_facts_url.clone(),
				title: format!(
					"SEC EDGAR XBRL company facts \u{2014} {} (CIK {})",
					issuer.name, issuer.cik
				),
				publisher: SEC_PUBLISHER.to_owned(),
				published_at: latest.map(|figure| iso_date_to_instant(&figure.filed_at)),
				retrieved_at: retrieved_at.clone(),
				effective_at: latest.map(|figure| iso_date_to_instant(&figure.period.period_end)),
				source_class: SourceClass::RegulatoryFiling,
				retrieved_text: fact_lines.join("\n"),
				retain_quotes: true,
				excerpt: Some(
					fact_lines
						.iter()
						.take(3)
						.cloned()
						.collect::<Vec<_>>()
						.join(" "),
				),
			},
		);
		let facts_evidence_id = facts_evidence.evidence.evidence_id.clone();

		let security = Security {
			security_id: context.ids.next_id("sec"),
			country: Market::Us,
			ticker: issuer.ticker.clone(),
			exchange: exchange.to_owned(),
			issuer_name,
			issuer_identifier: Some(IssuerIdentifier {
				scheme: IssuerScheme::Cik,
				value: issuer.cik.clone(),
			}),
			listing_currency: "USD".to_owned(),
			reporting_currency: selected
				.revenue
				.as_ref()
				.ok()
				.map(|figure| figure.currency.clone()),
			// Ticker and exchange were read from SEC's own directory file by this call.
			listing_verification: ListingVerification::SourceVerified,
			former_tickers: Vec::new(),
		};
		let quote = self
			.deps
			.share_price
			.latest_quote(SharePriceQuery {
				security_id: &security.security_id,
				ticker: &security.ticker,
				exchange: &security.exchange,
			})
			.await;
		let per_reason = match &quote {
			Ok(_) => PER_NOT_IMPLEMENTED_REASON.to_owned(),
			Err(error) => error.reason.clone(),
		};
		let sid = security.security_id.as_str();
		let revenue = reported_observation(
			&context,
			sid,
			FinancialMetricCode::Revenue,
			&selected.revenue,
			&facts_evidence_id,
		);
		let net_income = reported_observation(
			&context,
			sid,
			FinancialMetricCode::NetIncome,
			&selected.net_income,
			&facts_evidence_id,
		);
		let eps = reported_observation(
			&context,
			sid,
			FinancialMetricCode::EpsDiluted,
			&selected.eps_diluted,
			&facts_evidence_id,
		);
		let margin = margin_observation(&context, sid, &financials, &facts_evidence_id);
		let per = FinancialObservation {
			observation_id: context.ids.next_id("fo"),
			security_id: security.security_id.clone(),
			metric_code: FinancialMetricCode::TrailingPer,
			value: None,
			unavailable_reason: Some(truncate_text(&per_reason, 300).into_owned()),
			unit: FinancialUnit::Ratio,
			currency: None,
			accounting_standard: None,
			period: None,
			actual_or_estimate: ActualOrEstimate::Actual,
			market_data_as_of: None,
			formula: Some(PER_FORMULA.to_owned()),
			source_evidence_id: None,
		};
		let observations = vec![revenue, net_income, eps, margin, per];

		let mut lines = vec![
			format!(
				"{} \u{2014} {} (CIK {}), listed on {exchange} per SEC. securityId: {}.",
				issuer.ticker, issuer.name, issuer.cik, security.security_id
			),
			format!(
				"[{}] {} (ticker, CIK and exchange)",
				directory_evidence.evidence.evidence_id, directory_evidence.evidence.source_url
			),
			format!(
				"[{facts_evidence_id}] {} (figures below)",
				facts_evidence.evidence.source_url
			),
		];
		lines.extend(fact_lines.iter().skip(1).cloned());
		lines.push(format!("Trailing PER: unavailable \u{2014} {per_reason}"));
		lines.push(
			"These are annual figures as reported to the SEC for the stated fiscal year, not current market data. Quote the numbers exactly as written here."
				.to_owned(),
		);
		lines.push(format!(
			"Observation ids: {}.",
			observations
				.iter()
				.map(|o| format!("{}={}", o.metric_code.as_str(), o.observation_id))
				.collect::<Vec<_>>()
				.join(", ")
		));
		Ok(ToolOutput {
			model_text: bound_model_text(&lines),
			evidence: vec![directory_evidence, facts_evidence],
			securities: vec![security],
			financial_observations: observations,
			..ToolOutput::default()
		})
	}
}

/* ---------- 13F ---------- */

fn truncated_holding(
	holding: &research_finance::sec_13f::Reported13FHolding,
	change: Option<ReportedPositionChange>,
) -> Holding {
	Holding {
		issuer_name: truncate_text(&holding.issuer_name, 300).into_owned(),
		cusip: Some(holding.cusip.clone()),
		security_id: None,
		reported_shares: holding.reported_shares,
		reported_value_usd: Some(holding.reported_value_usd),
		change_from_prior_filing: change,
	}
}

fn current_filing_holdings(report: &Sec13FReport) -> Vec<Holding> {
	// No comparison was made (no earlier filing, or a filing not read in full):
	// every position carries a null change, and nothing is said about
	// positions that might have dropped out.
	let Some(previous) = report
		.previous
		.as_ref()
		.filter(|_| report.comparison_unavailable_reason.is_none())
	else {
		return report
			.current
			.holdings
			.iter()
			.take(MAX_HOLDINGS_PER_FILING)
			.map(|holding| truncated_holding(holding, None))
			.collect();
	};
	let change_of = |cusip: &str| {
		report
			.changes
			.iter()
			.rev()
			.find(|change| change.cusip == cusip)
			.map(|change| change.change)
	};
	// `new Map(entries)`: the last entry of a repeated key wins.
	let no_longer_reported: Vec<Holding> = previous
		.holdings
		.iter()
		.filter(|holding| {
			change_of(&holding.cusip) == Some(ReportedPositionChange::NoLongerReported)
		})
		.take(MAX_NO_LONGER_REPORTED)
		.map(|holding| Holding {
			issuer_name: truncate_text(&holding.issuer_name, 300).into_owned(),
			cusip: Some(holding.cusip.clone()),
			security_id: None,
			// Both filings were read in full and this CUSIP is absent from the
			// current one: zero shares are reported, and there is no value to state.
			reported_shares: 0.0,
			reported_value_usd: None,
			change_from_prior_filing: Some(ReportedPositionChange::NoLongerReported),
		})
		.collect();
	let mut holdings: Vec<Holding> = report
		.current
		.holdings
		.iter()
		.take(MAX_HOLDINGS_PER_FILING - no_longer_reported.len())
		.map(|holding| truncated_holding(holding, change_of(&holding.cusip)))
		.collect();
	holdings.extend(no_longer_reported);
	holdings
}

fn prior_filing_holdings(filing: &Sec13FFiling) -> Vec<Holding> {
	filing
		.holdings
		.iter()
		.take(MAX_HOLDINGS_PER_FILING)
		.map(|holding| truncated_holding(holding, None))
		.collect()
}

/// Says, in the stored text itself, when a filing's holdings are not the whole picture.
fn incompleteness_note(filing: &Sec13FFiling) -> Option<String> {
	if filing.unreadable_row_count == 0 {
		return None;
	}
	let omitted = if filing.incomplete_cusips.is_empty() {
		"the affected positions could not be identified".to_owned()
	} else {
		format!(
			"positions for CUSIP {} are omitted rather than understated",
			filing.incomplete_cusips.join(", ")
		)
	};
	Some(format!(
		"INCOMPLETE: {} rows of this information table could not be read; {omitted}. The list below is not the filer's full holdings, and no change in reported positions is stated against this filing.",
		filing.unreadable_row_count
	))
}

fn filing_text(manager_name: &str, filing: &Sec13FFiling) -> String {
	let mut lines = vec![
		format!(
			"Form {} of {manager_name}: positions held as of {}, filed {}, accession {}.",
			filing.form,
			filing.filing.report_period_end,
			filing.filing.filed_at,
			filing.filing.accession_number
		),
		format!(
			"{} share positions by CUSIP; {} option or principal-amount rows excluded; {} rows unreadable. Values in US dollars{}.",
			filing.holdings.len(),
			filing.excluded_row_count,
			filing.unreadable_row_count,
			if filing.value_unit_as_filed == "usd-thousands" {
				" (filed in thousands, converted)"
			} else {
				""
			}
		),
	];
	lines.extend(incompleteness_note(filing));
	lines.extend(filing.holdings.iter().map(|holding| {
		format!(
			"{} | CUSIP {} | {} shares | value USD {}",
			holding.issuer_name,
			holding.cusip,
			to_js_string(holding.reported_shares),
			to_js_string(holding.reported_value_usd)
		)
	}));
	lines.join("\n")
}

fn filing_evidence(
	hasher: &dyn Hasher,
	context: &ToolContext,
	manager_name: &str,
	filing: &Sec13FFiling,
	retrieved_at: &str,
) -> CollectedEvidence {
	let text = filing_text(manager_name, filing);
	collect_evidence(
		hasher,
		EvidenceInput {
			evidence_id: context.ids.next_id("ev"),
			source_url: filing.filing_url.clone(),
			title: format!(
				"Form {} \u{2014} {manager_name} \u{2014} holdings as of {}",
				filing.form, filing.filing.report_period_end
			),
			publisher: SEC_PUBLISHER.to_owned(),
			published_at: Some(iso_date_to_instant(&filing.filing.filed_at)),
			retrieved_at: retrieved_at.to_owned(),
			effective_at: Some(iso_date_to_instant(&filing.filing.report_period_end)),
			source_class: SourceClass::RegulatoryFiling,
			retrieved_text: text.clone(),
			// SEC filings are US-government public information; passages may be kept.
			retain_quotes: true,
			excerpt: Some(text),
		},
	)
}

/// Largest movements first: positions that appeared or disappeared, then by
/// size of the share change.
fn notable_changes(changes: &[ReportedPositionComparison]) -> Vec<&ReportedPositionComparison> {
	let delta = |change: &ReportedPositionComparison| {
		(change.current_reported_shares.unwrap_or(0.0)
			- change.previous_reported_shares.unwrap_or(0.0))
		.abs()
	};
	let mut notable: Vec<&ReportedPositionComparison> = changes
		.iter()
		.filter(|change| change.change != ReportedPositionChange::UnchangedReportedPosition)
		.collect();
	// `delta(b) - delta(a) || a.cusip.localeCompare(b.cusip)` in V8's sort: a
	// NaN difference (infinite shares in both quarters) falls through to the
	// CUSIP, and the comparator is then not a total order.
	research_js::array_sort::sort_by_js(&mut notable, |a, b| {
		let difference = delta(b) - delta(a);
		if difference.is_nan() || difference == 0.0 {
			match a.cusip.cmp(&b.cusip) {
				std::cmp::Ordering::Less => -1.0,
				std::cmp::Ordering::Equal => 0.0,
				std::cmp::Ordering::Greater => 1.0,
			}
		} else {
			difference
		}
	});
	notable.truncate(MAX_CHANGES_IN_MODEL_TEXT);
	notable
}

struct HoldingsTool {
	deps: Arc<SecToolDeps>,
	meta: ToolMeta,
}

#[async_trait]
impl Tool for HoldingsTool {
	fn meta(&self) -> &ToolMeta {
		&self.meta
	}

	fn parse_args(&self, args: &Value) -> Option<Value> {
		parse_symbol_args(args, "managerCik", is_manager_cik, false)
	}

	async fn execute(&self, args: Value, context: ToolContext) -> Result<ToolOutput, ToolFailure> {
		let manager_cik = string_arg(&args, "managerCik")?;
		let report = self
			.deps
			.filings
			.latest_holdings(manager_cik, Some(&context.cancel))
			.await
			.map_err(|error| sec_failure(&error))?;
		let investor_name = truncate_text(&report.manager.name, 300).into_owned();
		let retrieved_at = (context.now_iso)();
		let hasher = self.deps.hasher.as_ref();

		let record = |filing: &Sec13FFiling,
		              holdings: Vec<Holding>,
		              evidence: &CollectedEvidence| InvestorFiling {
			filing_id: context.ids.next_id("fil"),
			investor_name: investor_name.clone(),
			reporting_entity_identifier: ReportingEntityIdentifier {
				scheme: FilerScheme::Cik,
				value: report.manager.cik.clone(),
			},
			form: filing.form.clone(),
			report_period_end: filing.filing.report_period_end.clone(),
			filed_at: filing.filing.filed_at.clone(),
			filing_url: filing.filing_url.clone(),
			holdings,
			source_evidence_id: evidence.evidence.evidence_id.clone(),
		};

		let current_evidence = filing_evidence(
			hasher,
			&context,
			&investor_name,
			&report.current,
			&retrieved_at,
		);
		let mut filings = vec![record(
			&report.current,
			current_filing_holdings(&report),
			&current_evidence,
		)];
		let mut evidence = vec![current_evidence];
		if let Some(previous) = &report.previous {
			let previous_evidence =
				filing_evidence(hasher, &context, &investor_name, previous, &retrieved_at);
			filings.push(record(
				previous,
				prior_filing_holdings(previous),
				&previous_evidence,
			));
			evidence.push(previous_evidence);
		}
		let describe_filing = |label: &str, filing: &Sec13FFiling, index: usize| {
			format!(
				"{label}: holdings as of {}, filed {}, {} share positions \u{2014} filingId {}, evidence [{}] {}",
				filing.filing.report_period_end,
				filing.filing.filed_at,
				filing.holdings.len(),
				filings.get(index).map_or("n/a", |f| f.filing_id.as_str()),
				evidence
					.get(index)
					.map_or("n/a", |e| e.evidence.evidence_id.as_str()),
				filing.filing_url
			)
		};
		let mut lines = vec![
			format!(
				"Form 13F-HR holdings reported by {investor_name} (CIK {}).",
				report.manager.cik
			),
			"A 13F lists positions held at quarter end and is filed weeks later. It shows no trade dates and no prices paid; describe differences only as changes in reported positions.".to_owned(),
			describe_filing("Current filing", &report.current, 0),
		];
		if let Some(previous) = &report.previous {
			lines.push(describe_filing("Previous filing", previous, 1));
		}
		for filing in std::iter::once(&report.current).chain(report.previous.as_ref()) {
			if let Some(note) = incompleteness_note(filing) {
				lines.push(format!(
					"Filing for {}: {note}",
					filing.filing.report_period_end
				));
			}
		}
		// Stated before the lists, so it survives truncation of long output.
		if let Some(reason) = &report.comparison_unavailable_reason {
			lines.push(format!(
				"No change in reported positions is stated: {reason}. Do not infer that any position was newly reported, changed or dropped."
			));
		}
		lines.push("Largest reported positions in the current filing:".to_owned());
		for holding in report.current.holdings.iter().take(10) {
			lines.push(format!(
				"  {} (CUSIP {}): {} shares, value USD {}",
				holding.issuer_name,
				holding.cusip,
				to_js_string(holding.reported_shares),
				to_js_string(holding.reported_value_usd)
			));
		}
		if report.comparison_unavailable_reason.is_none() {
			lines.push("Changes in reported positions versus the previous filing:".to_owned());
			for change in notable_changes(&report.changes) {
				let described = describe_reported_position_change(
					change.change,
					&ReportedPositionContext {
						investor_name: investor_name.clone(),
						issuer_name: change.issuer_name.clone(),
						report_period_end: report.current.filing.report_period_end.clone(),
						filed_at: report.current.filing.filed_at.clone(),
						form: report.current.form.clone(),
					},
				);
				let shares =
					|value: Option<f64>| value.map_or_else(|| "none".to_owned(), to_js_string);
				lines.push(format!(
					"  {described} Reported shares: {} -> {}.",
					shares(change.previous_reported_shares),
					shares(change.current_reported_shares)
				));
			}
		}
		Ok(ToolOutput {
			model_text: bound_model_text(&lines),
			evidence,
			investor_filings: filings,
			..ToolOutput::default()
		})
	}
}

/// The two SEC tools, in catalogue order (`createSecTools`).
#[must_use]
pub fn create_sec_tools(deps: SecToolDeps) -> Vec<Arc<dyn Tool>> {
	let deps = Arc::new(deps);
	let hosts = || ToolNetworkAllowlist::Hosts(SEC_HOSTS.iter().map(|h| (*h).to_owned()).collect());
	vec![
		Arc::new(CompanyFinancialsTool {
			deps: deps.clone(),
			meta: ToolMeta {
				tool_id: "finance.sec_company_financials",
				version: "1.0.0",
				description: "Latest fiscal-year revenue, net income, diluted EPS and net profit margin of a US-listed company, as reported to the SEC (EDGAR XBRL company facts). No share price: PER is reported unavailable.",
				args_hint: "{ \"ticker\": \"<US ticker, e.g. MSFT>\" }",
				timeout_ms: 90_000,
				permission: "research-read",
				cost_category: ToolCostCategory::RateLimited,
				side_effect: ToolSideEffect::ExternalRead,
				network_allowlist: hosts(),
			},
		}),
		Arc::new(HoldingsTool {
			deps,
			meta: ToolMeta {
				tool_id: "filings.sec_13f_holdings",
				version: "1.0.0",
				description: "Quarter-end holdings an institutional investment manager reported to the SEC on its two most recent Form 13F-HR filings, with the change in each reported position. 13F shows holdings at quarter end, not trades.",
				args_hint: "{ \"managerCik\": \"<SEC CIK of the investment manager, digits>\" }",
				timeout_ms: 120_000,
				permission: "research-read",
				cost_category: ToolCostCategory::RateLimited,
				side_effect: ToolSideEffect::ExternalRead,
				network_allowlist: hosts(),
			},
		}),
	]
}
