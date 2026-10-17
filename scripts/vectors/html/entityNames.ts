/**
 * Every named character reference in entities 8.1.0's HTML decode trie,
 * found by walking the trie with the package's own streaming decoder: a
 * prefix is alive while the decoder still waits for more input (`write`
 * returns -1); an alive prefix is a name when `&name;` decodes.
 */
import { DecodingMode, EntityDecoder, htmlDecodeTree } from "./htmlparser2.ts";

const NAME_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function isAlive(prefix: string): boolean {
	const decoder = new EntityDecoder(htmlDecodeTree, () => {});
	decoder.startEntity(DecodingMode.Strict);
	return decoder.write(prefix, 0) === -1;
}

function decodesWithSemicolon(name: string): boolean {
	let emitted = false;
	const decoder = new EntityDecoder(htmlDecodeTree, () => {
		emitted = true;
	});
	decoder.startEntity(DecodingMode.Strict);
	return decoder.write(`${name};`, 0) > 0 && emitted;
}

export function entityNames(): string[] {
	const names: string[] = [];
	const pending: string[] = [];
	for (const character of NAME_CHARACTERS) {
		if (isAlive(character)) pending.push(character);
	}
	while (pending.length > 0) {
		const prefix = pending.pop();
		if (prefix === undefined) break;
		if (decodesWithSemicolon(prefix)) names.push(prefix);
		for (const character of NAME_CHARACTERS) {
			const longer = prefix + character;
			if (isAlive(longer)) pending.push(longer);
		}
	}
	return names.sort();
}
