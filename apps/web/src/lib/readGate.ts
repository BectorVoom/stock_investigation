/**
 * Orders asynchronous reads against mutations, so a response that was already
 * in flight can never replace state that is newer than the request it answers.
 *
 * Every read takes a ticket when it is sent. A read's result may be applied
 * only if (a) no mutation has been accepted since it was sent — otherwise it
 * describes the world before that mutation — and (b) no read sent later has
 * already been applied. Tickets come from one monotonically increasing clock,
 * so "sent before" is a plain number comparison.
 */
export interface ReadGate {
	/** Call when a read request is sent; keep the ticket until its response arrives. */
	readonly begin: () => number;
	/** Call when the server has accepted a mutation: every read sent before now is stale. */
	readonly invalidate: () => void;
	/**
	 * Call once when a read's response arrives. Returns whether its result may
	 * be applied, and records it as applied when it may.
	 */
	readonly admit: (ticket: number) => boolean;
}

export function createReadGate(): ReadGate {
	let clock = 0;
	let lastMutation = 0;
	let newestApplied = 0;
	return {
		begin: () => {
			clock += 1;
			return clock;
		},
		invalidate: () => {
			clock += 1;
			lastMutation = clock;
		},
		admit: (ticket) => {
			if (ticket < lastMutation || ticket < newestApplied) return false;
			newestApplied = ticket;
			return true;
		},
	};
}
