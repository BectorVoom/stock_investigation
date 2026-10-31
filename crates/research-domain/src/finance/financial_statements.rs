//! Port of the runner-facing part of
//! `packages/domain/src/finance/financialStatements.ts` (ADR-0048): the
//! vocabulary of the `financial-sync` claim and completion, which reported
//! periods are annual, how a fiscal year is labelled, which decimal text is
//! canonical, and how an SEC JSON number becomes decimal text.
//!
//! The selection of the authoritative value, free cash flow and the EDINET
//! scan plan run in the API only (TypeScript); the runner extracts facts.
//! Every function here is total and replays `vectors/domain/equity_financials.json`.

use serde::{Deserialize, Serialize};

use crate::calendar::civil_date::{
	civil_from_days, days_from_civil, is_valid_iso_date, split_iso_date,
};
use crate::literal::js_literal_enum;

js_literal_enum! {
	/// `EQUITY_MARKETS` (US first: zod's enum messages list them in this order).
	pub enum EquityMarket {
		/// United States.
		Us = "US",
		/// Japan.
		Jp = "JP",
	}
}

js_literal_enum! {
	/// `EQUITY_PROVIDERS`.
	pub enum EquityProvider {
		/// SEC EDGAR (US issuers).
		Sec = "sec",
		/// EDINET API v2 (Japanese issuers).
		Edinet = "edinet",
	}
}

impl EquityMarket {
	/// `EQUITY_PROVIDER_OF_MARKET`: the provider of each market's statutory annual reports.
	#[must_use]
	pub const fn provider(self) -> EquityProvider {
		match self {
			Self::Us => EquityProvider::Sec,
			Self::Jp => EquityProvider::Edinet,
		}
	}
}

js_literal_enum! {
	/// `EQUITY_ACCOUNTING_STANDARDS`.
	pub enum EquityAccountingStandard {
		/// US GAAP.
		UsGaap = "US-GAAP",
		/// Japanese GAAP.
		Jgaap = "JGAAP",
		/// IFRS.
		Ifrs = "IFRS",
	}
}

js_literal_enum! {
	/// `EQUITY_SCOPES`: `separate` is the non-consolidated (個別) statement.
	pub enum EquityScope {
		/// Consolidated.
		Consolidated = "consolidated",
		/// Non-consolidated.
		Separate = "separate",
	}
}

js_literal_enum! {
	/// `EQUITY_PERIOD_TYPES`.
	pub enum EquityPeriodType {
		/// A flow over a period.
		Duration = "duration",
		/// A balance at an instant.
		Instant = "instant",
	}
}

js_literal_enum! {
	/// `EQUITY_STATEMENTS`.
	pub enum EquityStatement {
		/// Income statement.
		IncomeStatement = "income-statement",
		/// Balance sheet.
		BalanceSheet = "balance-sheet",
		/// Cash-flow statement.
		CashFlow = "cash-flow",
	}
}

js_literal_enum! {
	/// `EQUITY_REPORT_FORMS`: SEC form types keep their own spelling; EDINET's
	/// docTypeCode 120 is the 有価証券報告書 and 130 its 訂正.
	pub enum EquityReportForm {
		/// SEC annual report.
		TenK = "10-K",
		/// SEC annual report amendment.
		TenKA = "10-K/A",
		/// EDINET 有価証券報告書 (docTypeCode 120).
		SecuritiesReport = "securities-report",
		/// EDINET 訂正有価証券報告書 (docTypeCode 130).
		AmendedSecuritiesReport = "amended-securities-report",
	}
}

impl EquityReportForm {
	/// `isAmendmentForm`.
	#[must_use]
	pub const fn is_amendment(self) -> bool {
		matches!(self, Self::TenKA | Self::AmendedSecuritiesReport)
	}
}

