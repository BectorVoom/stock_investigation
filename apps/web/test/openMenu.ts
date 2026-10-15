import { screen } from "@solidjs/testing-library";

/**
 * The most recently opened `ActionMenu`: open menus render in a portal at the
 * end of <body> (not inside their widget), and `fireEvent.click` sends no
 * `pointerdown`, so an earlier menu may still be open before it.
 */
export function lastOpenMenu(): HTMLElement {
	const menu = screen.getAllByRole("menu").at(-1);
	if (menu === undefined) throw new Error("no open menu");
	return menu;
}
