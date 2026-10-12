import { Effect, Logger, References } from "effect";
import { describe, expect, it } from "vitest";
import {
	createEventLogger,
	logEvent,
	MAX_LOG_FIELD_CHARS,
	makeJsonLogger,
	silentEventLogger,
} from "../src/index.ts";

const FIXED_NOW = () => new Date("2026-10-12T00:00:00.000Z");

function collect(now: () => Date = FIXED_NOW) {
	const lines: string[] = [];
	const logger = makeJsonLogger((line) => {
		lines.push(line);
	}, now);
	const run = (effect: Effect.Effect<void>): void => {
		Effect.runSync(Effect.provide(effect, Logger.layer([logger])));
	};
	return { lines, run };
}

describe("JSON logger line format", () => {
	it("writes exactly one line per call with at, level and event", () => {
		const { lines, run } = collect();
		run(logEvent("info", "job_claimed", { runId: "run_1", attempt: 2 }));
		expect(lines).toEqual([
			'{"at":"2026-10-12T00:00:00.000Z","level":"info","event":"job_claimed","runId":"run_1","attempt":2}\n',
		]);
	});

	it("uses the injected clock", () => {
		const { lines, run } = collect(() => new Date("2030-05-06T07:08:09.000Z"));
		run(logEvent("info", "tick"));
		expect(lines[0]?.startsWith('{"at":"2030-05-06T07:08:09.000Z"')).toBe(true);
	});

	it("maps info, warn and error levels", () => {
		const { lines, run } = collect();
		run(logEvent("info", "probe_a"));
		run(logEvent("warn", "probe_b"));
		run(logEvent("error", "probe_c"));
		// Debug sits below Effect's default minimum log level, so the gate is
		// lowered explicitly: the filter belongs to the runtime, not to this logger.
		run(Effect.provideService(logEvent("debug", "probe_d"), References.MinimumLogLevel, "Debug"));
		expect(lines).toEqual([
			'{"at":"2026-10-12T00:00:00.000Z","level":"info","event":"probe_a"}\n',
			'{"at":"2026-10-12T00:00:00.000Z","level":"warn","event":"probe_b"}\n',
			'{"at":"2026-10-12T00:00:00.000Z","level":"error","event":"probe_c"}\n',
			'{"at":"2026-10-12T00:00:00.000Z","level":"debug","event":"probe_d"}\n',
		]);
	});
});

describe("field redaction (SEC-010)", () => {
	it("writes string, number, boolean and null field values", () => {
		const { lines, run } = collect();
		run(
			logEvent("info", "probe", {
				status: "available",
				retryInMs: 2000,
				isolated: true,
				reason: null,
			}),
		);
		expect(lines).toEqual([
			'{"at":"2026-10-12T00:00:00.000Z","level":"info","event":"probe","status":"available","retryInMs":2000,"isolated":true,"reason":null}\n',
		]);
	});

	it("drops object, array, undefined and Error values and counts them", () => {
		const { lines, run } = collect();
		run(
			Effect.annotateLogs(Effect.logInfo("hi"), {
				nested: { token: "secret" },
				list: [1, 2],
				missing: undefined,
				boom: new Error("secret detail"),
			}),
		);
		expect(lines).toEqual([
			'{"at":"2026-10-12T00:00:00.000Z","level":"info","event":"hi","redacted_fields":4}\n',
		]);
		expect(lines[0]).not.toContain("secret");
	});

	it("never lets fields overwrite the reserved at, level and event keys", () => {
		const { lines, run } = collect();
		run(
			Effect.annotateLogs(Effect.logInfo("real"), {
				at: "forged",
				level: "forged",
				event: "forged",
			}),
		);
		expect(lines).toEqual(['{"at":"2026-10-12T00:00:00.000Z","level":"info","event":"real"}\n']);
	});
});

