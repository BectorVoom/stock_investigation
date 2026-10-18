/** Provider parity: real TypeScript interpreters, builders, turns and HTTP transcripts. */
import { readdir, readFile } from "node:fs/promises";
import type { Effort } from "@research/agent-core";
import {
	buildClaudeArgs,
	createClaudeStreamInterpreter,
} from "../../packages/adapters/src/providers/claudeCode.ts";
import type { CliStreamInterpreter } from "../../packages/adapters/src/providers/cliTurn.ts";
import {
	buildCodexArgs,
	createCodexStreamInterpreter,
} from "../../packages/adapters/src/providers/codex.ts";
import {
	buildChildEnv,
	probeWorkingDirectory,
} from "../../packages/adapters/src/providers/environment.ts";
import {
	createClaudeCodeRuntime,
	createCodexRuntime,
	createOpenCodeRuntime,
} from "../../packages/adapters/src/providers/index.ts";
import { splitLines } from "../../packages/adapters/src/providers/lines.ts";
import {
	buildOpenCodeArgs,
	buildOpenCodeConfigContent,
	createOpenCodeStreamInterpreter,
	modelArgumentsFor,
	parseModelList,
} from "../../packages/adapters/src/providers/openCode.ts";
import {
	createOpenRouterFreeRuntime,
	createOpenRouterRuntime,
	failureForHttpStatus,
	interpretSseLine,
	parseRetryAfterMs,
	rejectionRetryDelayMs,
} from "../../packages/adapters/src/providers/openRouter.ts";
import { parseFreeModelIds } from "../../packages/adapters/src/providers/openRouterModels.ts";
import {
	asKnownCostUsd,
	hintFromHttpStatus,
	hintFromText,
	isValidModelId,
	preflightTurn,
} from "../../packages/adapters/src/providers/turn.ts";
import {
	BASE_ENV,
	collect,
	createFakeProcessRunner,
	makeContext,
	makeEnvironment,
	makeRequest,
	SECRET_ENV,
} from "../../packages/adapters/test/providers/helpers.ts";
import { existingTestInputs } from "./providers/testInputs.ts";
import {
	doubleBits,
	seededRandom,
	type VectorExporter,
	type VectorFile,
	wellFormed,
} from "./shared.ts";

const fixtures = new URL("../../packages/adapters/test/providers/fixtures/", import.meta.url);
const efforts: readonly Effort[] = ["low", "medium", "high"];
const options = [
	{ askAndReject: false },
	{ askAndReject: true },
	{ askAndReject: true, permittedToolIds: ["web.search", "web.fetch_page"], maxToolRequests: 2 },
] as const;
const exitCases = [
	{ code: 0, signal: null, stderrTail: "" },
	{ code: 1, signal: null, stderrTail: "" },
	{ code: null, signal: "SIGKILL", stderrTail: "" },
	{ code: 1, signal: null, stderrTail: "quota reached" },
];

