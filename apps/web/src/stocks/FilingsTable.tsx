import type { EquityFilingListItem } from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { For, type JSX, Show } from "solid-js";
import { equitiesMessages } from "../equities/equities.messages.ts";
import { formatPeriodEnd } from "../equities/financialFormat.ts";
import { financialsMessages } from "../equities/financials.messages.ts";

/**
 * Every stored filing of one company (the filings read), newest first:
 * form, dates, standard, the original an amendment replaces, what the sync
 * read from it (pending, read with its value count, or no machine-readable
 * values) and a link to the source document. Independent of the statement
 * switch: it lists superseded originals and filings without values too.
 */
export function FilingsTable(props: {
	readonly filings: readonly EquityFilingListItem[];
}): JSX.Element {
	const m = useMessages(equitiesMessages);
	const f = useMessages(financialsMessages);
	const locale = useLocale();
	return (
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-left text-sm" data-field="filings">
				<caption class="sr-only">{m().filingsCaption}</caption>
				<thead>
					<tr class="border-b border-slate-200 text-xs text-slate-700">
						<th scope="col" class="py-1 pr-2 font-medium">
							{m().form}
						</th>
						<th scope="col" class="py-1 pr-2 font-medium">
							{m().filed}
						</th>
						<th scope="col" class="py-1 pr-2 font-medium">
							{m().periodEnd}
						</th>
						<th scope="col" class="py-1 pr-2 font-medium">
							{m().standard}
						</th>
						<th scope="col" class="py-1 pr-2 font-medium">
							{m().amendment}
						</th>
						<th scope="col" class="py-1 pr-2 font-medium">
							{m().factsColumn}
						</th>
						<th scope="col" class="py-1 font-medium">
							{m().link}
						</th>
					</tr>
				</thead>
				<tbody>
					<For each={props.filings}>
						{(filing) => (
							<tr
								class="border-b border-slate-200 align-top"
								data-filing-id={filing.filingId}
								data-facts-status={filing.factsStatus}
							>
								<th scope="row" class="py-1 pr-2 font-normal">
									{f().form(filing.form)}
								</th>
								<td class="py-1 pr-2 whitespace-nowrap">{filing.filedOn}</td>
								<td class="py-1 pr-2 whitespace-nowrap">
									{formatPeriodEnd(filing.periodEnd, locale())}
								</td>
								<td class="py-1 pr-2">
									<Show
										when={filing.accountingStandard}
										fallback={
											<span class="text-xs italic text-slate-600">{m().standardUnknown}</span>
										}
									>
										{(standard) => f().standard(standard())}
									</Show>
								</td>
								<td class="py-1 pr-2" data-field="filing-amendment">
									<Show when={filing.isAmendment} fallback={m().original}>
										<Show when={filing.amendsSourceDocumentId} fallback={m().isAmendment}>
											{(original) => (
												<span class="font-mono text-xs">{m().amendsDocument(original())}</span>
											)}
										</Show>
									</Show>
								</td>
								<td class="py-1 pr-2 text-xs" data-field="filing-facts">
									<span
										classList={{
											"text-slate-800": filing.factsStatus === "extracted",
											"italic text-slate-600": filing.factsStatus !== "extracted",
										}}
									>
										{m().factsStatus(filing.factsStatus)}
									</span>
									<Show when={filing.factsStatus === "extracted"}>
										<span class="block text-2xs text-slate-600">
											{m().factCount(filing.factCount)}
										</span>
									</Show>
								</td>
								<td class="py-1">
									<SafeLink
										url={filing.sourceUrl}
										label={f().openFiling(filing.provider, f().form(filing.form), filing.filedOn)}
									>
										{m().openFiling}
									</SafeLink>
								</td>
							</tr>
						)}
					</For>
				</tbody>
			</table>
		</div>
	);
}
