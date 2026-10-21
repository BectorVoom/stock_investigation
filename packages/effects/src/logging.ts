/**
 * Structured event logging on Effect (ADR-0007). This is the only logger
 * implementation in the repository: every runtime builds on `makeJsonLogger`
 * or the `createEventLogger` facade over it.
 */
import { Effect, Logger, type LogLevel, References } from "effect";

/**
 * Structured log fields. Identifiers, codes and counts only — never tokens,
 * prompts or retrieved content (SEC-010).
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface EventLogger {
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
	/**
	 * How many log lines the writer has failed to write since this logger was
	 * built. Logging never throws into its caller; a persistent writer failure
	 * is observable here (and through one throttled `log_write_failed` line).
	 */
	logFailures(): number;
}

/**
 * Event names are snake_case identifiers: a lowercase letter followed by 1-63
 * lowercase letters, digits or underscores. The length floor keeps one-letter
 * names (which are never real events) out of the log.
 */
export const LOG_EVENT_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * String field values longer than this, or spanning more than one line, are
 * never written. Identifiers, codes, model ids, short reasons and counts all
 * fit; prompts, page text and stack traces do not.
 */
export const MAX_LOG_FIELD_CHARS = 200;

/** Event recorded when a log call's message is not a valid event name. */
export const INVALID_LOG_EVENT = "invalid_log_event";

/**
 * Field-name segments (compared case-insensitively) that mark a field as
 * sensitive: the field is dropped and counted in `redacted_fields`. Matching
 * is per whole word or per `camelCase`/`snake_case`/`kebab-case` segment, so
 * `runnerToken` and `apiKey` are caught while `context` (one segment that
 * merely contains "text") is not.
 */
const SENSITIVE_FIELD_SEGMENTS: ReadonlySet<string> = new Set([
	"token",
	"secret",
	"password",
	"passwd",
	"authorization",
	"cookie",
	"credential",
	"apikey",
	"prompt",
	"content",
	"text",
	"body",
	"message",
	"stack",
	"quote",
	"excerpt",
]);

/** Splits a field name into lowercase segments on separators and case boundaries. */
function fieldSegments(name: string): string[] {
	return name
		.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
		.filter((segment) => segment !== "")
		.map((segment) => segment.toLowerCase());
}

/**
 * True when a field name denotes sensitive content. `credentialId` is spelled
 * out as the one exception: it names the stored credential row (an
 * identifier), it is not the credential itself, so it stays allowed.
 * `promptVersion` is the second exception: it carries only the short prompt
 * template version (e.g. `research-v4`, at most 40 chars per its contract),
 * never prompt text — the runner logs it on `job_finished` so removed
 * run-card facts stay observable in the logs without their content.
 */
function isSensitiveFieldName(name: string): boolean {
	const segments = fieldSegments(name);
	if (segments.length === 0) return false;
	if (segments.join("") === "credentialid") return false;
	if (segments.join("") === "promptversion") return false;
	return (
		segments.some((segment) => SENSITIVE_FIELD_SEGMENTS.has(segment)) ||
		SENSITIVE_FIELD_SEGMENTS.has(segments.join(""))
	);
}

/**
 * The kind of a rejected log message or field value — the type name only,
 * never any content, so recording it cannot leak what was passed.
 */
function kindOf(value: unknown): string {
	if (typeof value === "string") return "string";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "undefined") return "undefined";
	if (typeof value === "bigint") return "bigint";
	if (typeof value === "symbol") return "symbol";
	if (typeof value === "function") return "function";
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (value instanceof Error) {
		return value.constructor.name === "" ? "Error" : value.constructor.name;
	}
	return "object";
}

export interface SanitizedLogCall {
	/** The event to record, or `invalid_log_event` when the message was rejected. */
	readonly event: string;
	/** The fields safe to write. Never contains the rejected content. */
	readonly fields: Record<string, string | number | boolean | null>;
	/** How many annotation fields were dropped. */
	readonly redactedFields: number;
	/** The kind of the rejected message, when the event was rejected. */
	readonly rejectedKind: string | undefined;
}

/**
 * WHY one pure function: the content rule (SEC-010) must hold identically for
 * the facade and for direct `Effect.log*` calls, so both go through the
 * Effect `Logger` below, which is a thin wrapper around this function. It is
 * pure (no clock, no I/O), so the rule itself is unit-testable without Effect.
 *
 * - The message must be exactly one string part matching `LOG_EVENT_PATTERN`
 *   (Effect delivers every log call's message as an array of parts). Anything
 *   else — another string, an `Error`, an object, several parts — is NOT
 *   written: the event becomes `invalid_log_event` and `rejected` carries only
 *   the kind of thing that was passed, never its content.
 * - A field whose name is sensitive is dropped; a string value longer than
 *   `MAX_LOG_FIELD_CHARS` or containing a line break is dropped; any value of
 *   another type (objects, arrays, `Error`s, `undefined`) is dropped. Every
 *   dropped field is counted in `redacted_fields`.
 * - The keys `at`, `level` and `event` are reserved and never overwritten.
 *
 * What remains the caller's duty: a short code that happens to be sensitive
 * (a token under the key `code`, a one-line prompt under `reason`) cannot be
 * detected — keep secrets out of log calls by construction and log codes and
 * ids instead (ARCH-010, SEC-010).
 */
