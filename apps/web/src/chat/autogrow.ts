/**
 * Script fallback for the composer's auto-growing input.
 *
 * WHY: the textarea grows through CSS `field-sizing: content` (Tailwind
 * `field-sizing-content`), which only Chromium implements among the
 * supported browsers — Firefox and Safari ignore it and the input would stay
 * one line tall. Where `CSS.supports("field-sizing", "content")` is false,
 * this module grows the element with script instead: the height is set from
 * its `scrollHeight` through the CSSOM (`element.style.height`, which the
 * Content-Security-Policy allows — a literal style attribute in markup would
 * not be, and the design conformance test forbids one in JSX), capped at the
 * element's own CSS maximum (`max-h-48`), and shrinks back when the text is
 * cleared. The CSS path stays untouched for engines that have it; this is
 * the one script implementation, used in one place (`Composer`).
 */

/** Fallback cap when the element's own CSS maximum cannot be read: `max-h-48` at the default root size. */
const FALLBACK_MAX_HEIGHT_PX = 192;

/** Whether this engine grows the input through CSS alone, needing no script. */
export function supportsFieldSizing(): boolean {
	try {
		return (
			typeof CSS !== "undefined" &&
			typeof CSS.supports === "function" &&
			CSS.supports("field-sizing", "content")
		);
	} catch {
		return false;
	}
}

function maxHeightPx(element: HTMLTextAreaElement): number {
	const parsed = Number.parseFloat(getComputedStyle(element).maxHeight);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_MAX_HEIGHT_PX;
}

/**
 * Fits the element to its content, capped at its CSS maximum. Call after the
 * value changed (input, suggestion fill, send clear): with an empty value
 * `scrollHeight` is one row, so clearing the text resets the height.
 */
export function fitTextarea(element: HTMLTextAreaElement): void {
	const cap = maxHeightPx(element);
	element.style.height = "auto";
	element.style.height = `${Math.min(element.scrollHeight, cap)}px`;
}
