import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { createMoveAnnouncer, MoveAnnouncerView } from "../../src/solid/announcer.tsx";

afterEach(() => cleanup());

describe("move announcer", () => {
	it("announces a completed move with its position", async () => {
		const Host = () => {
			const announcer = createMoveAnnouncer();
			return (
				<>
					<button type="button" onClick={() => announcer.announceMove("Gold", 1, 7)}>
						move
					</button>
					<MoveAnnouncerView message={announcer.message()} />
				</>
			);
		};
		render(() => <Host />);
		screen.getByRole("button", { name: "move" }).click();
		const live = screen.getByRole("status", { hidden: true }) as HTMLElement;
		// The live region itself is the output; fall back to the polite output.
		const output =
			document.querySelector("output[aria-live='polite']") instanceof HTMLElement
				? (document.querySelector("output[aria-live='polite']") as HTMLElement)
				: live;
		await waitFor(() => expect(output.textContent).toBe("Moved “Gold” to position 1 of 7."));
	});

	it("announces a repeated sentence again", async () => {
		const Host = () => {
			const announcer = createMoveAnnouncer();
			return (
				<>
					<button type="button" onClick={() => announcer.announceMove("Gold", 1, 7)}>
						again
					</button>
					<MoveAnnouncerView message={announcer.message()} />
				</>
			);
		};
		render(() => <Host />);
		const button = screen.getByRole("button", { name: "again" });
		const live = (): string =>
			document.querySelector("output[aria-live='polite']")?.textContent ?? "missing";
		button.click();
		await waitFor(() => expect(live()).toBe("Moved “Gold” to position 1 of 7."));
		// The same sentence twice in a row would announce nothing if the text
		// were set directly: the announcer clears first and sets on a later
		// task, so it announces again.
		button.click();
		await waitFor(() => expect(live()).toBe(""));
		await waitFor(() => expect(live()).toBe("Moved “Gold” to position 1 of 7."));
	});
});
