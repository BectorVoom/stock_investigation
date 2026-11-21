//! Sequential enrichment of model drafts: ids and notes are order-sensitive.
use super::{
	PipelineError,
	draft::{PRICE_FIELDS, parse_draft},
	value::*,
};
use research_agent_core::tools::{CollectedEvidence, IdAllocator};
use research_contracts::{
	records::{Evidence, PricingPowerRecord, Security},
	validate,
};
use research_domain::{
	evidence::{
		comparison_table::{ComparisonRowCandidate, select_verified_comparison_row_indices},
		verify_claims::{
			EvidenceIndex, extract_number_tokens, is_passage_of_prepared, mentions_prepared,
		},
	},
	finance::{
		demand_scenario::{DemandScenarioInput, ScenarioCase, derive_scenario_cagr},
		pricing_power::{PricingPowerInputs, assess_pricing_power},
	},
};
use research_js::{
	json::{Object, Value},
	number::to_js_string,
	utf16, whitespace,
};
use std::collections::{HashMap, HashSet};

pub(super) struct Records {
	pub scenarios: Vec<Value>,
	pub securities: Vec<Value>,
	pub supplier_links: Vec<Value>,
	pub pricing_power: Vec<Value>,
	pub comparison_tables: Vec<Value>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_records(
	analysis: &Value,
	mut securities: Vec<Value>,
	claims: &[Value],
	shown: &[CollectedEvidence],
	claim_evidence_id: &dyn Fn(&str) -> String,
	index: &EvidenceIndex,
	retain: &HashSet<String>,
	markets: &[research_domain::finance::types::Market],
	ids_: &dyn IdAllocator,
	notes: &mut Vec<String>,
) -> Result<Records, PipelineError> {
	let known = |value: &Value| {
		a(unique(
			strings(value)
				.into_iter()
				.filter(|id| index.get(id).is_some()),
		)
		.into_iter()
		.map(s))
	};
	let mut scenarios = Vec::new();
	let mut by_draft = HashMap::new();
	for (i, raw) in items(analysis, "scenarios").iter().enumerate() {
		let Ok(mut v) = parse_draft("scenario", raw) else {
			notes.push(format!("Scenario {} was dropped: malformed.", i + 1));
			continue;
		};
		let baseline = num(get(&v, "baselineValue"));
		let stated = baseline.is_some_and(|baseline| {
			index.get(field(&v, "baselineEvidenceId")).is_some_and(|t| {
				get(&v, "baselineQuote").as_str().is_some_and(|q| {
					is_passage_of_prepared(q, t)
						&& extract_number_tokens(q)
							.iter()
							.any(|token| token.parse::<f64>().ok() == Some(baseline))
				})
			})
		});
		if !stated {
			if baseline.is_some() {
				notes.push(format!(
					"Scenario {}: no cited passage states the baseline, so no growth rate is derived.",
					i + 1
				));
			}
			for key in ["baselineValue", "baselineEvidenceId", "baselineQuote"] {
				set(&mut v, key, Value::Null);
			}
		}
		let case = |key: &str| ScenarioCase {
			target_value: num(get(get(&v, key), "targetValue")).unwrap_or_default(),
			assumptions: strings(get(get(&v, key), "assumptions")),
		};
		let input = DemandScenarioInput {
			product_or_service: field(&v, "productOrService").to_owned(),
			quantity_kind: validate(get(&v, "quantityKind"))?,
			unit: field(&v, "unit").to_owned(),
			base_year: num(get(&v, "baseYear")).unwrap_or_default(),
			target_year: num(get(&v, "targetYear")).unwrap_or_default(),
			baseline_value: num(get(&v, "baselineValue")),
			bear: case("bear"),
			base: case("base"),
			bull: case("bull"),
			drivers: strings(get(&v, "drivers")),
			barriers: strings(get(&v, "barriers")),
			falsifiers: strings(get(&v, "falsifiers")),
			methodology: field(&v, "methodology").to_owned(),
		};
		let derived = match derive_scenario_cagr(&input) {
			Ok(v) => v,
			Err(errors) => {
				notes.push(format!(
					"Scenario {} was dropped: {}.",
					i + 1,
					errors
						.iter()
						.map(|e| e.as_str())
						.collect::<Vec<_>>()
						.join(", ")
				));
				continue;
			}
		};
		let id = ids_.next_id("sc");
		by_draft.insert(i.to_string(), id.clone());
		set(&mut v, "scenarioId", s(id));
		set(
			&mut v,
			"derivedCagr",
			o([
				("bear", derived.bear.map(n).unwrap_or_default()),
				("base", derived.base.map(n).unwrap_or_default()),
				("bull", derived.bull.map(n).unwrap_or_default()),
			]),
		);
		if !retain.contains(field(&v, "baselineEvidenceId")) {
			set(&mut v, "baselineQuote", Value::Null);
		}
		for key in ["supportingEvidenceIds", "contraryEvidenceIds"] {
			let filtered = known(get(&v, key));
			set(&mut v, key, filtered);
		}
		scenarios.push(v);
	}
	let mut supplier_links = Vec::new();
	let same_listing = |security: &Value, v: &Value| {
		field(security, "ticker").to_uppercase() == field(v, "ticker").to_uppercase()
			&& field(security, "exchange").to_lowercase() == field(v, "exchange").to_lowercase()
	};
	for (i, raw) in items(analysis, "suppliers").iter().enumerate() {
		let Ok(v) = parse_draft("supplier", raw) else {
			notes.push(format!("Supplier {} was dropped: malformed.", i + 1));
			continue;
		};
		let name = field(&v, "issuerName");
		let relationship = items(&v, "evidence")
			.iter()
			.filter(|link| {
				index.get(field(link, "evidenceId")).is_some_and(|text| {
					is_passage_of_prepared(field(link, "quote"), text)
						&& (mentions_prepared(text, name)
							|| mentions_prepared(text, field(&v, "ticker")))
				})
			})
			.collect::<Vec<_>>();
		if relationship.is_empty() {
			notes.push(format!(
				"Supplier {name} was dropped: no retrieved passage names it and establishes the relationship."
			));
			continue;
		}
		let evidence_ids = unique(
			relationship
				.iter()
				.map(|link| field(link, "evidenceId").to_owned()),
		);
		let numbers = number_set(&evidence_ids, index);
		let description = std::iter::once(field(&v, "businessExposure").to_owned())
			.chain(strings(get(&v, "productsOrServices")))
			.collect::<Vec<_>>()
			.join(" ");
		let stray = extract_number_tokens(&description)
			.into_iter()
			.filter(|token| !numbers.contains(token))
			.take(3)
			.collect::<Vec<_>>();
		if !stray.is_empty() {
			notes.push(format!("Supplier {name} was dropped: its description states figures ({}) the cited evidence does not contain.",stray.join(", ")));
			continue;
		}
		if !markets.iter().any(|m| m.as_str() == field(&v, "country")) {
			notes.push(format!(
				"Supplier {name} was dropped: outside the requested markets."
			));
			continue;
		}
		let security_id = if let Some(sec) = securities.iter().find(|sec| same_listing(sec, &v)) {
			field(sec, "securityId").to_owned()
		} else {
			let candidate = o([
				("securityId", s(ids_.next_id("sec"))),
				("country", get(&v, "country").clone()),
				("ticker", get(&v, "ticker").clone()),
				("exchange", get(&v, "exchange").clone()),
				("issuerName", s(name)),
				("issuerIdentifier", Value::Null),
				(
					"listingCurrency",
					s(if field(&v, "country") == "JP" {
						"JPY"
					} else {
						"USD"
					}),
				),
				("reportingCurrency", Value::Null),
				("formerTickers", a([])),
				("listingVerification", s("unverified")),
			]);
			let Ok(parsed) = validate::<Security>(&candidate) else {
				notes.push(format!(
					"Supplier {name} was dropped: ticker/exchange not recognised."
				));
				continue;
			};
			let id = parsed.security_id.clone();
			securities.push(json(&parsed)?);
			id
		};
		let scenario = get(&v, "scenarioIndex")
			.as_f64()
			.and_then(|n| by_draft.get(&to_js_string(n)))
			.map(s)
			.unwrap_or_default();
		let quote = relationship
			.iter()
			.find(|link| retain.contains(field(link, "evidenceId")))
			.map(|link| get(link, "quote").clone())
			.unwrap_or_default();
		supplier_links.push(o([
			("supplierLinkId", s(ids_.next_id("sup"))),
			("scenarioId", scenario),
			("securityId", s(security_id)),
			("productsOrServices", get(&v, "productsOrServices").clone()),
			("businessExposure", get(&v, "businessExposure").clone()),
			("evidenceIds", a(evidence_ids.into_iter().map(s))),
			("relationshipQuote", quote),
		]));
	}
	let mut pricing_power = Vec::new();
	for (i, raw) in items(analysis, "pricingPower").iter().enumerate() {
		let i = i + 1;
		let Ok(v) = parse_draft("pricingPower", raw) else {
			notes.push(format!("Pricing-power entry {i} was dropped: malformed."));
			continue;
		};
		let security = securities.iter().find(|sec| same_listing(sec, &v));
		let evidence = known(get(&v, "evidenceIds"));
		let Some(security) = security.filter(|_| !list(&evidence).is_empty()) else {
			notes.push(format!(
				"Pricing-power entry {i} was dropped: unknown security or no evidence."
			));
			continue;
		};
		let numbers = number_set(&strings(&evidence), index);
		let mut undisclosed = 0;
		let mut inputs = research_js::json::Object::new();
		for key in PRICE_FIELDS {
			let value = match num(get(&v, key)) {
				Some(n_) if !numbers.contains(&to_js_string(n_.abs())) => {
					undisclosed += 1;
					Value::Null
				}
				_ => get(&v, key).clone(),
			};
			inputs.insert(key, value);
		}
		inputs.insert(
			"managementCommentaryEvidenceIds",
			known(get(&v, "managementCommentaryEvidenceIds")),
		);
		let inputs = Value::Object(inputs);
		if undisclosed > 0 {
			notes.push(format!("Pricing-power entry {i}: {undisclosed} figure(s) not found in the cited evidence were treated as undisclosed."));
		}
		let assessment = assess_pricing_power(&PricingPowerInputs {
			revenue_growth_pct: num(get(&inputs, "revenueGrowthPct")),
			price_realization_pct: num(get(&inputs, "priceRealizationPct")),
			volume_growth_pct: num(get(&inputs, "volumeGrowthPct")),
			mix_effect_pct: num(get(&inputs, "mixEffectPct")),
			fx_effect_pct: num(get(&inputs, "fxEffectPct")),
			input_cost_change_pct: num(get(&inputs, "inputCostChangePct")),
			gross_margin_change_bps: num(get(&inputs, "grossMarginChangeBps")),
			operating_margin_change_bps: num(get(&inputs, "operatingMarginChangeBps")),
			management_commentary_evidence_ids: strings(get(
				&inputs,
				"managementCommentaryEvidenceIds",
			)),
		});
		let record = o([
			("pricingPowerId", s(ids_.next_id("pp"))),
			("securityId", get(security, "securityId").clone()),
			(
				"period",
				o([
					("fiscalYear", get(&v, "fiscalYear").clone()),
					("fiscalPeriod", get(&v, "fiscalPeriod").clone()),
					("periodStart", get(&v, "periodStart").clone()),
					("periodEnd", get(&v, "periodEnd").clone()),
				]),
			),
			("inputs", inputs),
			("assessment", json(&assessment)?),
			("evidenceIds", evidence),
		]);
		match validate::<PricingPowerRecord>(&record) {
			Ok(record) => pricing_power.push(json(&record)?),
			Err(_) => notes.push(format!(
				"Pricing-power entry {i} was dropped: invalid period."
			)),
		}
	}
	let comparison_tables =
		build_comparison_tables(analysis, claims, shown, claim_evidence_id, index, notes);
	Ok(Records {
		scenarios,
		securities,
		supplier_links,
		pricing_power,
		comparison_tables,
	})
}

const MAX_COMPARISON_ROWS: usize = 30;

fn is_empty_placeholder(trimmed: &str) -> bool {
	matches!(trimmed, "" | "—" | "-" | "N/A" | "n/a")
}

fn parse_comparison_number_string(raw: &str) -> Option<f64> {
	let trimmed = whitespace::trim(raw);
	let body = trimmed.strip_suffix('%').unwrap_or(trimmed);
	if body.is_empty() {
		return None;
	}
	let unsigned = body.strip_prefix('-').unwrap_or(body);
	if unsigned.is_empty() {
		return None;
	}
	let (int_part, frac_part) = match unsigned.split_once('.') {
		Some((i, f)) => (i, Some(f)),
		None => (unsigned, None),
	};
	let mut int_bytes = int_part.bytes();
	if !int_bytes.next().is_some_and(|b| b.is_ascii_digit())
		|| !int_bytes.all(|b| b.is_ascii_digit() || b == b',')
	{
		return None;
	}
	if let Some(frac) = frac_part
		&& (frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()))
	{
		return None;
	}
	let clean = body.replace(',', "");
	let parsed = clean.parse::<f64>().ok().filter(|v| v.is_finite())?;
	Some(if parsed == 0.0 { 0.0 } else { parsed })
}

