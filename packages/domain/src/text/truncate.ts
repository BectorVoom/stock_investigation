/**
 * Cut text to a character budget without splitting a surrogate pair.
 *
 * Shared single copy (ARCH-013): the research tools and the conversation
 * context builder both reuse this rather than keeping two implementations.
 * Result length never exceeds `maxLength`.
 */
export function truncateText(text: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	if (text.length <= maxLength) return text;
	let kept = "";
	for (const character of text) {
		if (kept.length + character.length > maxLength - 1) break;
		kept += character;
	}
	return `${kept}…`;
}
