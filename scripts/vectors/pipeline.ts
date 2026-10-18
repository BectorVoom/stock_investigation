/** Pipeline parity corpus: executes the unchanged TypeScript test inputs with
 * captured effects, plus a seeded generated corpus of draft mutations. */
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { analysisDraftSchema, draftScenarioSchema, draftSupplierSchema, draftPricingPowerSchema, planSchema, verdictsSchema } from "../../packages/application/src/research/draft.ts";
import { analysis } from "../../packages/application/test/support.ts";
import { seededRandom, type VectorExporter } from "./shared.ts";
import { transcripts, prompts } from "./pipeline/capture.ts";
import { runCases } from "./pipeline/harness.ts";
import { ingestVectors } from "./pipeline/ingest.ts";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
async function loadScenarios(path:string):Promise<void>{
	let source=await readFile(resolve(root,path),"utf8");
	for(const name of ["runResearchPipeline","planningPrompt","analysisPrompt","verificationPrompt"]){const captured=`captured${name[0]?.toUpperCase()}${name.slice(1)}`;source=source.replace(new RegExp(`\\b${name}\\(`,"g"),`${captured}(`);}
	source=source.replace(/from "(\.[^"]+)"/g,(_match:string,specifier:string)=>`from "${pathToFileURL(resolve(root,dirname(path),specifier)).href}"`).replace(/from "vitest"/g,`from "${new URL("./pipeline/harness.ts",import.meta.url).href}"`);
	source=source.replace(/from "([^".:][^"]*)"/g,(_match:string,specifier:string)=>`from "${import.meta.resolve(specifier)}"`);
	source+=`\nimport { capturedRunResearchPipeline, capturedPlanningPrompt, capturedAnalysisPrompt, capturedVerificationPrompt } from "${new URL("./pipeline/capture.ts",import.meta.url).href}";`;
	const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,verbatimModuleSyntax:false}});
	await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`);
}
export const pipelineExporter:VectorExporter={name:"pipeline",async build(){
	await loadScenarios("packages/application/test/pipeline.test.ts");await loadScenarios("packages/application/test/prompts.test.ts");await loadScenarios("packages/application/test/promptVolume.test.ts");await runCases();
	const random=seededRandom(3404);const draft=JSON.parse(analysis()) as Record<string,unknown>;
	const schemas={plan:planSchema,analysis:analysisDraftSchema,scenario:draftScenarioSchema,supplier:draftSupplierSchema,pricingPower:draftPricingPowerSchema,verdicts:verdictsSchema};
	const drafts=[];const seeds:unknown[]=[null,0,true,"",[],{},draft,{claims:[]}, {toolCalls:[{toolId:"x"}]},{done:true},{verdicts:[{claimIndex:0,verdict:"supported"}]}];
	for(const [name,schema] of Object.entries(schemas)){
		const base=name==="analysis"?draft:name==="scenario"?(draft.scenarios as unknown[])?.[0]:name==="supplier"?(draft.suppliers as unknown[])?.[0]:name==="plan"?{toolCalls:[{toolId:"news.fetch_feed",args:{sourceId:"src_news"}}],done:true}:name==="pricingPower"?{ticker:"EXMP",exchange:"NASDAQ",fiscalYear:2026,fiscalPeriod:"FY",periodStart:"2026-01-01",periodEnd:"2026-12-31",evidenceIds:[]}: {verdicts:[]};
		const inputs=[...seeds,base];for(let i=0;i<160;i++){const value=structuredClone(base) as Record<string,unknown>;const keys=Object.keys(value);const key=keys[Math.floor(random()*keys.length)]??"claims";const mutations:unknown[]=[undefined,null," \ufeff 😀 text \u0085 ","x".repeat(1201),-1,0.5,[],[null],{}];const mutation=mutations[Math.floor(random()*mutations.length)];if(mutation===undefined)delete value[key];else value[key]=mutation;inputs.push(value);}
		for(const input of inputs){const result=schema.safeParse(input);drafts.push({input:{schema:name,value:input},output:result.success?{ok:result.data}:{err:result.error.issues.map(i=>({path:i.path.join("."),code:i.code,message:i.message}))}});}
	}
	const files=[];for(let offset=0;offset<transcripts.length;offset+=12){files.push({path:`pipeline/transcripts-${offset/12}.json`,content:transcripts.slice(offset,offset+12)});}
	files.push({path:"pipeline/ingest.json",content:await ingestVectors()},{path:"pipeline/prompts.json",content:prompts},{path:"pipeline/drafts.json",content:drafts});return files;
}};
