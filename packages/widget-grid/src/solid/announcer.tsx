import { type Accessor, createSignal, type JSX, onCleanup } from "solid-js";
import { useWidgetGridStrings } from "./strings.tsx";

/**
 * The polite announcement for every completed move (drag or menu).
 * Every completed move announces, even when the sentence repeats the
 * previous one (a live region sets nothing when the same text is set
 * twice): the text is cleared first and the message is set on a later
 * task, so assistive technology observes a change each time. The sentence
 * comes from the host's `WidgetGridStrings` (English by default).
 */
export interface MoveAnnouncer {
	readonly message: Accessor<string>;
	readonly announceMove: (title: string, position: number, total: number) => void;
}

export function createMoveAnnouncer(): MoveAnnouncer {
	const strings = useWidgetGridStrings();
	const [message, setMessage] = createSignal("");
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const announceMove = (title: string, position: number, total: number): void => {
		const text = strings().moveAnnouncement(title, position, total);
		setMessage("");
		window.setTimeout(() => {
			if (!disposed) setMessage(text);
		}, 0);
	};
	return { message, announceMove };
}

/**
 * The visually hidden polite live region that speaks completed moves.
 * The hidden style comes from the package stylesheet (`wg-visually-hidden`),
 * never a host utility.
 */
export function MoveAnnouncerView(props: { readonly message: string }): JSX.Element {
	return (
		<output class="wg-visually-hidden" aria-live="polite">
			{props.message}
		</output>
	);
}
