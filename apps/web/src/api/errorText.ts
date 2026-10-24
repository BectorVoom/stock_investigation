import { type ApiErrorCode, apiErrorCodeSchema } from "@research/contracts";
import type { Locale, MessagesOf } from "@research/i18n";
import { apiErrorMessages, clientFailureMessages } from "./errors.messages.ts";
import { CLIENT_ERROR_CODES } from "./http.ts";

/** The two fields of a failure that say what went wrong. */
export interface FailureText {
	readonly code: string;
	readonly message: string;
}

type ClientFailureText = MessagesOf<typeof clientFailureMessages>;

/** Compile-time check: every API error code has a description in every language. */
const API_ERROR_TABLES: { readonly [L in Locale]: { readonly [C in ApiErrorCode]: string } } =
	apiErrorMessages;

/**
 * What a failure says in `locale` (ADR-0031 decision 8), or null when its own
 * `message` is to be shown as it is:
 *  - an API error code → the description of the code (the server's English
 *    message stays the data);
 *  - one of the client's own sentences (`clientFailureMessages.en`) → the
 *    same sentence in `locale`, with its values (seconds, status, cause);
 *  - anything else (an unknown code, or a client code whose message the
 *    caller wrote itself in the UI language) → null.
 * English always gets null: the UI shows the message exactly as before.
 */
export function translatedFailureMessage(failure: FailureText, locale: Locale): string | null {
	if (locale === "en") return null;
	const api = apiErrorCodeSchema.safeParse(failure.code);
	if (api.success) return API_ERROR_TABLES[locale][api.data];
	if (!CLIENT_ERROR_CODES.some((code) => code === failure.code)) return null;
	return translatedClientSentence(failure.message, clientFailureMessages[locale]);
}

/** The failure's message in `locale`: the translation when there is one, else the message itself. */
export function failureMessageIn(failure: FailureText, locale: Locale): string {
	return translatedFailureMessage(failure, locale) ?? failure.message;
}

function translatedClientSentence(message: string, text: ClientFailureText): string | null {
	const en = clientFailureMessages.en;
	if (message === en.requestInvalid) return text.requestInvalid;
	if (message === en.responseInvalid) return text.responseInvalid;
	if (message === en.responseNotJson) return text.responseNotJson;
	const status = readNumber(message, en.unexpectedStatus);
	if (status !== null) return text.unexpectedStatus(status);
	const seconds = readNumber(message, en.timeout);
	if (seconds !== null) return text.timeout(seconds);
	const requestCause = readText(message, en.requestFailed);
	if (requestCause !== null) return text.requestFailed(requestCause);
	const responseCause = readText(message, en.responseIncomplete);
	if (responseCause !== null) return text.responseIncomplete(responseCause);
	const markdown = readContentType(message, en.markdownContentType);
	if (markdown !== null) return text.markdownContentType(markdown);
	const calendar = readContentType(message, en.calendarContentType);
	if (calendar !== null) return text.calendarContentType(calendar);
	return null;
}

/** A value that cannot occur in a client sentence, to find where the sentence holds its value. */
const TEXT_PROBE = "\u0000";
const NUMBER_PROBE = 987_654_321;

/**
 * The value `build` placed in `message`, or null when `message` is not a
 * sentence `build` makes. Read back by building the sentence around a probe
 * and checking the round trip, so the parser cannot drift from the wording.
 */
function readText(message: string, build: (value: string) => string): string | null {
	const [prefix, suffix, ...rest] = build(TEXT_PROBE).split(TEXT_PROBE);
	if (prefix === undefined || suffix === undefined || rest.length > 0) return null;
	if (message.length < prefix.length + suffix.length) return null;
	if (!message.startsWith(prefix) || !message.endsWith(suffix)) return null;
	const value = message.slice(prefix.length, message.length - suffix.length);
	return build(value) === message ? value : null;
}

function readNumber(message: string, build: (value: number) => string): number | null {
	const [prefix, suffix, ...rest] = build(NUMBER_PROBE).split(String(NUMBER_PROBE));
	if (prefix === undefined || suffix === undefined || rest.length > 0) return null;
	if (message.length < prefix.length + suffix.length) return null;
	if (!message.startsWith(prefix) || !message.endsWith(suffix)) return null;
	const digits = message.slice(prefix.length, message.length - suffix.length);
	if (!/^\d+$/.test(digits)) return null;
	const value = Number(digits);
	return build(value) === message ? value : null;
}

/** A content-type sentence: "" when the response had no Content-Type. */
function readContentType(message: string, build: (received: string) => string): string | null {
	if (build("") === message) return "";
	return readText(message, build);
}
