//! Deterministic presentation over verified records (AGT-009, DATA-006).
use research_js::{json::Value, utf16, number::to_js_string};
use super::value::*;

/// Research disclaimer, shared by the answer and report.
pub const DISCLAIMER:&str="Research support only — not investment advice. Scenarios are conditional on their stated assumptions, not predictions, and every figure is as of its stated date.";

/// Dataset bindings advertised to the model.
pub fn dataset_guide(run_id:&str)->String{format!("- {run_id}_ds_scenarios: product, quantity, unit, baseYear, targetYear, baseline, bear, base, bull (one row per scenario)\n- {run_id}_ds_growth: scenario, bear, base, bull (derived CAGR in % per year; only scenarios with a sourced baseline)\n- {run_id}_ds_suppliers: company, ticker, exchange, country, products, exposure\n- {run_id}_ds_financials: security, metric, value, valueUnit, period, basis\n- {run_id}_ds_positions_jp / {run_id}_ds_positions_us: jurisdiction-specific position statistics\nA dataset exists only if the run produced rows for it.")}
fn text(value:impl Into<String>)->Value{o([("v",s(value))])}
fn unavailable(reason:&str)->Value{o([("v",Value::Null),("reason",s(reason))])}
fn column(key:&str,label:&str,unit:Option<&str>)->Value{let mut v=o([("key",s(key)),("label",s(label)),("kind",s(if unit.is_some(){"number"}else{"text"}))]);if let Some(unit)=unit{set(&mut v,"unit",s(unit));}v}
fn create(operations:&mut Vec<Value>,run:&str,suffix:&str,kind:&str,props:Value){operations.push(o([("operation",s("component.create")),("componentId",s(format!("{run}_{suffix}"))),("componentType",s(kind)),("schemaVersion",n(1.0)),("props",props)]));}
fn dataset(run:&str,suffix:&str,title:&str,columns:Vec<Value>,rows:Vec<Value>,now:&str)->Value{o([("datasetId",s(format!("{run}_ds_{suffix}"))),("title",s(title)),("columns",a(columns)),("rows",a(rows)),("createdAt",s(now))])}
fn source_ids(records:&[Value],key:&str)->Value{ids(records.iter().flat_map(|v|strings(get(v,key))))}
fn security<'a>(records:&'a [Value],id:&str)->Option<&'a Value>{records.iter().rev().find(|v|field(v,"securityId")==id)}
fn security_name(records:&[Value],id:&str)->String{security(records,id).map(|v|format!("{} ({}: {})",field(v,"issuerName"),field(v,"exchange"),field(v,"ticker"))).unwrap_or_else(||id.to_owned())}
fn percent(value:&Value)->Value{match num(value){None=>unavailable("not derivable: no sourced baseline"),Some(v)=>o([("v",n({let x=v*10000.0;let floor=x.floor();if x-floor>=0.5{floor+1.0}else{floor}}/100.0)),("basis",s("derived"))])}}
fn fallback<'a>(v:&'a Value,other:&'a str)->&'a str{v.as_str().unwrap_or(other)}

