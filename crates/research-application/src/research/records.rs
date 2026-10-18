//! Sequential enrichment of model drafts: ids and notes are order-sensitive.
use std::collections::{HashMap,HashSet};
use research_agent_core::tools::IdAllocator;
use research_contracts::{records::{Security,PricingPowerRecord},validate};
use research_domain::{evidence::verify_claims::{EvidenceIndex,is_passage_of_prepared,mentions_prepared,extract_number_tokens},finance::{demand_scenario::{DemandScenarioInput,ScenarioCase,derive_scenario_cagr},pricing_power::{PricingPowerInputs,assess_pricing_power}}};
use research_js::{json::Value,number::to_js_string};
use super::{value::*,draft::{parse_draft,PRICE_FIELDS},PipelineError};

pub(super) struct Records {
	pub scenarios:Vec<Value>,pub securities:Vec<Value>,pub supplier_links:Vec<Value>,pub pricing_power:Vec<Value>,
}

pub(super) fn build_records(analysis:&Value, mut securities:Vec<Value>, index:&EvidenceIndex, retain:&HashSet<String>, markets:&[research_domain::finance::types::Market], ids_:&dyn IdAllocator, notes:&mut Vec<String>)->Result<Records,PipelineError>{
	let known=|value:&Value|a(unique(strings(value).into_iter().filter(|id|index.get(id).is_some())).into_iter().map(s));
	let mut scenarios=Vec::new();let mut by_draft=HashMap::new();
	for (i,raw) in items(analysis,"scenarios").iter().enumerate(){
		let Ok(mut v)=parse_draft("scenario",raw) else{notes.push(format!("Scenario {} was dropped: malformed.",i+1));continue;};
		let baseline=num(get(&v,"baselineValue"));
		let stated=baseline.is_some_and(|baseline|index.get(field(&v,"baselineEvidenceId")).is_some_and(|t|get(&v,"baselineQuote").as_str().is_some_and(|q|is_passage_of_prepared(q,t)&&extract_number_tokens(q).iter().any(|token|token.parse::<f64>().ok()==Some(baseline)))));
		if !stated {if baseline.is_some(){notes.push(format!("Scenario {}: no cited passage states the baseline, so no growth rate is derived.",i+1));}for key in ["baselineValue","baselineEvidenceId","baselineQuote"]{set(&mut v,key,Value::Null);}}
		let case=|key:&str|ScenarioCase{target_value:num(get(get(&v,key),"targetValue")).unwrap_or_default(),assumptions:strings(get(get(&v,key),"assumptions"))};
		let input=DemandScenarioInput{product_or_service:field(&v,"productOrService").to_owned(),quantity_kind:validate(get(&v,"quantityKind"))?,unit:field(&v,"unit").to_owned(),base_year:num(get(&v,"baseYear")).unwrap_or_default(),target_year:num(get(&v,"targetYear")).unwrap_or_default(),baseline_value:num(get(&v,"baselineValue")),bear:case("bear"),base:case("base"),bull:case("bull"),drivers:strings(get(&v,"drivers")),barriers:strings(get(&v,"barriers")),falsifiers:strings(get(&v,"falsifiers")),methodology:field(&v,"methodology").to_owned()};
		let derived=match derive_scenario_cagr(&input){Ok(v)=>v,Err(errors)=>{notes.push(format!("Scenario {} was dropped: {}.",i+1,errors.iter().map(|e|e.as_str()).collect::<Vec<_>>().join(", ")));continue;}};
		let id=ids_.next_id("sc");by_draft.insert(i.to_string(),id.clone());set(&mut v,"scenarioId",s(id));
		set(&mut v,"derivedCagr",o([("bear",derived.bear.map(n).unwrap_or_default()),("base",derived.base.map(n).unwrap_or_default()),("bull",derived.bull.map(n).unwrap_or_default())]));
		if !retain.contains(field(&v,"baselineEvidenceId")){set(&mut v,"baselineQuote",Value::Null);}
		for key in ["supportingEvidenceIds","contraryEvidenceIds"]{let filtered=known(get(&v,key));set(&mut v,key,filtered);}
		scenarios.push(v);
	}
	let mut supplier_links=Vec::new();
	let same_listing=|security:&Value,v:&Value|field(security,"ticker").to_uppercase()==field(v,"ticker").to_uppercase()&&field(security,"exchange").to_lowercase()==field(v,"exchange").to_lowercase();
	for (i,raw) in items(analysis,"suppliers").iter().enumerate(){
		let Ok(v)=parse_draft("supplier",raw)else{notes.push(format!("Supplier {} was dropped: malformed.",i+1));continue;};
		let name=field(&v,"issuerName");
		let relationship=items(&v,"evidence").iter().filter(|link|index.get(field(link,"evidenceId")).is_some_and(|text|is_passage_of_prepared(field(link,"quote"),text)&&(mentions_prepared(text,name)||mentions_prepared(text,field(&v,"ticker"))))).collect::<Vec<_>>();
		if relationship.is_empty(){notes.push(format!("Supplier {name} was dropped: no retrieved passage names it and establishes the relationship."));continue;}
		let evidence_ids=unique(relationship.iter().map(|link|field(link,"evidenceId").to_owned()));
		let numbers=number_set(&evidence_ids,index);
		let description=std::iter::once(field(&v,"businessExposure").to_owned()).chain(strings(get(&v,"productsOrServices"))).collect::<Vec<_>>().join(" ");
		let stray=extract_number_tokens(&description).into_iter().filter(|token|!numbers.contains(token)).take(3).collect::<Vec<_>>();
		if !stray.is_empty(){notes.push(format!("Supplier {name} was dropped: its description states figures ({}) the cited evidence does not contain.",stray.join(", ")));continue;}
		if !markets.iter().any(|m|m.as_str()==field(&v,"country")){notes.push(format!("Supplier {name} was dropped: outside the requested markets."));continue;}
		let security_id=if let Some(sec)=securities.iter().find(|sec|same_listing(sec,&v)){field(sec,"securityId").to_owned()}else{
			let candidate=o([("securityId",s(ids_.next_id("sec"))),("country",get(&v,"country").clone()),("ticker",get(&v,"ticker").clone()),("exchange",get(&v,"exchange").clone()),("issuerName",s(name)),("issuerIdentifier",Value::Null),("listingCurrency",s(if field(&v,"country")=="JP"{"JPY"}else{"USD"})),("reportingCurrency",Value::Null),("formerTickers",a([])),("listingVerification",s("unverified"))]);
			let Ok(parsed)=validate::<Security>(&candidate)else{notes.push(format!("Supplier {name} was dropped: ticker/exchange not recognised."));continue;};
			let id=parsed.security_id.clone();securities.push(json(&parsed)?);id
		};
		let scenario=get(&v,"scenarioIndex").as_f64().and_then(|n|by_draft.get(&to_js_string(n))).map(s).unwrap_or_default();
		let quote=relationship.iter().find(|link|retain.contains(field(link,"evidenceId"))).map(|link|get(link,"quote").clone()).unwrap_or_default();
		supplier_links.push(o([("supplierLinkId",s(ids_.next_id("sup"))),("scenarioId",scenario),("securityId",s(security_id)),("productsOrServices",get(&v,"productsOrServices").clone()),("businessExposure",get(&v,"businessExposure").clone()),("evidenceIds",a(evidence_ids.into_iter().map(s))),("relationshipQuote",quote)]));
	}
	let mut pricing_power=Vec::new();
	for (i,raw) in items(analysis,"pricingPower").iter().enumerate(){
		let i=i+1;let Ok(v)=parse_draft("pricingPower",raw)else{notes.push(format!("Pricing-power entry {i} was dropped: malformed."));continue;};
		let security=securities.iter().find(|sec|same_listing(sec,&v));let evidence=known(get(&v,"evidenceIds"));
		let Some(security)=security.filter(|_|!list(&evidence).is_empty())else{notes.push(format!("Pricing-power entry {i} was dropped: unknown security or no evidence."));continue;};
		let numbers=number_set(&strings(&evidence),index);let mut undisclosed=0;
		let mut inputs=research_js::json::Object::new();
		for key in PRICE_FIELDS{let value=match num(get(&v,key)){Some(n_) if !numbers.contains(&to_js_string(n_.abs()))=>{undisclosed+=1;Value::Null},_=>get(&v,key).clone()};inputs.insert(key,value);}
		inputs.insert("managementCommentaryEvidenceIds",known(get(&v,"managementCommentaryEvidenceIds")));let inputs=Value::Object(inputs);
		if undisclosed>0{notes.push(format!("Pricing-power entry {i}: {undisclosed} figure(s) not found in the cited evidence were treated as undisclosed."));}
		let assessment=assess_pricing_power(&PricingPowerInputs{revenue_growth_pct:num(get(&inputs,"revenueGrowthPct")),price_realization_pct:num(get(&inputs,"priceRealizationPct")),volume_growth_pct:num(get(&inputs,"volumeGrowthPct")),mix_effect_pct:num(get(&inputs,"mixEffectPct")),fx_effect_pct:num(get(&inputs,"fxEffectPct")),input_cost_change_pct:num(get(&inputs,"inputCostChangePct")),gross_margin_change_bps:num(get(&inputs,"grossMarginChangeBps")),operating_margin_change_bps:num(get(&inputs,"operatingMarginChangeBps")),management_commentary_evidence_ids:strings(get(&inputs,"managementCommentaryEvidenceIds"))});
		let record=o([("pricingPowerId",s(ids_.next_id("pp"))),("securityId",get(security,"securityId").clone()),("period",o([("fiscalYear",get(&v,"fiscalYear").clone()),("fiscalPeriod",get(&v,"fiscalPeriod").clone()),("periodStart",get(&v,"periodStart").clone()),("periodEnd",get(&v,"periodEnd").clone())])),("inputs",inputs),("assessment",json(&assessment)?),("evidenceIds",evidence)]);
		match validate::<PricingPowerRecord>(&record){Ok(record)=>pricing_power.push(json(&record)?),Err(_)=>notes.push(format!("Pricing-power entry {i} was dropped: invalid period."))}
	}
	Ok(Records{scenarios,securities,supplier_links,pricing_power})
}

fn number_set(ids:&[String],index:&EvidenceIndex)->HashSet<String>{ids.iter().filter_map(|id|index.get(id)).flat_map(|text|extract_number_tokens(text.normalized())).collect()}
