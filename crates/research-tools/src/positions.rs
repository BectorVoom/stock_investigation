//! Jurisdiction-specific position tools (FR-007, DATA-006), with explicit absence and provenance.
use std::sync::Arc;
use async_trait::async_trait;
use research_agent_core::tools::*;
use research_application::ports::Hasher;
use research_contracts::records::{PositionObservation,SourceClass,SharesUnit};
use research_domain::finance::{positions::{PositionFigures,PositionMetric,position_labels},types::Market};
use research_domain::text::truncate::truncate_text;
use research_finance::market_data::*;
use research_js::json::Value;
use crate::shared::{bound_model_text,collect_evidence,EvidenceInput};
/// Licensed sources and shared evidence hashing.
pub struct PositionToolDeps {
	/// US short interest, never substituted with Japanese margin sales.
	pub us_short_interest: Arc<dyn UsShortInterestSource>,
	/// Japanese margin purchase/sale balances.
	pub jp_margin_balance: Arc<dyn JpMarginBalanceSource>,
	/// Hashes the retrieved evidence text.
	pub hasher: Arc<dyn Hasher>,
}
/// Builds the two registered tools in catalogue order.
pub fn create_position_tools(deps: PositionToolDeps) -> Vec<Arc<dyn Tool>> {
	let deps = Arc::new(deps);
	[(PositionMetric::UsShortInterest,"positions.us_short_interest","US short interest for one security (shares sold short as of a settlement date). Not comparable to Japan's margin balances. Returns an explicit 'unavailable' when no source is configured.","{ \"ticker\": \"<US ticker>\", \"securityId\": \"<optional id of an existing Security>\" }"),
	(PositionMetric::JpMarginBalance,"positions.jp_margin_balance","Japan margin trading balances (信用取引残高: margin purchase and margin sale balances) for one securities code. Not comparable to US short interest. Returns an explicit 'unavailable' when no source is configured.","{ \"code\": \"<4-character Japanese securities code, e.g. 7203>\", \"securityId\": \"<optional id of an existing Security>\" }")].into_iter().map(|(metric,tool_id,description,args_hint)| Arc::new(PositionTool { deps: deps.clone(),metric,meta: ToolMeta { tool_id,version: "1.0.0",description,args_hint,timeout_ms: 20_000,permission: "research-read",cost_category: ToolCostCategory::Free,side_effect: ToolSideEffect::None,network_allowlist: ToolNetworkAllowlist::None } }) as Arc<dyn Tool>).collect()
}
struct PositionTool { deps: Arc<PositionToolDeps>,metric: PositionMetric,meta: ToolMeta }
struct Report { figures: PositionFigures,as_of_date: String,disseminated_at: Option<String>,provenance: MarketDataProvenance }
#[async_trait]
impl Tool for PositionTool {
	fn meta(&self) -> &ToolMeta { &self.meta }
	fn parse_args(&self,args: &Value) -> Option<Value> {
		let key = if self.metric==PositionMetric::UsShortInterest { "ticker" } else { "code" };
		crate::sec::parse_symbol_args(args,key,true)
	}
	async fn execute(&self,args: Value,context: ToolContext) -> Result<ToolOutput,ToolFailure> {
		let object = args.as_object().ok_or_else(crate::sec::invalid_args)?;
		let key = if self.metric==PositionMetric::UsShortInterest { "ticker" } else { "code" };
		let symbol = object.get(key).and_then(Value::as_str).ok_or_else(crate::sec::invalid_args)?.to_uppercase();
		let security_id = object.get("securityId").and_then(Value::as_str);
		let (subject,result) = match self.metric {
			PositionMetric::UsShortInterest => (format!("US ticker {symbol}"),self.deps.us_short_interest.latest_short_interest(&symbol).await.map(|r| Report { figures: PositionFigures::UsShortInterest(r.figures),as_of_date: r.settlement_date,disseminated_at: r.disseminated_at,provenance: r.provenance })),
			PositionMetric::JpMarginBalance => (format!("Japanese securities code {symbol}"),self.deps.jp_margin_balance.latest_margin_balance(&symbol).await.map(|r| Report { figures: PositionFigures::JpMarginBalance(r.figures),as_of_date: r.as_of_date,disseminated_at: r.disseminated_at,provenance: r.provenance })),
		};
		Ok(position_output(self.deps.hasher.as_ref(),&context,self.metric,&subject,security_id,result))
	}
}
fn position_output(hasher: &dyn Hasher,context: &ToolContext,metric: PositionMetric,subject: &str,security_id: Option<&str>,result: Result<Report,MarketDataUnavailable>) -> ToolOutput {
	let labels = position_labels(metric);
	let mut observation = PositionObservation { observation_id: context.ids.next_id("po"),security_id: security_id.map(str::to_owned).unwrap_or_else(|| context.ids.next_id("sec")),jurisdiction: if metric==PositionMetric::JpMarginBalance { Market::Jp } else { Market::Us },metric,figures: None,unavailable_reason: None,metric_definition: format!("{}. {}",labels.heading,labels.caveat),unit: SharesUnit,as_of_date: None,disseminated_at: None,source_evidence_id: None };
	let link = if security_id.is_none() { " No securityId was supplied, so this observation is not linked to a Security record." } else { "" };
	let mut evidence = Vec::new();
	let model_text = match result {
		Err(error) => {
			let reason = truncate_text(&error.reason,300).into_owned();
			let lines = [format!("{} for {subject}: UNAVAILABLE. {reason}",labels.heading),format!("{} Report this metric as unavailable; do not estimate or substitute another figure. Observation id: {}.{link}",labels.caveat,observation.observation_id)];
			observation.unavailable_reason = Some(reason); bound_model_text(&lines)
		}
		Ok(report) => {
			let p = report.provenance;
			let collected = collect_evidence(hasher,EvidenceInput { evidence_id: context.ids.next_id("ev"),source_url: p.source_url,title: p.title,publisher: p.publisher,published_at: p.published_at,retrieved_at: (context.now_iso)(),effective_at: Some(format!("{}T00:00:00.000Z",report.as_of_date)),source_class: SourceClass::MarketData,retrieved_text: p.retrieved_text,retain_quotes: false,excerpt: None });
			let figures = research_contracts::json::to_js_json(&report.figures).unwrap_or_else(|_| "null".to_owned());
			let text = bound_model_text(&[format!("{} for {subject}, as of {}: {figures} (shares). Evidence [{}]. Observation id: {}.{link}",labels.heading,report.as_of_date,collected.evidence.evidence_id,observation.observation_id),labels.caveat.to_owned()]);
			observation.figures = Some(report.figures); observation.as_of_date = Some(report.as_of_date); observation.disseminated_at = report.disseminated_at; observation.source_evidence_id = Some(collected.evidence.evidence_id.clone()); evidence.push(collected); text
		}
	};
	ToolOutput { model_text,evidence,position_observations: vec![observation],..ToolOutput::default() }
}
