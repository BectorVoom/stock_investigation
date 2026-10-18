/** Captures real pipeline calls made by the original TS test scenarios. */
import { createToolRegistry, type AgentRuntime, type ToolDefinition, type ToolContext, type ToolOutput, type ToolFailure } from "@research/agent-core";
import type { AgentEvent } from "@research/contracts";
import type { Result } from "@research/domain";
import { runResearchPipeline, type ResearchPipelineInput, type ResearchPipelineDeps } from "../../../packages/application/src/research/pipeline.ts";
import { planningPrompt, analysisPrompt, verificationPrompt } from "../../../packages/application/src/research/prompts.ts";
import { currentCase } from "./harness.ts";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
function frozen(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
export const transcripts: { input: unknown; output: unknown }[] = [];
export const prompts: { input: unknown; output: string }[] = [];
export function capturedPlanningPrompt(input: Parameters<typeof planningPrompt>[0]): string { const output=planningPrompt(input);prompts.push({input:{builder:"planning",...input,tools:input.tools.map(meta)},output});return output; }
export function capturedAnalysisPrompt(input: Parameters<typeof analysisPrompt>[0]): string {const output=analysisPrompt(input);prompts.push({input:{builder:"analysis",...input},output});return output;}
export function capturedVerificationPrompt(input: Parameters<typeof verificationPrompt>[0]): string {const output=verificationPrompt(input);prompts.push({input:{builder:"verification",...input},output});return output;}
function meta(tool: ToolDefinition) { const { argsSchema: _schema, execute: _execute, ...rest } = tool; return rest; }
interface Turn { events: AgentEvent[]; cancelled: boolean; threw: string | null }
interface Execution { args: unknown; ids: { prefix: string; id: string }[]; result: Result<ToolOutput,ToolFailure> | null }
interface SchemaCall { input: unknown; output: unknown }
interface ScriptTool { meta: ReturnType<typeof meta>; schemas: SchemaCall[]; executions: Execution[] }
export async function capturedRunResearchPipeline(input: ResearchPipelineInput,deps: ResearchPipelineDeps) {
	const trace: unknown[]=[];const turns: Turn[]=[];const tools: ScriptTool[]=[];const ms:number[]=[];const iso:string[]=[];const fences:string[]=[];
	let probe: Awaited<ReturnType<AgentRuntime["probe"]>> | null=null;
	const agent: AgentRuntime={...deps.agent,async probe(){probe=await deps.agent.probe();return probe;},async *run(request,context){
		trace.push({type:"agent",request,context:{scratchDirectory:context.scratchDirectory,model:context.model,effort:context.effort}});
		const turn:Turn={events:[],cancelled:false,threw:null};turns.push(turn);
		try{for await(const event of deps.agent.run(request,context)){turn.events.push(event);turn.cancelled=context.signal.aborted;yield event;}}
		catch(error){turn.threw=error instanceof Error?error.name:"unknown";throw error;}
	}};
	const registry=createToolRegistry(deps.tools.list().map((tool)=>{
		const script:ScriptTool={meta:meta(tool),schemas:[],executions:[]};tools.push(script);
		const recordSchema=(value:unknown)=>{const parsed=tool.argsSchema.safeParse(value);script.schemas.push({input:frozen(value),output:parsed.success?{ok:parsed.data}:{err:true}});return parsed;};
		const argsSchema=new Proxy(tool.argsSchema,{get(target,key,receiver){return key==="safeParse"?recordSchema:Reflect.get(target,key,receiver);}});
		return {...tool,argsSchema,async execute(args:unknown,context:ToolContext){
			recordSchema(args);trace.push({type:"execute",toolId:tool.toolId,args:frozen(args)});
			const execution:Execution={args:frozen(args),ids:[],result:null};script.executions.push(execution);
			const result=await tool.execute(args,{...context,nextId(prefix){const id=context.nextId(prefix);execution.ids.push({prefix,id});return id;}});execution.result=result;return result;
		}};
	}));
	const clock={nowMs(){const value=deps.clock.nowMs();ms.push(value);return value;},nowIso(){const value=deps.clock.nowIso();iso.push(value);return value;}};
	const reporter={async state(state: Parameters<ResearchPipelineDeps["reporter"]["state"]>[0]){trace.push({type:"state",state});await deps.reporter.state(state);},async note(text:string){trace.push({type:"note",text});await deps.reporter.note(text);},async tool(toolId:string,outcome:"executed"|"denied"|"failed",detail:string){trace.push({type:"tool",toolId,outcome,detail});await deps.reporter.tool(toolId,outcome,detail);},async usage(usage:Parameters<ResearchPipelineDeps["reporter"]["usage"]>[0]){trace.push({type:"usage",usage});await deps.reporter.usage(usage);}};
	const {signal,...job}=input;const aborted=signal.aborted;
	// AbortSignal.timeout does not keep Node alive. This bounded foreground timer
	// only keeps the original 40 ms wall-time test alive until it returns.
	const keepAlive=setTimeout(()=>{throw new Error("pipeline vector scenario stalled");},10_000);
	try{
		const outcome=await runResearchPipeline(input,{...deps,agent,tools:registry,clock,reporter,newFenceToken(){const token=deps.newFenceToken();fences.push(token);return token;}});
		transcripts.push({input:{name:currentCase,job,aborted,agent:{agentId:agent.agentId,costModel:agent.costModel,toolIsolation:agent.toolIsolation,probe},turns,tools,clock:{ms,iso},fences,scratchDirectory:deps.scratchDirectory},output:frozen({trace,outcome})});return outcome;
	}finally{clearTimeout(keepAlive);}
}