js_literal_enum! {
	/// `EQUITY_METRIC_CODES`, in statement row order.
	pub enum EquityMetricCode {
		/// Revenue.
		Revenue = "revenue",
		/// Gross profit.
		GrossProfit = "gross-profit",
		/// Operating income.
		OperatingIncome = "operating-income",
		/// Ordinary income (経常利益, JGAAP only).
		OrdinaryIncome = "ordinary-income",
		/// Profit attributable to owners of the parent.
		ProfitAttributableToOwners = "profit-attributable-to-owners",
		/// Total assets.
		TotalAssets = "total-assets",
		/// Total liabilities.
		TotalLiabilities = "total-liabilities",
		/// Total equity.
		TotalEquity = "total-equity",
		/// Cash and cash equivalents.
		CashAndCashEquivalents = "cash-and-cash-equivalents",
		/// Net cash from operating activities.
		NetCashFromOperatingActivities = "net-cash-from-operating-activities",
		/// Net cash from investing activities.
		NetCashFromInvestingActivities = "net-cash-from-investing-activities",
		/// Net cash from financing activities.
		NetCashFromFinancingActivities = "net-cash-from-financing-activities",
		/// Capital expenditures.
		CapitalExpenditures = "capital-expenditures",
		/// Free cash flow (derived).
		FreeCashFlow = "free-cash-flow",
	}
}

/* ---------- Calendar dates ---------- */

/// `isoDayNumber`: days since 1970-01-01 of a valid `YYYY-MM-DD` date, or
/// `None`. Like the TypeScript (`Date.UTC`), years below 100 are invalid.
#[must_use]
pub fn iso_day_number(iso_date: &str) -> Option<i64> {
	if !is_valid_iso_date(iso_date) {
		return None;
	}
	let (year, month, day) = split_iso_date(iso_date)?;
	Some(days_from_civil(year, month, day))
}

/// `isoDateOfDayNumber`: the ISO date of a day number (days since
/// 1970-01-01), years 0..=9999 four digits wide.
#[must_use]
pub fn iso_date_of_day_number(day_number: i64) -> String {
	let (year, month, day) = civil_from_days(day_number);
	format!("{year:04}-{month:02}-{day:02}")
}

/* ---------- Annual periods and fiscal years ---------- */

/// `ANNUAL_DURATION_DAYS`: inclusive day-count bounds of an annual duration
/// (a calendar year is 365 or 366 days, a 52/53-week year 364 or 371).
pub const ANNUAL_DURATION_DAYS: (i64, i64) = (350, 380);

/// `isAnnualDuration`.
#[must_use]
pub fn is_annual_duration(period_start: &str, period_end: &str) -> bool {
	let (Some(start), Some(end)) = (iso_day_number(period_start), iso_day_number(period_end))
	else {
		return false;
	};
	let days = end - start + 1;
	(ANNUAL_DURATION_DAYS.0..=ANNUAL_DURATION_DAYS.1).contains(&days)
}

/// `fiscalYearOfPeriodEnd`: the calendar year the period ends in, except
/// that a 52/53-week year ending in the first seven days of January belongs
/// to the year before.
#[must_use]
pub fn fiscal_year_of_period_end(period_end: &str) -> Option<i64> {
	iso_day_number(period_end)?;
	let (year, month, day) = split_iso_date(period_end)?;
	Some(if month == 1 && day <= 7 {
		year - 1
	} else {
		year
	})
}

/// `edinetSecuritiesCode`: EDINET's five-character securities code of a JPX
/// local code ("7974" → "79740").
#[must_use]
pub fn edinet_securities_code(symbol: &str) -> String {
	format!("{symbol}0")
}

/* ---------- Decimal text ---------- */

/// Longest canonical decimal text (`isCanonicalDecimal`'s `length <= 64`).
pub const MAX_DECIMAL_CHARS: usize = 64;

/// `isCanonicalDecimal`: `/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/`, not "-0",
/// at most 64 characters (ASCII, so bytes are UTF-16 units).
#[must_use]
pub fn is_canonical_decimal(value: &str) -> bool {
	let bytes = value.as_bytes();
	if bytes.len() > MAX_DECIMAL_CHARS || value == "-0" {
		return false;
	}
	let unsigned = bytes.strip_prefix(b"-").unwrap_or(bytes);
	let (whole, fraction) = match unsigned.iter().position(|byte| *byte == b'.') {
		Some(dot) => (
			unsigned.get(..dot).unwrap_or_default(),
			Some(unsigned.get(dot + 1..).unwrap_or_default()),
		),
		None => (unsigned, None),
	};
	let whole_ok = match whole {
		[b'0'] => true,
		[first, rest @ ..] => (b'1'..=b'9').contains(first) && rest.iter().all(u8::is_ascii_digit),
		[] => false,
	};
	let fraction_ok = fraction.is_none_or(|digits| {
		digits
			.last()
			.is_some_and(|last| (b'1'..=b'9').contains(last))
			&& digits.iter().all(u8::is_ascii_digit)
	});
	whole_ok && fraction_ok
}