describe("createEventLogger facade", () => {
	it("logs info, warn and error through the JSON logger", () => {
		const lines: string[] = [];
		const logger = createEventLogger((line) => {
			lines.push(line);
		}, FIXED_NOW);
		logger.info("started");
		logger.warn("slow", { retryInMs: 500 });
		logger.error("failed", { code: "CLAIM_FAILED" });
		expect(lines).toEqual([
			'{"at":"2026-10-12T00:00:00.000Z","level":"info","event":"started"}\n',
			'{"at":"2026-10-12T00:00:00.000Z","level":"warn","event":"slow","retryInMs":500}\n',
			'{"at":"2026-10-12T00:00:00.000Z","level":"error","event":"failed","code":"CLAIM_FAILED"}\n',
		]);
	});

	it("builds the logger once: fields still pass through on later calls", () => {
		const lines: string[] = [];
		const logger = createEventLogger((line) => {
			lines.push(line);
		});
		logger.info("first", { n: 1 });
		logger.info("second", { n: 2 });
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain('"event":"second","n":2');
	});

	it("silentEventLogger writes nothing and never throws", () => {
		// There is no sink to observe: silence is structural. Calling every
		// method must simply do nothing.
		silentEventLogger.info("probe_a", { n: 1 });
		silentEventLogger.warn("probe_b");
		silentEventLogger.error("probe_c", { code: "X" });
		expect(silentEventLogger.logFailures()).toBe(0);
	});
});

/** Parses one log line into a plain record without casts. */
function parseLine(line: string | undefined): Record<string, unknown> {
	if (line === undefined) throw new Error("expected a log line to be written");
	const parsed: unknown = JSON.parse(line);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("expected a log line object");
	}
	const record: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) record[key] = value;
	return record;
}

describe("event-name enforcement (A1-1)", () => {
	it("rejects strings that are not snake_case event names, recording only the kind", () => {
		const { lines, run } = collect();
		run(logEvent("info", "Job_Claimed"));
		run(logEvent("info", ""));
		run(logEvent("info", "9lives"));
		run(logEvent("info", "has space"));
		expect(lines).toHaveLength(4);
		for (const line of lines) {
			expect(parseLine(line)).toMatchObject({ event: "invalid_log_event", rejected: "string" });
			expect(line).not.toContain("Job_Claimed");
		}
	});

	it("rejects an Error message without writing its text", () => {
		const { lines, run } = collect();
		run(Effect.logError(new Error("secret detail")));
		expect(lines).toHaveLength(1);
		expect(parseLine(lines[0])).toMatchObject({ event: "invalid_log_event", rejected: "Error" });
		expect(lines[0]).not.toContain("secret");
	});

	it("rejects an object message without writing its content", () => {
		const { lines, run } = collect();
		run(Effect.logInfo({ event: "job_claimed", token: "rk_secret" }));
		expect(parseLine(lines[0])).toMatchObject({ event: "invalid_log_event", rejected: "object" });
		expect(lines[0]).not.toContain("rk_secret");
	});

	it("rejects several message parts and nested message arrays", () => {
		const { lines, run } = collect();
		run(Effect.logInfo("job_claimed", "extra part"));
		run(Effect.logInfo(["job_claimed"]));
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(parseLine(line)).toMatchObject({ event: "invalid_log_event", rejected: "array" });
		}
	});
});

