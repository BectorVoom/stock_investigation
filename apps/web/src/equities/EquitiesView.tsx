import { useMessages } from "@research/i18n/solid";
import type { JSX } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { equitiesMessages } from "./equities.messages.ts";

/**
 * The Equities page (ADR-0045): tracked companies, their sync status and
 * their annual statements, all read from the database. Seam placeholder —
 * the page body is built on top of this in the same change.
 */
export function EquitiesView(_props: { readonly api: ApiClient }): JSX.Element {
	const m = useMessages(equitiesMessages);
	return (
		<section aria-labelledby="equities-title" class="flex flex-col gap-4">
			<h1 id="equities-title" class="text-xl font-semibold">
				{m().title}
			</h1>
			<p class="text-sm text-slate-600">{m().description}</p>
		</section>
	);
}