fn as_of_for_evidence(evidence: &Evidence) -> &str {
	evidence
		.effective_at
		.as_deref()
		.or(evidence.published_at.as_deref())
		.unwrap_or(&evidence.retrieved_at)
}

struct EvaluatedComparisonRow {
	candidate: ComparisonRowCandidate,
	cells: Value,
	evidence_ids: Vec<String>,
}

fn build_comparison_tables(
	analysis: &Value,
	claims: &[Value],
	shown: &[CollectedEvidence],
	claim_evidence_id: &dyn Fn(&str) -> String,
	index: &EvidenceIndex,
	notes: &mut Vec<String>,
) -> Vec<Value> {
	let shown_by_id: HashMap<&str, &Evidence> = shown
		.iter()
		.map(|item| (item.evidence.evidence_id.as_str(), &item.evidence))
		.collect();
	let claims_by_index: HashMap<String, &Value> = claims
		.iter()
		.enumerate()
		.map(|(i, c)| (i.to_string(), c))
		.collect();
	let mut token_cache: HashMap<String, HashSet<String>> = HashMap::new();
	let mut tokens_of_evidence = |evidence_id: &str| -> HashSet<String> {
		if let Some(cached) = token_cache.get(evidence_id) {
			return cached.clone();
		}
		let computed: HashSet<String> = index
			.get(evidence_id)
			.map(|text| {
				extract_number_tokens(text.normalized())
					.into_iter()
					.collect()
			})
			.unwrap_or_default();
		token_cache.insert(evidence_id.to_owned(), computed.clone());
		computed
	};

	let mut result = Vec::new();
	for (table_index, raw) in items(analysis, "comparisonTables").iter().enumerate() {
		let Ok(draft) = parse_draft("comparisonTable", raw) else {
			notes.push(format!(
				"Comparison table {} was dropped: malformed.",
				table_index + 1
			));
			continue;
		};
		let draft_cols = items(&draft, "columns");
		let draft_rows = items(&draft, "rows");
		if draft_cols.len() < 2
			|| draft_rows.is_empty()
			|| draft_cols.iter().any(|col| {
				field(col, "kind") == "number"
					&& get(col, "unit").as_str().is_none_or(str::is_empty)
			}) {
			notes.push(format!(
				"Comparison table {} was dropped: malformed.",
				table_index + 1
			));
			continue;
		}

		let mut columns = Vec::with_capacity(draft_cols.len());
		let mut first_text_col_index = None;
		for (col_index, col) in draft_cols.iter().enumerate() {
			let key = format!("col{col_index}");
			let is_number = field(col, "kind") == "number" && get(col, "unit").as_str().is_some();
			if !is_number && first_text_col_index.is_none() {
				first_text_col_index = Some(col_index);
			}
			let mut built = o([
				("key", s(key)),
				("label", get(col, "label").clone()),
				("kind", s(if is_number { "number" } else { "text" })),
			]);
			if is_number && let Some(unit) = get(col, "unit").as_str() {
				set(&mut built, "unit", s(unit));
			}
			columns.push(built);
		}

		let mut evaluated_rows = Vec::with_capacity(draft_rows.len());
		for draft_row in draft_rows {
			let mut seen_claim_indices = HashSet::new();
			let mut supported_claims = Vec::new();
			let mut raw_evidence_ids = Vec::new();

			for idx_val in items(draft_row, "claimIndices") {
				let Some(raw_idx) = num(idx_val) else {
					continue;
				};
				let idx_key = to_js_string(raw_idx);
				if !seen_claim_indices.insert(idx_key.clone()) {
					continue;
				}
				let Some(claim) = claims_by_index.get(&idx_key).copied() else {
					continue;
				};
				if field(claim, "status") != "supported" {
					continue;
				}
				supported_claims.push(claim);
				for link in items(claim, "links") {
					let ev_id = field(link, "evidenceId");
					if field(link, "relation") == "supports" && shown_by_id.contains_key(ev_id) {
						raw_evidence_ids.push(ev_id.to_owned());
					}
				}
			}

			for link in items(draft_row, "evidence") {
				let resolved_id = claim_evidence_id(field(link, "evidenceId"));
				if shown_by_id.contains_key(resolved_id.as_str())
					&& let Some(quote) = get(link, "quote").as_str().filter(|q| !q.is_empty())
					&& index
						.get(&resolved_id)
						.is_some_and(|prepared| is_passage_of_prepared(quote, prepared))
				{
					raw_evidence_ids.push(resolved_id);
				}
			}

			let mut row_evidence_ids = unique(raw_evidence_ids);
			row_evidence_ids.truncate(12);
			let has_verified_support = !row_evidence_ids.is_empty();
			let mut allowed_numbers = HashSet::new();
			for ev_id in &row_evidence_ids {
				allowed_numbers.extend(tokens_of_evidence(ev_id));
			}
			for claim in &supported_claims {
				allowed_numbers.extend(extract_number_tokens(field(claim, "text")));
			}

			let mut has_stray_number = false;
			let mut row_cells = Object::new();
			let primary_id = row_evidence_ids.first().map(String::as_str);
			let primary_evidence = primary_id.and_then(|id| shown_by_id.get(id).copied());
			let draft_values = items(draft_row, "values");

			for (col_index, column) in columns.iter().enumerate() {
				let col_key = field(column, "key").to_owned();
				let raw_val = draft_values.get(col_index).unwrap_or(&NULL);
				if field(column, "kind") == "text" {
					let cell = match raw_val {
						Value::Null => o([("v", Value::Null), ("reason", s("not reported"))]),
						Value::String(raw_str) => {
							let trimmed = whitespace::trim(raw_str);
							if is_empty_placeholder(trimmed) {
								o([("v", Value::Null), ("reason", s("not reported"))])
							} else {
								let text_val = utf16::truncate(trimmed, 600).into_owned();
								if extract_number_tokens(&text_val)
									.iter()
									.any(|token| !allowed_numbers.contains(token))
								{
									has_stray_number = true;
								}
								if Some(col_index) == first_text_col_index
									&& let Some(pid) = primary_id
								{
									o([("v", s(text_val)), ("sourceId", s(pid))])
								} else {
									o([("v", s(text_val))])
								}
							}
						}
						Value::Number(raw_num) if raw_num.is_finite() => {
							let normalized_num = if *raw_num == 0.0 { 0.0 } else { *raw_num };
							let text_val = to_js_string(normalized_num);
							if extract_number_tokens(&text_val)
								.iter()
								.any(|token| !allowed_numbers.contains(token))
							{
								has_stray_number = true;
							}
							if Some(col_index) == first_text_col_index
								&& let Some(pid) = primary_id
							{
								o([("v", s(text_val)), ("sourceId", s(pid))])
							} else {
								o([("v", s(text_val))])
							}
						}
						_ => {
							has_stray_number = true;
							o([("v", Value::Null), ("reason", s("not reported"))])
						}
					};
					row_cells.insert(col_key, cell);
					continue;
				}

				// column.kind == "number"
				let cell = match raw_val {
					Value::Null => o([("v", Value::Null), ("reason", s("unavailable"))]),
					Value::String(raw_str) if is_empty_placeholder(whitespace::trim(raw_str)) => {
						o([("v", Value::Null), ("reason", s("unavailable"))])
					}
					_ => {
						let num_val = match raw_val {
							Value::Number(raw_num) if raw_num.is_finite() => {
								Some(if *raw_num == 0.0 { 0.0 } else { *raw_num })
							}
							Value::String(raw_str) => parse_comparison_number_string(raw_str),
							_ => None,
						};
						match num_val {
							None => {
								has_stray_number = true;
								o([("v", Value::Null), ("reason", s("unavailable"))])
							}
							Some(num_val) => {
								let tokens = extract_number_tokens(&to_js_string(num_val.abs()));
								if tokens.is_empty()
									|| tokens.iter().any(|token| !allowed_numbers.contains(token))
								{
									has_stray_number = true;
									o([("v", Value::Null), ("reason", s("unavailable"))])
								} else if let (Some(pid), Some(pev)) =
									(primary_id, primary_evidence)
								{
									let direct_id = row_evidence_ids.iter().find(|ev_id| {
										let ev_tokens = tokens_of_evidence(ev_id);
										tokens.iter().all(|token| ev_tokens.contains(token))
									});
									if let Some(did) = direct_id
										&& let Some(dev) = shown_by_id.get(did.as_str()).copied()
									{
										o([
											("v", n(num_val)),
											("sourceId", s(did)),
											("asOf", s(as_of_for_evidence(dev))),
										])
									} else {
										o([
											("v", n(num_val)),
											("sourceId", s(pid)),
											("asOf", s(as_of_for_evidence(pev))),
											("basis", s("derived")),
										])
									}
								} else {
									o([("v", Value::Null), ("reason", s("unavailable"))])
								}
							}
						}
					}
				};
				row_cells.insert(col_key, cell);
			}

			evaluated_rows.push(EvaluatedComparisonRow {
				candidate: ComparisonRowCandidate {
					has_verified_support,
					has_stray_number,
				},
				cells: Value::Object(row_cells),
				evidence_ids: row_evidence_ids,
			});
		}

		let candidates = evaluated_rows
			.iter()
			.map(|row| row.candidate)
			.collect::<Vec<_>>();
		let kept_indices = select_verified_comparison_row_indices(&candidates, MAX_COMPARISON_ROWS);
		if kept_indices.is_empty() {
			notes.push(format!(
				"Comparison table {} was dropped: no rows had verified backing.",
				table_index + 1
			));
			continue;
		}
		if kept_indices.len() < evaluated_rows.len() {
			notes.push(format!(
				"Comparison table {}: {} row(s) without verified backing were omitted.",
				table_index + 1,
				evaluated_rows.len() - kept_indices.len()
			));
		}
		let kept_rows = kept_indices
			.iter()
			.filter_map(|&idx| evaluated_rows.get(idx))
			.collect::<Vec<_>>();
		let mut source_ids = unique(
			kept_rows
				.iter()
				.flat_map(|row| row.evidence_ids.iter().cloned()),
		);
		source_ids.truncate(40);
		let caption = match get(&draft, "caption").as_str() {
			Some(c) if !c.is_empty() => s(c),
			_ => Value::Null,
		};
		result.push(o([
			("title", get(&draft, "title").clone()),
			("caption", caption),
			("columns", a(columns)),
			("rows", a(kept_rows.iter().map(|row| row.cells.clone()))),
			("sourceIds", a(source_ids.into_iter().map(s))),
		]));
	}

	result
}

fn number_set(ids: &[String], index: &EvidenceIndex) -> HashSet<String> {
	ids.iter()
		.filter_map(|id| index.get(id))
		.flat_map(|text| extract_number_tokens(text.normalized()))
		.collect()
}
