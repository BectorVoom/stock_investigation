/**
 * Read-only helpers over the plain-object tree fast-xml-parser produces. The
 * tree is untrusted and untyped, so every access goes through a type guard;
 * nothing here assumes a particular document shape.
 */
export const ATTRIBUTE_PREFIX = "@_";
export const TEXT_KEY = "#text";
export const CDATA_KEY = "#cdata";

export type XmlNode = { readonly [key: string]: unknown };

export function isXmlNode(value: unknown): value is XmlNode {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

/** All children with any of the given element names, in name order then document order. */
export function childrenOf(node: XmlNode, names: readonly string[]): readonly unknown[] {
	return names.flatMap((name) => (Object.hasOwn(node, name) ? asArray(node[name]) : []));
}

export function firstChildOf(node: XmlNode, names: readonly string[]): unknown {
	return childrenOf(node, names)[0];
}

export function firstNodeOf(node: XmlNode, names: readonly string[]): XmlNode | null {
	return childrenOf(node, names).find(isXmlNode) ?? null;
}

const PREDEFINED_ENTITIES: { readonly [name: string]: string } = {
	lt: "<",
	gt: ">",
	amp: "&",
	quot: '"',
	apos: "'",
};

function isXmlCharacter(codePoint: number): boolean {
	if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return false;
	return codePoint < 0xd800 || codePoint > 0xdfff;
}

/**
 * Decodes the five predefined XML entities and numeric character references in
 * ONE non-recursive pass. Entity processing is switched off in the parser so a
 * DTD can never define or expand anything (no billion-laughs, no XXE); custom
 * references such as "&lol;" are therefore left as the inert literal text.
 */
export function decodeXmlText(text: string): string {
	return text.replace(
		/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g,
		(match, body: string) => {
			if (!body.startsWith("#")) return PREDEFINED_ENTITIES[body] ?? match;
			const isHex = body[1] === "x";
			const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
			return isXmlCharacter(codePoint) ? String.fromCodePoint(codePoint) : "";
		},
	);
}

/** Entity-decoded attribute value, or null when the attribute is absent. */
export function attributeOf(node: XmlNode, name: string): string | null {
	const key = `${ATTRIBUTE_PREFIX}${name}`;
	const value = Object.hasOwn(node, key) ? node[key] : undefined;
	return typeof value === "string" ? decodeXmlText(value) : null;
}

function collectText(value: unknown, parts: string[], budget: { remaining: number }): void {
	if (budget.remaining <= 0) return;
	if (typeof value === "string") {
		parts.push(decodeXmlText(value));
		budget.remaining -= value.length;
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectText(entry, parts, budget);
		return;
	}
	if (!isXmlNode(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (key.startsWith(ATTRIBUTE_PREFIX)) continue;
		if (key === CDATA_KEY) {
			// CDATA is literal character data: it must not be entity-decoded a second time.
			for (const section of asArray(child)) {
				if (typeof section === "string") {
					parts.push(section);
					budget.remaining -= section.length;
				}
			}
			continue;
		}
		collectText(child, parts, budget);
	}
}

/**
 * Character data of an element as one string, or null when it has none.
 * Nested markup (e.g. Atom `type="xhtml"` content) is flattened to its text;
 * recursion depth is bounded by the parser's `maxNestedTags`.
 */
export function textOf(value: unknown, maxLength: number): string | null {
	const parts: string[] = [];
	collectText(value, parts, { remaining: maxLength });
	const text = parts.join(" ").trim();
	if (text === "") return null;
	return text.length > maxLength ? text.slice(0, maxLength) : text;
}