function normalized(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value), (_key, value: unknown) =>
		typeof value === "string"
			? wellFormed(value)
			: typeof value === "number" && !Number.isInteger(value)
				? { doubleBits: doubleBits(value) }
				: value,
	) as unknown;
}
function interpreter(backend: string, option = 0): CliStreamInterpreter {
	if (backend === "opencode") return createOpenCodeStreamInterpreter(options[option]);
	if (backend === "codex") return createCodexStreamInterpreter();
	return createClaudeStreamInterpreter();
}
async function fixtureSequences(backend: string): Promise<string[][]> {
	const sequences: string[][] = [];
	for (const file of (await readdir(new URL(`${backend}/`, fixtures))).sort()) {
		if (file.endsWith("jsonl"))
			sequences.push(
				(await readFile(new URL(`${backend}/${file}`, fixtures), "utf8"))
					.split("\n")
					.filter(Boolean),
			);
	}
	return sequences;
}
function mutatedCorpus(inputs: readonly unknown[]): string[] {
	const corpus = new Set<string>([
		"",
		"{",
		"null",
		"[]",
		"true",
		'"x"',
		"\uFEFF{}",
		'{"type":"text","part":{"text":"\\ud800"}}',
		'{"type":"text","part":{"text":"x"},"extra":1e400}',
	]);
	for (const input of inputs) {
		if (typeof input === "string") {
			if (input.length < 1000) corpus.add(input);
		} else if (typeof input === "object" && input !== null) {
			const line = JSON.stringify(input);
			if (line.length < 4000) corpus.add(line);
		}
	}
	const bases: readonly Record<string, unknown>[] = [
		{ type: "text", part: { type: "text", text: "OK 😀" } },
		{
			type: "tool_use",
			part: {
				type: "tool_use",
				tool: "web.search",
				id: "call",
				state: {
					status: "error",
					input: { q: "a" },
					metadata: { providerCall: { executed: false } },
				},
			},
		},
		{
			type: "error",
			error: { type: "provider.no-route", message: "Variant unavailable for model: high" },
		},
		{ type: "item.completed", item: { type: "agent_message", text: "OK" } },
		{ type: "turn.failed", error: { message: "authentication" } },
		{ type: "system", subtype: "init", tools: [], mcp_servers: [], apiKeySource: "none" },
		{
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "日本語" } },
		},
		{ type: "assistant", error: "server_error", message: { content: [{ type: "text" }] } },
		{ type: "result", subtype: "success", is_error: false, result: "OK", api_error_status: null },
		{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
	];
	const mutations: readonly unknown[] = [
		null,
		true,
		false,
		0,
		123,
		"",
		"tool",
		[],
		{},
		"日本語",
		"😀",
	];
	const random = seededRandom(0x72527031);
	for (let i = 0; i < 1200; i += 1) {
		const base = bases[Math.floor(random() * bases.length)];
		if (base === undefined) throw new Error("base");
		const clone: Record<string, unknown> = JSON.parse(JSON.stringify(base));
		let object = clone;
		const depth = Math.floor(random() * 4);
		for (let d = 0; d < depth; d += 1) {
			const nested = Object.values(object).filter(
				(v): v is Record<string, unknown> =>
					typeof v === "object" && v !== null && !Array.isArray(v),
			);
			const next = nested[Math.floor(random() * nested.length)];
			if (next === undefined) break;
			object = next;
		}
		const key = Object.keys(object)[Math.floor(random() * Object.keys(object).length)] ?? "type";
		if (random() < 0.2) delete object[key];
		else object[key] = mutations[Math.floor(random() * mutations.length)];
		corpus.add(JSON.stringify(clone));
	}
	for (const base of bases) corpus.add(JSON.stringify(base));
	return [...corpus];
}
async function buildInterpretations(corpus: readonly string[]): Promise<VectorFile[]> {
	const files: VectorFile[] = [];
	for (const backend of ["opencode", "codex", "claude-code"]) {
		const fixtures = await fixtureSequences(backend);
		const sequences = [
			...fixtures,
			...corpus.map((line) => [line]),
			...fixtures.flatMap((a) => fixtures.map((b) => [...a, ...b])),
		];
		const cases: unknown[] = [];
		for (const [index, lines] of sequences.entries()) {
			for (const option of backend === "opencode" ? [0, 1, 2] : [0]) {
				const stream = interpreter(backend, option);
				let emitted = 0;
				const verdicts = lines.map((line) => {
					const verdict = stream.interpretLine(line);
					if (verdict.kind === "text") emitted += verdict.text.length;
					return verdict;
				});
				const exit = exitCases[index % exitCases.length];
				if (exit === undefined) throw new Error("exit");
				cases.push({
					input: { lines, option, exit },
					output: { verdicts, conclusion: stream.conclude(exit, emitted) },
				});
			}
		}
		files.push({ path: `providers/${backend}-lines.json`, content: normalized(cases) });
	}
	return files;
}
async function cliTranscripts(): Promise<unknown[]> {
	const cases: unknown[] = [];
	for (const backend of ["opencode", "codex", "claude-code"]) {
		const sequences = await fixtureSequences(backend);
		sequences.push(
			[],
			["garbage"],
			Array.from({ length: 9 }, () => "garbage"),
		);
		for (const [index, lines] of sequences.entries()) {
			for (const effort of efforts) {
				const script = { lines, exit: exitCases[index % exitCases.length] };
				const fake = createFakeProcessRunner(script);
				const env = {
					...BASE_ENV,
					...SECRET_ENV,
					XDG_CONFIG_HOME: "/owner/config",
					CODEX_HOME: "/owner/codex",
					CLAUDE_CONFIG_DIR: "/owner/claude",
					CLAUDE_CODE_OAUTH_TOKEN: "test-oauth",
				};
				const environment = makeEnvironment({ env, processRunner: fake.runner });
				const files: { path: string; content: string }[] = [];
				const runtime =
					backend === "opencode"
						? createOpenCodeRuntime(environment, {
								writeConfigFile: async (path, content) => {
									files.push({ path, content });
								},
							})
						: backend === "codex"
							? createCodexRuntime(environment)
							: createClaudeCodeRuntime(environment);
				const model =
					backend === "opencode"
						? "opencode/model-free"
						: index % 2 === 0
							? null
							: "provider/model";
				const request = makeRequest({
					permittedToolIds: ["web.search", "web.fetch_page"],
					maxToolCalls: 2,
				});
				const context = makeContext({ model, effort });
				const events = await collect(runtime.run(request, context));
				cases.push({
					input: {
						backend,
						script,
						env,
						request,
						context: { scratchDirectory: context.scratchDirectory, model, effort },
					},
					output: {
						spawns: fake.spawns.map(({ signal: _signal, ...spawn }) => spawn),
						files,
						events,
					},
				});
			}
		}
	}
	return cases;
}
async function httpTranscripts(): Promise<unknown[]> {
	const bodies: string[] = [];
	for (const file of (await readdir(new URL("openrouter/", fixtures))).sort())
		if (file.endsWith(".sse"))
			bodies.push(await readFile(new URL(`openrouter/${file}`, fixtures), "utf8"));
	bodies.push(
		'data:{"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\r\n\r\ndata:[DONE]\r\n',
		"data:{}\n",
		'data:{"choices":[{"finish_reason":"length"}]}\ndata:[DONE]\n',
		...[null, -1, 0, 0.5].map(
			(cost) =>
				`data:${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { cost } })}\ndata:[DONE]\n`,
		),
	);
	const cases: unknown[] = [];
	for (const free of [false, true])
		for (const effort of efforts)
			for (const body of bodies) {
				const calls: unknown[] = [];
				const environment = makeEnvironment({
					env: {
						...BASE_ENV,
						OPENROUTER_API_KEY: "sk-or-v1-test-key",
						OPENROUTER_MODEL: "example/model",
						OPENROUTER_FREE_MODEL: "example/model:free",
					},
					fetch: async (url, init) => {
						calls.push({
							url,
							method: init?.method,
							headers: init?.headers,
							body: init?.body,
							redirect: init?.redirect,
						});
						// One-byte chunks exercise UTF-8 decoding as well as SSE line splitting.
						const bytes = new TextEncoder().encode(body);
						return new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
									controller.close();
								},
							}),
						);
					},
				});
				const runtime = free
					? createOpenRouterFreeRuntime(environment, { catalog: { list: async () => null } })
					: createOpenRouterRuntime(environment);
				// A short remaining deadline suppresses retries of the overload fixture.
				const request = makeRequest({ deadline: new Date(Date.now() + 20_000).toISOString() });
				const context = makeContext({ effort });
				const events = await collect(runtime.run(request, context));
				cases.push({ input: { free, effort, body }, output: { calls, events } });
			}
	return cases;
}