/// `secValueDecimal`: an SEC company-facts `val` (a JSON number read as a
/// double) as exact decimal text — JavaScript's shortest round-trip text
/// (`Number#toString`, digits for every integer below 1e21), kept only when
/// it is canonical decimal text. An exponent form ("1e-7", "1e+21") is
/// skipped rather than expanded: the number already lost the filing's exact
/// digits.
#[must_use]
pub fn sec_value_decimal(value: f64) -> Option<String> {
	if !value.is_finite() {
		return None;
	}
	let text = research_js::number::to_js_string(value);
	is_canonical_decimal(&text).then_some(text)
}

/* ---------- Annual facts of one filing ---------- */

/// One as-reported fact as a runner extracted it from a filing
/// (`EquityExtractedFact`, also the completion's `equityExtractedFactSchema`
/// shape, in its key order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EquityExtractedFact {
	/// Taxonomy-qualified concept (`us-gaap:Revenues`, `jppfs_cor:NetSales`).
	pub concept: String,
	/// ISO 4217 currency for amounts; the source's unit id otherwise.
	pub unit: String,
	/// Exact decimal text as reported.
	pub value_decimal: String,
	/// Duration or instant.
	pub period_type: EquityPeriodType,
	/// Start of a duration; `None` for an instant.
	pub period_start: Option<String>,
	/// End of the period (the instant's date).
	pub period_end: String,
	/// Consolidated or separate.
	pub scope: EquityScope,
}

js_literal_enum! {
	/// `EquityFactProblem`: why `annualFactsOfFiling` dropped a fact.
	pub enum EquityFactProblem {
		/// A date is not a valid ISO date, or the dates do not fit the type.
		InvalidPeriod = "INVALID_PERIOD",
		/// A duration that is not 350–380 days.
		NotAnnualDuration = "NOT_ANNUAL_DURATION",
		/// An instant that is not the end of an annual duration of the filing.
		InstantNotAtYearEnd = "INSTANT_NOT_AT_YEAR_END",
		/// The value is not canonical decimal text.
		InvalidDecimal = "INVALID_DECIMAL",
	}
}

/// `annualFactsOfFiling`'s result: the kept facts in input order and every
/// dropped fact with its first problem.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AnnualFacts {
	/// Annual facts, in input order.
	pub kept: Vec<EquityExtractedFact>,
	/// Dropped facts, in input order, with their first problem.
	pub dropped: Vec<(EquityExtractedFact, EquityFactProblem)>,
}

/// `annualFactsOfFiling` (ADR-0048 §4): keeps only the annual facts of one
/// filing — a duration must span an annual period; an instant must fall on
/// the end of an annual duration reported in the same filing.
#[must_use]
pub fn annual_facts_of_filing(facts: Vec<EquityExtractedFact>) -> AnnualFacts {
	let mut year_ends: Vec<&str> = facts
		.iter()
		.filter(|fact| {
			fact.period_type == EquityPeriodType::Duration
				&& fact
					.period_start
					.as_deref()
					.is_some_and(|start| is_annual_duration(start, &fact.period_end))
		})
		.map(|fact| fact.period_end.as_str())
		.collect();
	year_ends.sort_unstable();
	year_ends.dedup();
	let problems: Vec<Option<EquityFactProblem>> = facts
		.iter()
		.map(|fact| annual_fact_problem(fact, &year_ends))
		.collect();
	let mut result = AnnualFacts::default();
	for (fact, problem) in facts.into_iter().zip(problems) {
		match problem {
			None => result.kept.push(fact),
			Some(problem) => result.dropped.push((fact, problem)),
		}
	}
	result
}

