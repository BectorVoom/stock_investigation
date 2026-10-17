/**
 * The event logger (crate `research-effects`): the exact lines the real
 * `createEventLogger` of `packages/effects/src/logging.ts` writes, with a
 * fixed clock, for the inputs of its unit tests plus a seeded corpus of
 * field names (the redaction splitter), string lengths around the 200-unit
 * cap, line breaks, reserved and integer-like keys, and numbers.
 */
import { createEventLogger } from "../../packages/effects/src/logging.ts";
import {
	doubleBits,
	randomDouble,
	seededRandom,
	type VectorExporter,
	wellFormed,
} from "./shared.ts";

type Random = () => number;
type FieldValue = string | number | boolean | null;

/** How a field value travels: numbers as bit patterns, integers flagged. */
type WireValue =
	| { readonly s: string }
	| { readonly n: string }
	| { readonly i: number }
	| { readonly b: boolean }
	| { readonly null: true };

const pick = <T>(random: Random, items: readonly T[]): T => {
	const item = items[Math.floor(random() * items.length)];
	if (item === undefined) throw new Error("pick from an empty list");
	return item;
};

function wire(value: FieldValue): WireValue {
	if (value === null) return { null: true };
	if (typeof value === "string") return { s: value };
	if (typeof value === "boolean") return { b: value };
	return Number.isSafeInteger(value) && !Object.is(value, -0)
		? { i: value }
		: { n: doubleBits(value) };
}

const NOW = new Date("2026-10-12T00:00:00.000Z");

interface Case {
	readonly level: "info" | "warn" | "error";
	readonly event: string;
	readonly fields: readonly (readonly [string, FieldValue])[];
}

function run(cases: readonly Case[]) {
	return cases.map((entry) => {
		const lines: string[] = [];
		const logger = createEventLogger(
			(line) => {
				lines.push(line);
			},
			() => NOW,
		);
		const fields: Record<string, FieldValue> = {};
		for (const [key, value] of entry.fields) fields[key] = value;
		logger[entry.level](entry.event, fields);
		return {
			level: entry.level,
			event: entry.event,
			fields: entry.fields.map(([key, value]) => [key, wire(value)]),
			line: lines[0] ?? null,
		};
	});
}

const TEST_CASES: Case[] = [
	{
		level: "info",
		event: "job_claimed",
		fields: [
			["runId", "run_1"],
			["attempt", 2],
		],
	},
	{ level: "info", event: "runner_started", fields: [] },
	{ level: "warn", event: "slow", fields: [["retryInMs", 500]] },
	{ level: "error", event: "failed", fields: [["code", "CLAIM_FAILED"]] },
	{
		level: "info",
		event: "probe",
		fields: [
			["status", "available"],
			["retryInMs", 2000],
			["isolated", true],
			["reason", null],
		],
	},
	{
		level: "info",
		event: "real",
		fields: [
			["at", "forged"],
			["level", "forged"],
			["event", "forged"],
		],
	},
	...[
		"Job_Claimed",
		"",
		"9lives",
		"has space",
		"j",
		`a${"b".repeat(63)}`,
		`a${"b".repeat(64)}`,
	].map((event): Case => ({ level: "info", event, fields: [["runId", "run_1"]] })),
	{
		level: "info",
		event: "job_claimed",
		fields: [
			["token", "rk_secret_value"],
			["runnerToken", "rk_secret_value"],
			["authorization", "Bearer rk_secret_value"],
			["runId", "run_1"],
		],
	},
	{
		level: "info",
		event: "job_claimed",
		fields: [
			"secret",
			"Password",
			"passwd",
			"COOKIE",
			"credential",
			"apiKey",
			"api_key",
			"Prompt",
			"content",
			"text",
			"body",
			"message",
			"stack",
			"quote",
			"excerpt",
			"keep",
		].map((key): [string, FieldValue] => [key, key === "keep" ? "yes" : "s"]),
	},
	{ level: "info", event: "credential_checked", fields: [["credentialId", "cred_1"]] },
	{
		level: "info",
		event: "job_finished",
		fields: [
			["runId", "run_1"],
			["promptVersion", "research-v4"],
		],
	},
	{
		level: "info",
		event: "job_claimed",
		fields: [
			["prompt", "Summarise this article: ..."],
			["stack", "Error: boom\n    at run (runner.ts:10:5)"],
			["blob", "x".repeat(5000)],
			["attempt", 2],
		],
	},
	{ level: "info", event: "job_claimed", fields: [["ok", "x".repeat(200)]] },
	{ level: "info", event: "job_claimed", fields: [["tooLong", "x".repeat(201)]] },
	{ level: "info", event: "job_claimed", fields: [["astral", `${"x".repeat(198)}😀`]] },
	{ level: "info", event: "job_claimed", fields: [["astral", `${"x".repeat(199)}😀`]] },
	{
		level: "info",
		event: "job_claimed",
		fields: [
			["cr", "a\rb"],
			["sep", "a b"],
			["nel", "a\u0085b"],
		],
	},
	{
		level: "info",
		event: "Bad Event",
		fields: [
			["rejected", "mine"],
			["token", "x"],
			["redacted_fields", 9],
		],
	},
	{
		level: "info",
		event: "job_claimed",
		fields: [
			["redacted_fields", 9],
			["n", 1],
		],
	},
	{
		level: "info",
		event: "job_claimed",
		fields: [
			["b", 1],
			["10", 2],
			["2", 3],
			["a", 4],
			["01", 5],
			["4294967295", 6],
			["4294967294", 7],
		],
	},
	{
		level: "info",
		event: "job_finished",
		fields: [
			["knownCostUsd", 0.1 + 0.2],
			["costUsd", 1e21],
			["tiny", 1.5e-7],
			["negZero", -0],
			["nan", Number.NaN],
			["inf", Number.POSITIVE_INFINITY],
			["big", 2 ** 60],
			["unsafe", 2 ** 53 + 2],
		],
	},
	{ level: "info", event: "job_claimed", fields: [['quote"key\\', 'v"\\\u0001\t/é']] },
];

