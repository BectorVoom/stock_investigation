import type { StockProfileResponse } from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { createEffect, For, type JSX, onCleanup, Show } from "solid-js";
import { ErrorNotice, HEADING, Loading } from "../components/ui.tsx";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import { stockProfileEntryFor } from "./stockReads.ts";
import { stocksMessages } from "./stocks.messages.ts";
import type { StockTabProps } from "./stockTabs.ts";

/** One term and its description in a description list. */
function Item(props: { readonly term: string; readonly children: JSX.Element }): JSX.Element {
	return (
		<div class="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-x-3 border-b border-slate-100 py-1">
			<dt class="text-xs font-medium text-slate-700">{props.term}</dt>
			<dd class="min-w-0 break-words text-sm text-slate-900">{props.children}</dd>
		</div>
	);
}

/** A value that is missing says why, in the shared unavailable style (never blank, never 0). */
function Missing(props: { readonly children: string }): JSX.Element {
	return (
		<span class="text-xs italic text-slate-600" data-unavailable="true">
			{props.children}
		</span>
	);
}

/**
 * The Company tab (ADR-0049 §6): the stock's stored listing as a
 * description list. The read attaches only while the tab is shown (rule 4).
 */
export function CompanyTab(props: StockTabProps): JSX.Element {
	const s = useMessages(stocksMessages);
	const profile = stockProfileEntryFor(props.api, props.stock().stockId);
	createEffect(() => {
		if (props.active()) onCleanup(profile.attach(props.visibility));
	});
	return (
		<div class="space-y-4" data-field="stock-company-tab">
			<ListingGroup {...props} profile={profile.value()} failed={profile.failure() !== null} />
			<Show when={profile.failure()}>
				{(error) => (
					<ErrorNotice
						failure={error()}
						title={s().profileFailed}
						onRetry={() => profile.refresh()}
					/>
				)}
			</Show>
		</div>
	);
}

function ListingGroup(
	props: StockTabProps & {
		readonly profile: StockProfileResponse | undefined;
		/** The profile read failed (the tab states the failure below). */
		readonly failed: boolean;
	},
): JSX.Element {
	const s = useMessages(stocksMessages);
	const model = useMessages(watchlistModelMessages);
	const locale = useLocale();
	const directory = () => props.profile?.directory ?? null;
	/** The UI language's name first; a Japanese name only for a Japanese listing. */
	const names = (): readonly { readonly term: string; readonly value: string | null }[] => {
		const entry = directory();
		const english = { term: s().nameEnglish, value: entry?.name ?? null };
		if (props.stock().market !== "JP") return [english];
		const japanese = { term: s().nameJapanese, value: entry?.localName ?? null };
		return locale() === "ja" ? [japanese, english] : [english, japanese];
	};
	return (
		<section aria-label={s().listingHeading} data-field="company-listing">
			<h4 class={HEADING}>{s().listingHeading}</h4>
			<Show
				when={props.profile !== undefined}
				fallback={
					<Show when={!props.failed}>
						<Loading label={s().profileThing} />
					</Show>
				}
			>
				<Show when={directory() === null}>
					<p class="mt-1 text-sm text-slate-800" data-field="not-in-directory">
						{s().notInDirectory}
					</p>
				</Show>
			</Show>
			<dl class="mt-1">
				<Show when={directory() !== null}>
					<For each={names()}>
						{(name) => (
							<Item term={name.term}>
								<Show when={name.value} fallback={<Missing>{s().notKnownYet}</Missing>}>
									{(value) => value()}
								</Show>
							</Item>
						)}
					</For>
				</Show>
				<Item term={s().symbol}>
					<span class="font-mono">{props.stock().symbol}</span>
				</Item>
				<Item term={s().market}>{model().marketName(props.stock().market)}</Item>
				<Item term={s().listing}>
					<Show
						when={directory()}
						fallback={
							<Missing>
								{props.profile === undefined ? s().notKnownYet : s().notInDirectory}
							</Missing>
						}
					>
						{(entry) => model().listingName(entry().listing)}
					</Show>
				</Item>
				<Item term={s().stockId}>
					<span class="font-mono">{props.stock().stockId}</span>
				</Item>
			</dl>
		</section>
	);
}