fn annual_fact_problem(
	fact: &EquityExtractedFact,
	year_ends: &[&str],
) -> Option<EquityFactProblem> {
	if !is_canonical_decimal(&fact.value_decimal) {
		return Some(EquityFactProblem::InvalidDecimal);
	}
	if iso_day_number(&fact.period_end).is_none() {
		return Some(EquityFactProblem::InvalidPeriod);
	}
	match fact.period_type {
		EquityPeriodType::Instant => {
			if fact.period_start.is_some() {
				return Some(EquityFactProblem::InvalidPeriod);
			}
			if year_ends.binary_search(&fact.period_end.as_str()).is_ok() {
				None
			} else {
				Some(EquityFactProblem::InstantNotAtYearEnd)
			}
		}
		EquityPeriodType::Duration => {
			let Some(start) = fact
				.period_start
				.as_deref()
				.filter(|start| iso_day_number(start).is_some())
			else {
				return Some(EquityFactProblem::InvalidPeriod);
			};
			if is_annual_duration(start, &fact.period_end) {
				None
			} else {
				Some(EquityFactProblem::NotAnnualDuration)
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn fact(
		period_type: EquityPeriodType,
		start: Option<&str>,
		end: &str,
		value: &str,
	) -> EquityExtractedFact {
		EquityExtractedFact {
			concept: "us-gaap:Revenues".to_owned(),
			unit: "USD".to_owned(),
			value_decimal: value.to_owned(),
			period_type,
			period_start: start.map(str::to_owned),
			period_end: end.to_owned(),
			scope: EquityScope::Consolidated,
		}
	}

	#[test]
	fn day_numbers_follow_date_utc() {
		assert_eq!(iso_day_number("1970-01-01"), Some(0));
		assert_eq!(iso_day_number("2024-02-29"), Some(19_782));
		assert_eq!(iso_day_number("2023-02-29"), None);
		assert_eq!(iso_day_number("0050-01-01"), None);
		assert_eq!(iso_date_of_day_number(19_782), "2024-02-29");
	}

	#[test]
	fn annual_durations_and_fiscal_years() {
		assert!(is_annual_duration("2023-10-01", "2024-09-28"));
		assert!(is_annual_duration("2024-04-01", "2025-03-31"));
		assert!(!is_annual_duration("2024-04-01", "2024-06-30"));
		assert_eq!(fiscal_year_of_period_end("2025-01-04"), Some(2024));
		assert_eq!(fiscal_year_of_period_end("2025-01-08"), Some(2025));
		assert_eq!(fiscal_year_of_period_end("2025-03-31"), Some(2025));
		assert_eq!(fiscal_year_of_period_end("2025-02-30"), None);
	}

	#[test]
	fn canonical_decimals() {
		for good in ["0", "1", "-1", "391035000000", "0.5", "-12.25"] {
			assert!(is_canonical_decimal(good), "{good}");
		}
		for bad in [
			"",
			"-0",
			"01",
			"1.",
			"1.50",
			".5",
			"1e5",
			"+1",
			"１",
			"- 1",
			&"9".repeat(65),
		] {
			assert!(!is_canonical_decimal(bad), "{bad}");
		}
	}

	#[test]
	fn sec_values_become_exact_text_or_nothing() {
		assert_eq!(
			sec_value_decimal(391_035_000_000.0).as_deref(),
			Some("391035000000")
		);
		assert_eq!(sec_value_decimal(-0.0).as_deref(), Some("0"));
		assert_eq!(sec_value_decimal(1.5).as_deref(), Some("1.5"));
		assert_eq!(
			sec_value_decimal(1e20).as_deref(),
			Some("100000000000000000000")
		);
		assert_eq!(sec_value_decimal(1e21), None);
		assert_eq!(sec_value_decimal(1e-7), None);
		assert_eq!(sec_value_decimal(f64::NAN), None);
	}

	#[test]
	fn keeps_annual_facts_only() {
		let facts = vec![
			fact(
				EquityPeriodType::Duration,
				Some("2023-10-01"),
				"2024-09-28",
				"10",
			),
			fact(
				EquityPeriodType::Duration,
				Some("2024-06-30"),
				"2024-09-28",
				"3",
			),
			fact(EquityPeriodType::Instant, None, "2024-09-28", "5"),
			fact(EquityPeriodType::Instant, None, "2024-06-29", "4"),
			fact(
				EquityPeriodType::Instant,
				Some("2024-06-29"),
				"2024-09-28",
				"4",
			),
			fact(
				EquityPeriodType::Duration,
				Some("2023-10-01"),
				"2024-09-28",
				"1.0",
			),
		];
		let result = annual_facts_of_filing(facts);
		assert_eq!(result.kept.len(), 2);
		let problems: Vec<_> = result.dropped.iter().map(|(_, problem)| *problem).collect();
		assert_eq!(
			problems,
			[
				EquityFactProblem::NotAnnualDuration,
				EquityFactProblem::InstantNotAtYearEnd,
				EquityFactProblem::InvalidPeriod,
				EquityFactProblem::InvalidDecimal,
			]
		);
	}
}