const NAME_PIECES = [
	"token",
	"Token",
	"TOKEN",
	"text",
	"Text",
	"context",
	"api",
	"Key",
	"key",
	"credential",
	"Id",
	"id",
	"prompt",
	"Version",
	"run",
	"Run",
	"URL",
	"Url",
	"html",
	"Body",
	"x",
	"2",
	"9",
	"_",
	"-",
	".",
	" ",
	"é",
	"😀",
	"A",
	"B",
	"a",
	"b",
	"message",
	"Stack",
	"pass",
	"wd",
];

function generatedCases(random: Random): Case[] {
	const cases: Case[] = [];
	for (let index = 0; index < 1500; index += 1) {
		const fields: [string, FieldValue][] = [];
		const count = Math.floor(random() * 5);
		for (let field = 0; field < count; field += 1) {
			let name = "";
			const pieces = 1 + Math.floor(random() * 4);
			for (let piece = 0; piece < pieces; piece += 1) name += pick(random, NAME_PIECES);
			const roll = random();
			let value: FieldValue;
			if (roll < 0.35) {
				const length = pick(random, [0, 1, 10, 199, 200, 201, 250]);
				value = wellFormed(
					Array.from({ length }, () =>
						pick(random, ["a", "é", "😀", " ", "\n", " ", '"', "\\"]),
					).join(""),
				);
			} else if (roll < 0.55) value = Math.floor(random() * 2_000_000) - 1000;
			else if (roll < 0.7)
				value =
					random() < 0.3
						? randomDouble(random)
						: (random() - 0.5) * 10 ** Math.floor(random() * 30 - 10);
			else if (roll < 0.85) value = random() < 0.5;
			else value = null;
			fields.push([wellFormed(name), value]);
		}
		const event =
			random() < 0.9
				? pick(random, ["job_claimed", "job_finished", "agent_probe", "x1"])
				: pick(random, ["Job", "1abc", "a"]);
		cases.push({ level: pick(random, ["info", "warn", "error"] as const), event, fields });
	}
	return cases;
}

export const loggingExporter: VectorExporter = {
	name: "logging",
	async build() {
		const random = seededRandom(5_150_001);
		return [
			{ path: "logging/lines.json", content: run([...TEST_CASES, ...generatedCases(random)]) },
		];
	},
};