/// Builds report, source list, datasets and views from schema-validated records.
/// The returned JSON is decoded by ResearchBundle before it leaves the pipeline.
pub fn build_presentation(input:&Value)->Value{
	let run=field(input,"runId");let now=field(input,"nowIso");
	let claims=items(input,"claims");let scenarios=items(input,"scenarios");let securities=items(input,"securities");let suppliers=items(input,"supplierLinks");let evidence=items(input,"evidence");
	let mut datasets=Vec::new();let mut operations=Vec::new();
	let mut sections=Vec::new();
	for (status,heading) in [("supported","Supported findings"),("conflicting","Findings with conflicting evidence"),("unsupported","Unsupported statements (not verified)")]{
		let statements=claims.iter().filter(|v|field(v,"status")==status).map(|v|o([("text",get(v,"text").clone()),("claimId",get(v,"claimId").clone()),("claimType",get(v,"claimType").clone()),("status",get(v,"status").clone()),("sourceIds",a(unique(items(v,"links").iter().map(|l|field(l,"evidenceId").to_owned())).into_iter().map(s)))])).collect::<Vec<_>>();
		if !statements.is_empty(){sections.push(o([("heading",s(heading)),("statements",a(statements))]));}
	}
	if sections.is_empty(){sections.push(o([("heading",s("No findings")),("statements",a([o([("text",s("No claim could be established from the retrieved evidence.")),("claimId",Value::Null),("claimType",Value::Null),("status",Value::Null),("sourceIds",a([]))])]))]));}
	create(&mut operations,run,"report","research-report",o([("title",s(utf16::truncate(field(input,"question"),300).into_owned())),("generatedAt",s(now)),("dataCutoffAt",get(input,"dataCutoffAt").clone()),("sections",a(sections)),("disclaimer",s(DISCLAIMER))]));
	let cited=ids(evidence.iter().map(|e|field(e,"evidenceId").to_owned()));
	if !list(&cited).is_empty(){create(&mut operations,run,"sources","source-list",o([("title",s("Sources")),("sourceIds",cited)]));}
	let scenario_sources=|values:&[Value]|ids(values.iter().flat_map(|v|strings(get(v,"supportingEvidenceIds")).into_iter().chain(strings(get(v,"contraryEvidenceIds")))));
	if !scenarios.is_empty(){
		let columns=vec![column("product","Product / service",None),column("quantity","Measured quantity",None),column("unit","Unit",None),column("baseYear","Base year",None),column("targetYear","Target year",None),column("baseline","Baseline",Some("see Unit column")),column("bear","Bear target",Some("see Unit column")),column("base","Base target",Some("see Unit column")),column("bull","Bull target",Some("see Unit column"))];
		let rows=scenarios.iter().map(|v|{
			let source=evidence.iter().rev().find(|e|field(e,"evidenceId")==field(v,"baselineEvidenceId"));
			let baseline=match (num(get(v,"baselineValue")),source){(Some(value),Some(source))=>o([("v",n(value)),("sourceId",get(source,"evidenceId").clone()),("asOf",["effectiveAt","publishedAt","retrievedAt"].iter().map(|k|get(source,k)).find(|v|!matches!(v,Value::Null)).cloned().unwrap_or_default())]),_=>unavailable("no sourced baseline")};
			o([("product",text(field(v,"productOrService"))),("quantity",text(field(v,"quantityKind"))),("unit",text(field(v,"unit"))),("baseYear",text(to_js_string(num(get(v,"baseYear")).unwrap_or_default()))),("targetYear",text(to_js_string(num(get(v,"targetYear")).unwrap_or_default()))),("baseline",baseline),("bear",o([("v",get(get(v,"bear"),"targetValue").clone()),("basis",s("assumption"))])),("base",o([("v",get(get(v,"base"),"targetValue").clone()),("basis",s("assumption"))])),("bull",o([("v",get(get(v,"bull"),"targetValue").clone()),("basis",s("assumption"))]))])
		}).collect();
		datasets.push(dataset(run,"scenarios","Demand scenarios",columns,rows,now));
		create(&mut operations,run,"scenarios","data-table",o([("title",s("Demand scenarios (bear / base / bull)")),("datasetRef",s(format!("{run}_ds_scenarios"))),("sourceIds",scenario_sources(scenarios)),("caption",s("Targets are scenario assumptions, not measurements. See the report for drivers and falsifiers."))]));
		let derivable=scenarios.iter().filter(|v|!matches!(get(get(v,"derivedCagr"),"base"),Value::Null)).cloned().collect::<Vec<_>>();
		if !derivable.is_empty(){
			let rows=derivable.iter().map(|v|o([("scenario",text(format!("{} ({}–{})",field(v,"productOrService"),to_js_string(num(get(v,"baseYear")).unwrap_or_default()),to_js_string(num(get(v,"targetYear")).unwrap_or_default())))),("bear",percent(get(get(v,"derivedCagr"),"bear"))),("base",percent(get(get(v,"derivedCagr"),"base"))),("bull",percent(get(get(v,"derivedCagr"),"bull")))])).collect();
			datasets.push(dataset(run,"growth","Derived scenario growth",vec![column("scenario","Scenario",None),column("bear","Bear",Some("% per year")),column("base","Base",Some("% per year")),column("bull","Bull",Some("% per year"))],rows,now));
			create(&mut operations,run,"growth","bar-chart",o([("title",s("Derived compound annual growth by scenario")),("datasetRef",s(format!("{run}_ds_growth"))),("categoryKey",s("scenario")),("series",a([o([("key",s("bear")),("label",s("Bear"))]),o([("key",s("base")),("label",s("Base"))]),o([("key",s("bull")),("label",s("Bull"))])])),("xLabel",s("Scenario")),("yLabel",s("Compound annual growth")),("yUnit",s("% per year")),("sourceIds",scenario_sources(&derivable))]));
		}
	}
	if !suppliers.is_empty(){
		let rows=suppliers.iter().map(|v|{let sec=security(securities,field(v,"securityId")).unwrap_or(&NULL);let source=items(v,"evidenceIds").first();let cited=|value:&str|{let mut c=text(value);if let Some(source)=source{set(&mut c,"sourceId",source.clone());}c};o([("company",cited(if matches!(sec,Value::Null){field(v,"securityId")}else{field(sec,"issuerName")})),("ticker",text(fallback(get(sec,"ticker"),"—"))),("exchange",text(fallback(get(sec,"exchange"),"—"))),("country",text(fallback(get(sec,"country"),"—"))),("listing",text(if field(sec,"listingVerification")=="source-verified"{"ticker and exchange from an official directory"}else{"not verified against an exchange listing"})),("products",text(utf16::truncate(&strings(get(v,"productsOrServices")).join("; "),600).into_owned())),("exposure",cited(&utf16::truncate(field(v,"businessExposure"),600)))])}).collect();
		datasets.push(dataset(run,"suppliers","Supplier mapping",vec![column("company","Company",None),column("ticker","Ticker",None),column("exchange","Exchange",None),column("country","Country",None),column("listing","Listing check",None),column("products","Relevant products / services",None),column("exposure","Business exposure",None)],rows,now));
		create(&mut operations,run,"suppliers","data-table",o([("title",s("Listed suppliers (Japan / United States)")),("datasetRef",s(format!("{run}_ds_suppliers"))),("sourceIds",source_ids(suppliers,"evidenceIds"))]));
		for (i,v) in suppliers.iter().filter(|v|security(securities,field(v,"securityId")).is_some_and(|sec|field(sec,"listingVerification")=="source-verified")).take(4).enumerate(){if let Some(sec)=security(securities,field(v,"securityId")){create(&mut operations,run,&format!("company{i}"),"company-profile",o([("companyName",get(sec,"issuerName").clone()),("ticker",get(sec,"ticker").clone()),("exchange",get(sec,"exchange").clone()),("country",get(sec,"country").clone()),("productsOrServices",get(v,"productsOrServices").clone()),("businessExposure",get(v,"businessExposure").clone()),("sourceIds",get(v,"evidenceIds").clone())]));}}
	}
	let financials=items(input,"financialObservations");
	if !financials.is_empty(){
		let rows=financials.iter().map(|v|{
			let period=get(v,"period");let mut value=if matches!(get(v,"value"),Value::Null)||matches!(get(v,"sourceEvidenceId"),Value::Null){unavailable(fallback(get(v,"unavailableReason"),"unavailable"))}else{o([("v",get(v,"value").clone()),("sourceId",get(v,"sourceEvidenceId").clone())])};
			if !matches!(get(&value,"v"),Value::Null){let date=if matches!(get(v,"marketDataAsOf"),Value::Null){get(period,"periodEnd")}else{get(v,"marketDataAsOf")};if !matches!(date,Value::Null){set(&mut value,"asOf",date.clone());}}
			let currency=fallback(get(v,"currency"),"currency");let unit=match field(v,"unit"){"ratio"=>"ratio".to_owned(),"currency"=>currency.to_owned(),_=>format!("{currency} per share")};
			let period=if matches!(period,Value::Null){"—".to_owned()}else{format!("FY{} {} ({} to {})",to_js_string(num(get(period,"fiscalYear")).unwrap_or_default()),field(period,"fiscalPeriod"),field(period,"periodStart"),field(period,"periodEnd"))};
			let basis=format!("{}, {}{}",fallback(get(v,"accountingStandard"),"basis n/a"),field(v,"actualOrEstimate"),get(v,"formula").as_str().map(|s|format!("; {s}")).unwrap_or_default());
			o([("security",text(security_name(securities,field(v,"securityId")))),("metric",text(field(v,"metricCode"))),("value",value),("valueUnit",text(unit)),("period",text(period)),("basis",text(basis))])
		}).collect();
		datasets.push(dataset(run,"financials","Financial metrics",vec![column("security","Security",None),column("metric","Metric",None),column("value","Value",Some("see Unit column")),column("valueUnit","Unit",None),column("period","Accounting period",None),column("basis","Basis",None)],rows,now));
		create(&mut operations,run,"financials","financial-table",o([("title",s("Financial metrics")),("datasetRef",s(format!("{run}_ds_financials"))),("sourceIds",ids(financials.iter().filter_map(|v|get(v,"sourceEvidenceId").as_str().map(str::to_owned)))),("methodologyNote",s("PER = share price / EPS for the stated basis and period; non-positive or missing EPS, or a missing licensed price, is reported as N/A. Net profit margin = net income / revenue for the same reporting period and accounting standard."))]));
	}
	for (metric,suffix) in [(research_domain::finance::positions::PositionMetric::JpMarginBalance,"positions_jp"),(research_domain::finance::positions::PositionMetric::UsShortInterest,"positions_us")]{
		let observations=items(input,"positionObservations").iter().filter(|v|field(v,"metric")==metric.as_str()).collect::<Vec<_>>();if observations.is_empty(){continue;}
		let labels=research_domain::finance::positions::position_labels(metric);let jp=suffix=="positions_jp";
		let mut columns=vec![column("security","Security",None)];
		if jp{columns.extend([column("marginBuy","Margin buy balance",Some("shares")),column("marginSell","Margin sell balance",Some("shares"))]);}else{columns.push(column("shortInterest","Reported short interest",Some("shares")));}columns.push(column("definition","Source definition",None));
		let rows=observations.iter().map(|v|{let mut row=o([("security",text(security_name(securities,field(v,"securityId")))),("definition",text(field(v,"metricDefinition")))]);let figures=get(v,"figures");for (key,figure) in if jp{vec![("marginBuy","marginBuyBalanceShares"),("marginSell","marginSellBalanceShares")]}else{vec![("shortInterest","reportedShortInterestShares")]}{let value=if field(figures,"metric")!=metric.as_str(){unavailable(fallback(get(v,"unavailableReason"),"unavailable"))}else{let mut value=o([("v",get(figures,figure).clone())]);if !matches!(get(v,"sourceEvidenceId"),Value::Null)&&!matches!(get(v,"asOfDate"),Value::Null){set(&mut value,"sourceId",get(v,"sourceEvidenceId").clone());set(&mut value,"asOf",get(v,"asOfDate").clone());}value};set(&mut row,key,value);}row}).collect();
		datasets.push(dataset(run,suffix,labels.heading,columns,rows,now));
		create(&mut operations,run,suffix,"data-table",o([("title",s(labels.heading)),("datasetRef",s(format!("{run}_ds_{suffix}"))),("sourceIds",a(unique(observations.iter().filter_map(|v|get(v,"sourceEvidenceId").as_str().map(str::to_owned))).into_iter().map(s))),("caption",s(labels.caveat))]));
	}
	o([("datasets",a(datasets)),("uiOperations",a(operations))])
}