describe("field-name and field-value enforcement (A1-1)", () => {
	it("drops token-shaped strings under sensitive keys and counts them", () => {
		const { lines, run } = collect();
		run(
			logEvent("info", "job_claimed", {
				token: "rk_secret_value",
				runnerToken: "rk_secret_value",
				authorization: "Bearer rk_secret_value",
				runId: "run_1",
			}),
		);
		expect(parseLine(lines[0])).toEqual({
			at: "2026-10-12T00:00:00.000Z",
			level: "info",
			event: "job_claimed",
			runId: "run_1",
			redacted_fields: 3,
		});
		expect(lines[0]).not.toContain("rk_secret_value");
	});

	it("drops every sensitive segment spelling, whatever the case or separator", () => {
		const { lines, run } = collect();
		run(
			logEvent("info", "job_claimed", {
				secret: "s",
				Password: "s",
				passwd: "s",
				COOKIE: "s",
				credential: "s",
				apiKey: "s",
				api_key: "s",
				Prompt: "s",
				content: "s",
				text: "s",
				body: "s",
				message: "s",
				stack: "s",
				quote: "s",
				excerpt: "s",
				keep: "yes",
			}),
		);
		expect(parseLine(lines[0])).toEqual({
			at: "2026-10-12T00:00:00.000Z",
			level: "info",
			event: "job_claimed",
			keep: "yes",
			redacted_fields: 15,
		});
	});

	it("keeps credentialId: it is an identifier, not the credential", () => {
		const { lines, run } = collect();
		run(logEvent("info", "credential_checked", { credentialId: "cred_1" }));
		expect(parseLine(lines[0])).toEqual({
			at: "2026-10-12T00:00:00.000Z",
			level: "info",
			event: "credential_checked",
			credentialId: "cred_1",
		});
	});

	it("drops a prompt, a multi-line stack and a 5,000-character value", () => {
		const { lines, run } = collect();
		run(
			logEvent("info", "job_claimed", {
				prompt: "Summarise this article: ...",
				stack: "Error: boom\n    at run (runner.ts:10:5)\n    at main (main.ts:2:1)",
				blob: "x".repeat(5000),
				attempt: 2,
			}),
		);
		const parsed = parseLine(lines[0]);
		expect(parsed.attempt).toBe(2);
		expect(parsed.redacted_fields).toBe(3);
		expect(lines[0]).not.toContain("Summarise");
		expect(lines[0]).not.toContain("runner.ts");
	});

	it(`writes strings of exactly ${MAX_LOG_FIELD_CHARS} characters, drops longer ones`, () => {
		const { lines, run } = collect();
		run(logEvent("info", "job_claimed", { ok: "x".repeat(MAX_LOG_FIELD_CHARS) }));
		expect(parseLine(lines[0]).ok).toBe("x".repeat(MAX_LOG_FIELD_CHARS));
		const second = collect();
		second.run(logEvent("info", "job_claimed", { tooLong: "x".repeat(MAX_LOG_FIELD_CHARS + 1) }));
		expect(parseLine(second.lines[0])).toEqual({
			at: "2026-10-12T00:00:00.000Z",
			level: "info",
			event: "job_claimed",
			redacted_fields: 1,
		});
	});

	it("drops an Error passed as a field without writing its message", () => {
		const { lines, run } = collect();
		run(
			Effect.annotateLogs(Effect.logInfo("job_crashed_probe"), {
				boom: new Error("secret detail"),
				code: "TRANSPORT_ERROR",
			}),
		);
		expect(parseLine(lines[0])).toEqual({
			at: "2026-10-12T00:00:00.000Z",
			level: "info",
			event: "job_crashed_probe",
			code: "TRANSPORT_ERROR",
			redacted_fields: 1,
		});
		expect(lines[0]).not.toContain("secret");
	});
});

describe("writer isolation (A1-2)", () => {
	it("a throwing writer never throws into the facade caller and is counted", () => {
		const logger = createEventLogger(() => {
			throw new Error("disk full");
		}, FIXED_NOW);
		expect(() => logger.info("job_claimed", { runId: "run_1" })).not.toThrow();
		logger.warn("claim_failed", { code: "SERVER_BUSY" });
		logger.error("job_crashed", { runId: "run_1" });
		expect(logger.logFailures()).toBe(3);
	});

	it("direct Effect.log* calls through a throwing logger do not throw", () => {
		const lines: string[] = [];
		const logger = makeJsonLogger(() => {
			throw new Error("disk full");
		}, FIXED_NOW);
		const run = (effect: Effect.Effect<void>): void => {
			Effect.runSync(Effect.provide(effect, Logger.layer([logger])));
		};
		expect(() => run(logEvent("info", "job_claimed"))).not.toThrow();
		expect(() => run(Effect.logError(new Error("secret")))).not.toThrow();
		expect(lines).toEqual([]);
	});

	it("writes one log_write_failed fallback line per minute, itself isolated", () => {
		let nowMs = Date.parse("2026-10-12T00:00:00.000Z");
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map((part) => String(part)).join(" "));
		};
		try {
			const logger = createEventLogger(
				() => {
					throw new Error("down");
				},
				() => new Date(nowMs),
			);
			logger.info("job_claimed");
			logger.info("job_claimed");
			expect(logger.logFailures()).toBe(2);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("log_write_failed");
			nowMs += 61_000;
			logger.info("job_claimed");
			expect(logger.logFailures()).toBe(3);
			expect(errors).toHaveLength(2);
		} finally {
			console.error = original;
		}
	});

	it("a failing fallback does not throw into the caller either", () => {
		const original = console.error;
		console.error = () => {
			throw new Error("console is down too");
		};
		try {
			const logger = createEventLogger(() => {
				throw new Error("down");
			}, FIXED_NOW);
			expect(() => logger.info("job_claimed")).not.toThrow();
			expect(logger.logFailures()).toBe(1);
		} finally {
			console.error = original;
		}
	});
});
