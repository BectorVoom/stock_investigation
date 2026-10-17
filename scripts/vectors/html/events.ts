/**
 * Records htmlparser2's callbacks for one document, with exactly the handler
 * set and options the converter registers (`onopentag`, `ontext`,
 * `onclosetag`, `oncomment`; `decodeEntities: true`; one `write` + `end`) —
 * the set matters, because the parser only builds attributes and emits void
 * closes when those handlers exist.
 *
 * Encoding: `["o", name, [[key, value], …]]`, `["t", text]`,
 * `["c", name, implied]`, `["m", comment]`. Text is made well-formed: an
 * astral named entity arrives as two lone-surrogate chunks, which the Rust
 * port represents as two U+FFFD chunks (ADR-0030).
 */
import { wellFormed } from "../shared.ts";
import { Parser } from "./htmlparser2.ts";

export type ParserEvent =
	| readonly ["o", string, readonly (readonly [string, string])[]]
	| readonly ["t", string]
	| readonly ["c", string, boolean]
	| readonly ["m", string];

export function recordEvents(html: string): ParserEvent[] {
	const events: ParserEvent[] = [];
	const parser = new Parser(
		{
			onopentag: (name, attribs) => {
				events.push([
					"o",
					wellFormed(name),
					Object.entries(attribs).map(
						([key, value]) => [wellFormed(key), wellFormed(value)] as const,
					),
				]);
			},
			ontext: (text) => {
				events.push(["t", wellFormed(text)]);
			},
			onclosetag: (name, implied) => {
				events.push(["c", wellFormed(name), implied]);
			},
			oncomment: (comment) => {
				events.push(["m", wellFormed(comment)]);
			},
		},
		{ decodeEntities: true },
	);
	parser.write(html);
	parser.end();
	return events;
}
