import type {
	EquityBusinessParagraph,
	EquityBusinessSource,
	StockBusiness,
	StockProfileResponse,
	StockTab,
} from "@research/contracts";
import { businessSummaryCount } from "@research/domain";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import {
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { ErrorNotice, HEADING, Loading } from "../components/ui.tsx";
import { formatPeriodEnd } from "../equities/financialFormat.ts";
import { TASK_LINK } from "../tasks/TaskParts.tsx";
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

/** What the Company tab gets besides every tab's props. */
export interface CompanyTabProps extends StockTabProps {
	/** Shows another tab of this stock (the Business group's way to Financial statements). */
	readonly showTab: (tab: StockTab) => void;
}

/**
 * The Company tab (ADR-0049 §6, ADR-0053 §6): the stock's stored listing as
 * a description list, then its business description from the newest annual
 * report. One read (the profile) serves both; it attaches only while the
 * tab is shown (rule 4).
 */
export function CompanyTab(props: CompanyTabProps): JSX.Element {
	const s = useMessages(stocksMessages);
	const profile = stockProfileEntryFor(props.api, props.stock().stockId);
	createEffect(() => {
		if (props.active()) onCleanup(profile.attach(props.visibility));
	});
	return (
		<div class="space-y-4" data-field="stock-company-tab">
			<ListingGroup {...props} profile={profile.value()} failed={profile.failure() !== null} />
			{/* While loading or failed the Business group shows nothing: the listing says it. */}
			<Show when={profile.value()?.business}>
				{(business) => <BusinessGroup business={business()} showTab={props.showTab} />}
			</Show>
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

/** Body text of the Business group: the app's size, a comfortable reading measure. */
const BUSINESS_TEXT = "max-w-[70ch] text-sm leading-relaxed text-slate-900";

/**
 * The Business group (ADR-0053 §6): the stored description's source line
 * and summary with "Show more", or why there is none. The paragraphs are
 * the filing's own words, shown as plain text in the filing's language
 * (marked with `lang`, so a screen reader reads them in it).
 */
function BusinessGroup(props: {
	readonly business: StockBusiness;
	readonly showTab: (tab: StockTab) => void;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	return (
		<section aria-label={s().businessHeading} data-field="company-business">
			<h4 class={HEADING}>{s().businessHeading}</h4>
			<div class="mt-1 space-y-2" data-business-status={props.business.status}>
				<Switch>
					<Match when={props.business.status === "not-tracked"}>
						<p class={BUSINESS_TEXT} data-field="business-not-tracked">
							{s().businessNotTracked}{" "}
							<button
								type="button"
								class={TASK_LINK}
								onClick={() => props.showTab("financials")}
								data-field="business-open-financials"
							>
								{s().openFinancials}
							</button>
						</p>
					</Match>
					<Match when={props.business.status === "pending"}>
						<p class={BUSINESS_TEXT} data-field="business-pending">
							{s().businessPending}
						</p>
					</Match>
					<Match when={props.business.status === "not-found" ? props.business : null}>
						{(business) => (
							<>
								<p class={BUSINESS_TEXT} data-field="business-not-found">
									{s().businessNotFound}
								</p>
								<SourceLine source={business().source} />
							</>
						)}
					</Match>
					<Match when={props.business.status === "extracted" ? props.business : null}>
						{(business) => (
							<Description
								source={business().source}
								paragraphs={business().paragraphs}
								truncated={business().truncated}
							/>
						)}
					</Match>
				</Switch>
			</div>
		</section>
	);
}

/** "From the 10-K for the fiscal year ended …, filed …." and the link to the filing. */
function SourceLine(props: { readonly source: EquityBusinessSource }): JSX.Element {
	const s = useMessages(stocksMessages);
	const locale = useLocale();
	return (
		<p class="max-w-[70ch] text-xs text-slate-700" data-field="business-source">
			{s().businessSource(
				props.source.form,
				formatPeriodEnd(props.source.periodEnd, locale()),
				formatPeriodEnd(props.source.filedOn, locale()),
			)}{" "}
			<FilingLink url={props.source.sourceUrl} />
		</p>
	);
}

function FilingLink(props: { readonly url: string }): JSX.Element {
	const s = useMessages(stocksMessages);
	return <SafeLink url={props.url}>{s().viewFiling}</SafeLink>;
}

/**
 * The description: the summary (`businessSummaryCount`), then the rest
 * behind "Show more". The rest stays in the DOM, hidden, so the button's
 * `aria-controls` always names an element; the button stays where it is
 * below the text, so focus stays on it. The expanded state lives as long as
 * this tab — the page keys the tabs by stock, so another stock starts
 * collapsed.
 */
function Description(props: {
	readonly source: EquityBusinessSource;
	readonly paragraphs: readonly EquityBusinessParagraph[];
	readonly truncated: boolean;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const restId = createUniqueId();
	const [expanded, setExpanded] = createSignal(false);
	const summaryCount = createMemo(() => businessSummaryCount(props.paragraphs));
	const summary = createMemo(() => props.paragraphs.slice(0, summaryCount()));
	const rest = createMemo(() => props.paragraphs.slice(summaryCount()));
	const lang = (): string => (props.source.form === "10-K" ? "en" : "ja");
	const continues = (): JSX.Element => (
		<p class={BUSINESS_TEXT} data-field="business-continues">
			{s().businessContinues} <FilingLink url={props.source.sourceUrl} />
		</p>
	);
	return (
		<>
			<SourceLine source={props.source} />
			<div class="space-y-2" lang={lang()} data-field="business-summary">
				<Paragraphs paragraphs={summary()} />
			</div>
			<Show when={rest().length > 0} fallback={<Show when={props.truncated}>{continues()}</Show>}>
				<div id={restId} class="space-y-2" hidden={!expanded()} data-field="business-rest">
					<div class="space-y-2" lang={lang()}>
						<Paragraphs paragraphs={rest()} />
					</div>
					<Show when={props.truncated}>{continues()}</Show>
				</div>
				<button
					type="button"
					class={`${TASK_LINK} text-sm`}
					aria-expanded={expanded()}
					aria-controls={restId}
					onClick={() => setExpanded((current) => !current)}
					data-field="business-toggle"
				>
					{expanded() ? s().showLess : s().showMore}
				</button>
			</Show>
		</>
	);
}

/** Headings as subheadings under the group's `h4`, text as paragraphs; plain text only. */
function Paragraphs(props: {
	readonly paragraphs: readonly EquityBusinessParagraph[];
}): JSX.Element {
	return (
		<For each={props.paragraphs}>
			{(paragraph) =>
				paragraph.kind === "heading" ? (
					<h5 class="max-w-[70ch] pt-1 text-sm font-semibold text-slate-900">{paragraph.text}</h5>
				) : (
					<p class={BUSINESS_TEXT}>{paragraph.text}</p>
				)
			}
		</For>
	);
}
