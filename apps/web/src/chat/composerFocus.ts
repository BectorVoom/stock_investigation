/**
 * Focusing the question input after a new chat opens (FR: chat). Both the
 * mount effect (`OpenWorkspace`) and the retry fallback (`ChatView`) move
 * focus, and both must never steal focus the owner has since taken: the chat
 * rename input saves on blur, so stealing focus out of it submits an
 * unchanged title and closes the input before it can be used.
 */

/**
 * Whether the composer may take focus from `active`: true on a neutral
 * target (nothing focused, or a button such as the just-clicked New chat
 * button), false when the owner is working somewhere else — a text control,
 * an open menu, or a dialog.
 */
export function mayFocusComposer(active: Element | null): boolean {
	if (active === null || active === document.body) return true;
	if (!(active instanceof HTMLElement)) return false;
	if (
		active instanceof HTMLInputElement ||
		active instanceof HTMLTextAreaElement ||
		active instanceof HTMLSelectElement ||
		active.isContentEditable
	) {
		return false;
	}
	if (active.closest('[role="menu"], [role="dialog"], dialog') !== null) return false;
	return true;
}

/**
 * Focuses the question input unless the owner has taken focus elsewhere.
 * True when the composer holds focus afterwards (or already did).
 */
export function focusComposerBox(): boolean {
	const box = document.querySelector('form[aria-label="Research composer"] textarea');
	if (!(box instanceof HTMLElement)) return false;
	if (document.activeElement === box) return true;
	if (!mayFocusComposer(document.activeElement)) return false;
	box.focus();
	return true;
}
