import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { ApiFailure, ApiResult } from "../api/http.ts";

/** Loading / error / ready, so no view can forget one of the three (never a blank screen). */
export type Remote<T> =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly error: ApiFailure }
	| { readonly status: "ready"; readonly value: T };

export interface RemoteResource<T> {
	readonly state: Accessor<Remote<T>>;
	/** The last successfully loaded value, kept visible while a reload is in flight. */
	readonly value: Accessor<T | null>;
	readonly reload: () => Promise<void>;
	/** Replaces the value with one the server just returned from a write. */
	readonly set: (value: T) => void;
}

/**
 * Loads once on creation. Must be called under a Solid owner; responses that
 * arrive after disposal or after a newer reload are ignored.
 */
export function createRemote<T>(fetcher: () => Promise<ApiResult<T>>): RemoteResource<T> {
	const [state, setState] = createSignal<Remote<T>>({ status: "loading" });
	const [value, setValue] = createSignal<T | null>(null);
	let latestRequest = 0;
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	const reload = async (): Promise<void> => {
		latestRequest += 1;
		const request = latestRequest;
		if (value() === null) setState({ status: "loading" });
		const result = await fetcher();
		if (disposed || request !== latestRequest) return;
		if (result.ok) {
			setValue(() => result.value);
			setState({ status: "ready", value: result.value });
		} else {
			setState({ status: "error", error: result.error });
		}
	};
	void reload();

	return {
		state,
		value,
		reload,
		set: (next) => {
			latestRequest += 1;
			setValue(() => next);
			setState({ status: "ready", value: next });
		},
	};
}