export const providersExporter: VectorExporter = {
	name: "providers",
	async build() {
		const inputs = await existingTestInputs();
		const corpus = mutatedCorpus(inputs);
		const builders: unknown[] = [];
		for (const model of [
			null,
			"sonnet",
			"provider/model#high",
			"opencode/model-free",
			"~openai/gpt-sol-latest",
		])
			for (const effort of efforts)
				for (const scratch of ["/scratch/job_1", "/scratch space/日本語", ""]) {
					builders.push({
						input: { model, effort, scratch },
						output: {
							codex: buildCodexArgs(scratch, model, effort),
							claude: buildClaudeArgs(model, effort),
							opencode: buildOpenCodeArgs(model ?? "provider/model"),
							config: buildOpenCodeConfigContent(model ?? "provider/model"),
							variants: modelArgumentsFor(model ?? "provider/model", effort, new Set(["low"])),
						},
					});
				}
		const environments = [
			BASE_ENV,
			{ ...BASE_ENV, ...SECRET_ENV, CODEX_HOME: "/codex", XDG_CONFIG_HOME: "/xdg" },
			{ PATH: "/bin", HOME: undefined, LANG: "", TMPDIR: "" },
		].flatMap((env) =>
			[[], ["CODEX_HOME"], ["XDG_CONFIG_HOME"]].map((keys) => ({
				input: { env, keys },
				output: { env: buildChildEnv(env, keys), cwd: probeWorkingDirectory(env) },
			})),
		);
		const sse = [
			...corpus.map((line) => `data:${line}`),
			"data: [DONE]",
			": keepalive",
			'data:{"usage":null}',
			'data:{"usage":{"cost":-1}}',
			'data:{"usage":{"cost":0.00042}}',
		];
		const catalogs: unknown[] = [
			JSON.parse(await readFile(new URL("openrouter/models.json", fixtures), "utf8")),
			null,
			{},
			{ data: [] },
		];
		for (const price of [
			0,
			-0,
			-1,
			"",
			" ",
			"0",
			"0x0",
			"0b0",
			"0o0",
			"0e5",
			".0",
			"0,0",
			"0_0",
			null,
		])
			catalogs.push({
				data: ["openrouter/free", "a/m:free", "a/paid", "-m:free"].map((id) => ({
					id,
					pricing: { prompt: price, completion: price },
				})),
			});
		catalogs.push({
			data: Array.from({ length: 350 }, (_, index) => ({
				id: `p/m${350 - index}:free`,
				pricing: { prompt: 0, completion: "0" },
			})),
		});
		const hints = [
			...corpus.filter((s) => !s.startsWith("{")),
			"Not logged in · Please run /login",
			"unexpected status 401 Unauthorized: Missing bearer",
			"You've hit your usage limit",
			"429 Too Many Requests",
			"Insufficient credits",
			"Overloaded",
			"segmentation fault",
			"took 4010 ms on port 14290",
			"ſervice unavailable",
			"é401é",
			"invalid credentials billing quota 503",
		];
		const models = [
			"sonnet",
			"gpt-6.1-sol",
			"opencode-go/glm-5.3-flash",
			"anthropic/claude-sonnet-4.5",
			"meta-llama/llama-3.3-70b-instruct:free",
			"~openai/gpt-sol-latest",
			"provider/model#high",
			"",
			"-m",
			"--model",
			"a b",
			"a\tb",
			"a;b",
			"$(id)",
			"a`b",
			"../x y",
			"x".repeat(101),
			...corpus.slice(0, 200),
		];
		const lineCases: unknown[] = [];
		for (const text of [
			"",
			"one\ntwo",
			"a\r\n\r\nb\r\n",
			"\uFEFF😀日本語\n\nlast\r",
			"x".repeat(25),
			"a\u0085\uFEFF\n",
		])
			for (const max of [1, 10, 1000]) {
				const bytes = new TextEncoder().encode(text);
				for (const width of [1, 2, 7, 1000]) {
					const chunks: number[][] = [];
					for (let offset = 0; offset < bytes.length; offset += width)
						chunks.push([...bytes.slice(offset, offset + width)]);
					async function* stream() {
						for (const chunk of chunks) yield Uint8Array.from(chunk);
					}
					const output: string[] = [];
					for await (const line of splitLines(stream(), max)) output.push(line);
					lineCases.push({ input: { chunks, max }, output: output.map(wellFormed) });
				}
			}
		const now = Date.parse("2026-10-17T00:00:00Z");
		const retryHeaders = [
			null,
			"",
			"2",
			" 30 ",
			"-5",
			"1.5",
			"999999999999999999999999999999999999999999999",
			"9".repeat(400),
			"Sat, 17 Oct 2026 00:00:05 GMT",
			"Fri, 16 Oct 2026 00:00:00 GMT",
			"no date",
		];
		const retry = [0, 1, 2, 3].flatMap((index) =>
			[null, 0, 1000, 30000, 30001].flatMap((after) =>
				[0, 31000, 60000, 600000].map((remaining) => ({
					input: { index, after, remaining },
					output: rejectionRetryDelayMs(index, after, remaining),
				})),
			),
		);
		return [
			{ path: "providers/builders.json", content: { builders, environments } },
			...(await buildInterpretations(corpus)),
			{
				path: "providers/sse.json",
				content: normalized(sse.map((input) => ({ input, output: interpretSseLine(input) }))),
			},
			{
				path: "providers/pure.json",
				content: {
					models: models.map((input) => ({ input, output: isValidModelId(input) })),
					hints: hints.map((input) => ({ input, output: hintFromText(input) })),
					statuses: [200, 400, 401, 402, 403, 404, 408, 429, 500, 502, 503, 504, 529, 999].map(
						(input) => ({
							input,
							output: { hint: hintFromHttpStatus(input), failure: failureForHttpStatus(input) },
						}),
					),
					costs: [0.5, 0, -0.01, Number.NaN, Number.POSITIVE_INFINITY].map((input) => ({
						input: doubleBits(input),
						output: asKnownCostUsd(input) === null ? null : doubleBits(input),
					})),
					retry,
					headers: retryHeaders.map((input) => ({
						input,
						now,
						output:
							parseRetryAfterMs(input, now) === null
								? null
								: doubleBits(parseRetryAfterMs(input, now) ?? 0),
					})),
					catalogs: catalogs.map((input) => ({ input, output: parseFreeModelIds(input) })),
					modelLists: [
						await readFile(new URL("opencode/models.txt", fixtures), "utf8"),
						" \uFEFFa/m\n\nb/m\na/m\n--bad\n日本語",
					].map((input) => ({ input, output: parseModelList(input) })),
					preflight: ["2026-10-11T00:01:00+09:00", "2026-10-11T00:00:00.000Z", "soon"].map(
						(deadline) => ({
							input: { deadline, now: 0 },
							output: preflightTurn(makeRequest({ deadline }), makeContext(), 0),
						}),
					),
				},
			},
			{ path: "providers/lines.json", content: lineCases },
			{ path: "providers/cli-turns.json", content: normalized(await cliTranscripts()) },
			{ path: "providers/http-turns.json", content: normalized(await httpTranscripts()) },
		];
	},
};