export function sanitizeLogCall(
	message: unknown,
	annotations: Readonly<Record<string, unknown>>,
): SanitizedLogCall {
	const parts: readonly unknown[] = Array.isArray(message) ? message : [message];
	const [only] = parts;
	let event: string;
	let rejectedKind: string | undefined;
	if (parts.length === 1 && typeof only === "string" && LOG_EVENT_PATTERN.test(only)) {
		event = only;
	} else {
		event = INVALID_LOG_EVENT;
		rejectedKind = parts.length === 1 ? kindOf(only) : "array";
	}
	const fields: Record<string, string | number | boolean | null> = {};
	let redactedFields = 0;
	for (const [key, value] of Object.entries(annotations)) {
		if (key === "at" || key === "level" || key === "event") continue;
		if (isSensitiveFieldName(key)) {
			redactedFields += 1;
			continue;
		}
		if (typeof value === "string") {
			if (value.length <= MAX_LOG_FIELD_CHARS && !value.includes("\n") && !value.includes("\r")) {
				fields[key] = value;
			} else {
				redactedFields += 1;
			}
			continue;
		}
		if (typeof value === "number" || typeof value === "boolean" || value === null) {
			fields[key] = value;
			continue;
		}
		redactedFields += 1;
	}
	if (rejectedKind !== undefined) fields.rejected = rejectedKind;
	if (redactedFields > 0) fields.redacted_fields = redactedFields;
	return { event, fields, redactedFields, rejectedKind };
}

/** Effect log levels mapped onto the flat `level` values the log line carries. */
function levelName(level: LogLevel.LogLevel): "debug" | "info" | "warn" | "error" {
	switch (level) {
		case "Trace":
		case "Debug":
			return "debug";
		case "Info":
			return "info";
		case "Warn":
			return "warn";
		case "Error":
		case "Fatal":
		case "All":
		case "None":
			return "error";
	}
}

/**
 * An Effect Logger that writes exactly one JSON line per log call:
 * `{ at, level, event, ...fields }`, where the event and fields are decided by
 * `sanitizeLogCall`, so the content rule holds for the facade and for direct
 * `Effect.log*` calls alike (SEC-010).
 *
 * The writer runs isolated: a throwing writer never throws into the log
 * caller. The failure is reported through `onWriteError` instead, so the
 * facade can count it (`logFailures`) and fall back to a throttled line.
 */
export function makeJsonLogger(
	write: (line: string) => void,
	now: () => Date = () => new Date(),
	onWriteError?: (error: unknown) => void,
): Logger.Logger<unknown, void> {
	return Logger.make<unknown, void>((options) => {
		const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
		const sanitized = sanitizeLogCall(options.message, annotations);
		const line: Record<string, string | number | boolean | null> = {
			at: now().toISOString(),
			level: levelName(options.logLevel),
			event: sanitized.event,
			...sanitized.fields,
		};
		try {
			write(`${JSON.stringify(line)}\n`);
		} catch (error) {
			onWriteError?.(error);
		}
	});
}

/**
 * Logs `event` at `level` through whatever logger is installed, with `fields`
 * carried as log annotations (so the JSON logger sanitizes them the same way).
 */
export function logEvent(
	level: "debug" | "info" | "warn" | "error",
	event: string,
	fields?: LogFields,
): Effect.Effect<void> {
	let base: Effect.Effect<void>;
	switch (level) {
		case "debug":
			base = Effect.logDebug(event);
			break;
		case "info":
			base = Effect.logInfo(event);
			break;
		case "warn":
			base = Effect.logWarning(event);
			break;
		case "error":
			base = Effect.logError(event);
			break;
	}
	if (fields === undefined) return base;
	return Effect.annotateLogs(base, { ...fields });
}

/** At most one fallback line per minute, however often the writer fails. */
const LOG_WRITE_FALLBACK_INTERVAL_MS = 60_000;

/**
 * Synchronous facade for call sites that are not Effect programs. The logger
 * and its layer are built once here, not once per log line. Logging never
 * throws: a failing writer is counted (`logFailures`) and reported through
 * one short `log_write_failed` line on `console.error` at most once per
 * minute, itself isolated.
 */
export function createEventLogger(
	write: (line: string) => void,
	now: () => Date = () => new Date(),
): EventLogger {
	let failures = 0;
	let lastFallbackAtMs = Number.NEGATIVE_INFINITY;
	const jsonLogger = Logger.layer([
		makeJsonLogger(write, now, () => {
			failures += 1;
			const atMs = now().getTime();
			if (atMs - lastFallbackAtMs < LOG_WRITE_FALLBACK_INTERVAL_MS) return;
			lastFallbackAtMs = atMs;
			try {
				console.error(
					JSON.stringify({ at: now().toISOString(), level: "error", event: "log_write_failed" }),
				);
			} catch {
				// The fallback is best-effort observability only; a detached log
				// call has nowhere to report its own failure beyond the counter.
			}
		}),
	]);
	const run = (effect: Effect.Effect<void>): void => {
		Effect.runSync(Effect.provide(effect, jsonLogger));
	};
	return {
		info: (event, fields) => run(logEvent("info", event, fields)),
		warn: (event, fields) => run(logEvent("warn", event, fields)),
		error: (event, fields) => run(logEvent("error", event, fields)),
		logFailures: () => failures,
	};
}

export const silentEventLogger: EventLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	logFailures: () => 0,
};

/**
 * Runs one log call so that it can never throw into its caller. Used where a
 * boundary must still answer, or a detached chain must not reject, even when
 * an `EventLogger` implementation throws: the HTTP boundaries (`respond`,
 * `app.onError`) and the runner's heartbeat. `createEventLogger` itself never
 * throws (it counts writer failures in `logFailures`), but `EventLogger` is an
 * interface and these call sites must hold for every implementation.
 */
export function logIsolated(log: () => void): void {
	try {
		log();
	} catch {
		// Nowhere left to report it: the caller's answer matters more than the line.
	}
}
