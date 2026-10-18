//! Forgiving, non-strict model draft schemas. Transforms run only after
//! validation, including validating array entries beyond the retained prefix.
use research_js::{json::{Value,Object}, utf16, whitespace};

#[derive(Clone)]
enum Schema {
	Unknown, Text { max: Option<usize>, transform: bool, empty: bool, upper: bool },
	Number { integer: bool, nonnegative: bool }, Boolean,
	Enum(&'static [&'static str]), Date,
	Object(Vec<(&'static str,Schema)>), Array(Box<Schema>,usize),
	Default(Box<Schema>,Value), Nullable(Box<Schema>),
}
impl Schema {
	fn default(self,value:Value)->Self{Self::Default(Box::new(self),value)}
	fn nullable(self)->Self{Self::Nullable(Box::new(self))}
	fn null(self)->Self{self.nullable().default(Value::Null)}
	fn array(self,max:usize)->Self{Self::Array(Box::new(self),max)}
	fn empty_array(self,max:usize)->Self{self.array(max).default(Value::Array(vec![]))}
}
fn obj(fields: Vec<(&'static str,Schema)>)->Schema{Schema::Object(fields)}
fn text(max:usize)->Schema{Schema::Text{max:Some(max),transform:true,empty:false,upper:false}}
fn string(max:Option<usize>)->Schema{Schema::Text{max,transform:false,empty:true,upper:false}}
fn quote()->Schema{Schema::Text{max:Some(400),transform:true,empty:true,upper:false}}
fn listing(upper:bool)->Schema{Schema::Text{max:None,transform:true,empty:true,upper}}
fn number()->Schema{Schema::Number{integer:false,nonnegative:false}}
fn integer(nonnegative:bool)->Schema{Schema::Number{integer:true,nonnegative}}
fn ids()->Schema{string(Some(120)).array(12)}
fn case()->Schema{obj(vec![("targetValue",number()),("assumptions",text(400).array(8))])}

/// A zod-style issue, whose ordered path is used in repair prompts.
#[derive(Debug,Clone,PartialEq,Eq)]
pub struct DraftIssue {
	/// Dot-separated issue path.
	pub path: String,
	/// Zod issue code.
	pub code: &'static str,
	/// Zod English message.
	pub message: String,
}
fn received(value:Option<&Value>)->&'static str{match value{None=>"undefined",Some(Value::Null)=>"null",Some(Value::Bool(_))=>"boolean",Some(Value::Number(n)) if n.is_nan()=>"NaN",Some(Value::Number(n)) if !n.is_finite()=>"number",Some(Value::Number(_))=>"number",Some(Value::String(_))=>"string",Some(Value::Array(_))=>"array",Some(Value::Object(_))=>"object"}}
fn issue(issues:&mut Vec<DraftIssue>,path:&str,code:&'static str,message:String){issues.push(DraftIssue{path:path.to_owned(),code,message});}
fn invalid(issues:&mut Vec<DraftIssue>,path:&str,expected:&str,v:Option<&Value>){issue(issues,path,"invalid_type",format!("Invalid input: expected {expected}, received {}",received(v)));}
fn child(path:&str,key:&str)->String{if path.is_empty(){key.to_owned()}else{format!("{path}.{key}")}}
fn decode(schema:&Schema,value:Option<&Value>,path:&str,issues:&mut Vec<DraftIssue>)->Option<Value>{
	match schema {
		Schema::Default(_,default) if value.is_none()=>Some(default.clone()),
		Schema::Default(inner,_)=>decode(inner,value,path,issues),
		Schema::Nullable(_) if matches!(value,Some(Value::Null))=>Some(Value::Null),
		Schema::Nullable(inner)=>decode(inner,value,path,issues),
		Schema::Unknown=>{if let Some(v)=value{Some(v.clone())}else{invalid(issues,path,"nonoptional",value);None}},
		Schema::Text{max,transform,empty,upper}=>{
			let Some(Value::String(input))=value else{invalid(issues,path,"string",value);return None;};
			if !transform && max.is_some_and(|m|input.chars().count()>m){issue(issues,path,"too_big",format!("Too big: expected string to have <={} characters",max.unwrap_or_default()));}
			let mut output=if *transform{whitespace::trim(input).to_owned()}else{input.clone()};
			if *transform{if let Some(max)=max{output=utf16::truncate(&output,*max).into_owned();}}
			if *upper{output=output.to_uppercase();}
			if !empty && output.is_empty(){issue(issues,path,"too_small","Too small: expected string to have >=1 characters".to_owned());}
			Some(Value::String(output))
		},
		Schema::Number{integer,nonnegative}=>{
			let Some(Value::Number(n))=value else{invalid(issues,path,if *integer{"int"}else{"number"},value);return None;};
			if !n.is_finite(){invalid(issues,path,if *integer{"int"}else{"number"},value);return None;}
			if *integer && n.fract()!=0.0{issue(issues,path,"invalid_type","Invalid input: expected int, received number".to_owned());return None;}
			if *integer && n.abs()>9_007_199_254_740_991.0{issue(issues,path,if *n<0.0{"too_small"}else{"too_big"},if *n<0.0{"Too small: expected int to be >=-9007199254740991"}else{"Too big: expected int to be <=9007199254740991"}.to_owned());}
			if *nonnegative && *n<0.0{issue(issues,path,"too_small","Too small: expected number to be >=0".to_owned());}
			Some(Value::Number(*n))
		},
		Schema::Boolean=>if let Some(Value::Bool(v))=value{Some(Value::Bool(*v))}else{invalid(issues,path,"boolean",value);None},
		Schema::Enum(options)=>{
			if let Some(Value::String(v))=value{if options.contains(&v.as_str()){return Some(Value::String(v.clone()));}}
			issue(issues,path,"invalid_value",format!("Invalid option: expected one of {}",options.iter().map(|s|format!("\"{s}\"")).collect::<Vec<_>>().join("|")));None
		},
		Schema::Date=>{
			let Some(Value::String(v))=value else{invalid(issues,path,"string",value);return None;};
			if !research_contracts::patterns::is_iso_date(v){issue(issues,path,"invalid_format","Invalid ISO date".to_owned());}
			Some(Value::String(v.clone()))
		},
		Schema::Object(fields)=>{
			let Some(Value::Object(o))=value else{invalid(issues,path,"object",value);return None;};
			let mut result=Object::new();
			for (key,schema) in fields {if let Some(v)=decode(schema,o.get(key),&child(path,key),issues){result.insert(*key,v);}}
			Some(Value::Object(result))
		},
		Schema::Array(inner,max)=>{
			let Some(Value::Array(items))=value else{invalid(issues,path,"array",value);return None;};
			let mut output=Vec::with_capacity(items.len().min(*max));
			for (i,item) in items.iter().enumerate(){if let Some(v)=decode(inner,Some(item),&child(path,&i.to_string()),issues){if i<*max{output.push(v);}}}
			Some(Value::Array(output))
		},
	}
}

fn schema(name:&str)->Schema{
	match name {
		"plan"=>obj(vec![("toolCalls",obj(vec![("toolId",string(Some(80))),("args",Schema::Unknown)]).empty_array(8)),("done",Schema::Boolean.default(Value::Bool(false)))]),
		"analysis"=>obj(vec![("claims",obj(vec![("text",text(1000)),("claimType",Schema::Enum(&["observation","inference","hypothesis","forecast"])),("evidence",obj(vec![("evidenceId",string(Some(120))),("relation",Schema::Enum(&["supports","contradicts","context"])),("quote",quote().null())]).empty_array(12))]).array(40)),("scenarios",Schema::Unknown.empty_array(8)),("suppliers",Schema::Unknown.empty_array(20)),("pricingPower",Schema::Unknown.empty_array(12)),("uiOperations",Schema::Unknown.empty_array(12))]),
		"scenario"=>obj(vec![("productOrService",text(300)),("quantityKind",Schema::Enum(&["unit-demand","revenue","price"])),("unit",text(80)),("baseYear",integer(false)),("targetYear",integer(false)),("baselineValue",number().null()),("baselineEvidenceId",string(Some(120)).null()),("baselineQuote",quote().null()),("bear",case()),("base",case()),("bull",case()),("drivers",text(400).array(8)),("barriers",text(400).empty_array(8)),("falsifiers",text(400).array(8)),("methodology",text(2000)),("supportingEvidenceIds",ids().default(Value::Array(vec![]))),("contraryEvidenceIds",ids().default(Value::Array(vec![])))]),
		"supplier"=>obj(vec![("issuerName",text(300)),("ticker",listing(true)),("exchange",listing(false)),("country",Schema::Enum(&["JP","US"])),("productsOrServices",text(300).array(8)),("businessExposure",text(1000)),("scenarioIndex",integer(true).null()),("evidence",obj(vec![("evidenceId",string(Some(120))),("quote",quote())]).array(6))]),
		"pricingPower"=>{let mut f=vec![("ticker",listing(true)),("exchange",listing(false)),("fiscalYear",integer(false)),("fiscalPeriod",Schema::Enum(&["FY","Q1","Q2","Q3","Q4","TTM"])),("periodStart",Schema::Date),("periodEnd",Schema::Date)];for key in PRICE_FIELDS{f.push((key,number().null()));}f.extend([("managementCommentaryEvidenceIds",ids().default(Value::Array(vec![]))),("evidenceIds",ids())]);obj(f)},
		_=>obj(vec![("verdicts",obj(vec![("claimIndex",integer(true)),("verdict",Schema::Enum(&["supported","unsupported","contradicted"]))]).empty_array(usize::MAX))]),
	}
}

pub(super) const PRICE_FIELDS:[&str;8]=["revenueGrowthPct","priceRealizationPct","volumeGrowthPct","mixEffectPct","fxEffectPct","inputCostChangePct","grossMarginChangeBps","operatingMarginChangeBps"];

/// Parses a plan, analysis, scenario, supplier, pricingPower or verdicts draft.
pub fn parse_draft(name:&str,input:&Value)->Result<Value,Vec<DraftIssue>>{
	let mut issues=Vec::new();let value=decode(&schema(name),Some(input),"",&mut issues);
	match value {Some(v) if issues.is_empty()=>Ok(v),_=>Err(issues)}
}
