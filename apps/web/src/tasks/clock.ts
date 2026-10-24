import { type Accessor, createSignal, onCleanup } from "solid-js";

/**
 * The current time, re-read every `intervalMs` while the owner is mounted,
 * so relative lines ("Next run in 5 min") stay true between polls. Must be
 * called under a Solid owner.
 */
export function createClock(intervalMs = 30_000): Accessor<number> {
	const [now, setNow] = createSignal(Date.now());
	const timer = setInterval(() => setNow(Date.now()), intervalMs);
	onCleanup(() => clearInterval(timer));
	return now;
}
