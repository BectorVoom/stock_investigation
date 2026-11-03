import {
	type CompanyOverviewView,
	citedSourceIds,
	type OverviewEvidence,
	type OverviewReference,
	type OverviewSourceId,
	stockListingSchema,
} from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { createMemo, For, type JSX, Show } from "solid-js";
import { formatPeriodEnd } from "../equities/financialFormat.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import { companyOverviewMessages } from "./companyOverview.messages.ts";
import { fiscalMonthText, localDayOf, sourceIdsOf } from "./companyOverviewModel.ts";

/** Body text: the app's size and a comfortable reading measure. */
const BODY = "max-w-[70ch] text-sm leading-relaxed text-slate-900";
/** Small text: source lines, notes, references (the Company tab's source-line style). */
const SMALL = "max-w-[70ch] text-xs leading-normal text-slate-700";
const SUBHEADING = "text-xs font-semibold text-slate-700";

/**
 * The company overview (事業概要, ADR-0064), laid out like a 会社四季報 entry:
 * labelled rows — 【特色】【事業内容】【連結事業】【海外】【テーマ】 — then a
 * 基本情報 table, every field followed by a small mark naming the numbered
 * source it rests on, a small 出所 line under each part and the numbered
 * 出典 list of the sources the page cites, all in small text. The entry's
 * text is shown in the UI's language. The stored quotes and figures are
 * not shown (the owner's choice, 2026-11-03).
 */
export function CompanyOverview(props: { readonly overview: CompanyOverviewView }): JSX.Element {
	const m = useMessages(companyOverviewMessages);
	const locale = useLocale();
	const entry = () => props.overview.entry;
	const references = createMemo(
		() => new Map(props.overview.references.map((reference) => [reference.id, reference])),
	);
	/**
	 * The references the page cites: the rows, the key facts and their
	 * stored listing and sector. The stored figures' source is not listed,
	 * since the page shows no figures.
	 */
	const shownReferences = createMemo((): OverviewReference[] => {
		const facts = props.overview.facts;
		const cited = citedSourceIds(entry(), { ...facts, cites: { ...facts.cites, figures: null } });
		return props.overview.references.filter((reference) => cited.has(reference.id));
	});
	/** The sources the labelled rows cite, in id order, for their 出所 line. */
	const rowSources = createMemo((): OverviewSourceId[] => {
		const ids = new Set<OverviewSourceId>();
		const add = (evidence: readonly OverviewEvidence[]) => {
			for (const id of sourceIdsOf(evidence)) ids.add(id);
		};
		const current = entry();
		if (current.feature !== null) add(current.feature.evidence);
		for (const item of current.businesses) add(item.evidence);
		for (const item of current.segments) add(item.evidence);
		if (current.overseasSales !== null) add(current.overseasSales.evidence);
		for (const item of current.themes) add(item.reason.evidence);
		return [...ids].sort();
	});
	return (
		<div class="mt-1 space-y-3" data-field="company-overview">
			<dl>
				<Row label={m().feature}>
					<Show when={entry().feature} fallback={<NotStated />}>
						{(feature) => (
							<span lang={locale()}>
								{feature()[locale()]}
								<Marks evidence={feature().evidence} />
							</span>
						)}
					</Show>
				</Row>
				<Row label={m().businesses}>
					<Show when={entry().businesses.length > 0} fallback={<NotStated />}>
						<ul class="list-disc space-y-0.5 pl-4" lang={locale()}>
							<For each={entry().businesses}>
								{(item) => (
									<li>
										{item[locale()]}
										<Marks evidence={item.evidence} />
									</li>
								)}
							</For>
						</ul>
					</Show>
				</Row>
				<Row label={m().segments}>
					<Show when={entry().segments.length > 0} fallback={<NotStated />}>
						{/* One segment a line: 四季報's "name79(4)", then what the segment does. */}
						<ul class="space-y-0.5" lang={locale()} data-field="company-overview-segments">
							<For each={entry().segments}>
								{(segment) => (
									<li>
										<span class="font-medium">
											{segment.name[locale()]}
											{segment.salesSharePercent === null ? "" : String(segment.salesSharePercent)}
											{segment.marginPercent === null ? "" : `(${segment.marginPercent})`}
										</span>
										<Show when={segment.activity}>
											{(activity) => `${m().segmentActivitySeparator}${activity()[locale()]}`}
										</Show>
										<Marks evidence={segment.evidence} />
									</li>
								)}
							</For>
						</ul>
						<Show
							when={entry().segments.some(
								(segment) => segment.salesSharePercent !== null || segment.marginPercent !== null,
							)}
						>
							<p class={SMALL}>{m().segmentNote}</p>
						</Show>
					</Show>
				</Row>
				<Row label={m().overseas}>
					<Show when={entry().overseasSales} fallback={<NotStated />}>
						{(overseas) => (
							<span>
								{`${overseas().percent}%`}
								<Marks evidence={overseas().evidence} />
							</span>
						)}
					</Show>
				</Row>
				<Row label={m().themes}>
					<Show when={entry().themes.length > 0} fallback={<NotStated />}>
						<ul class="flex flex-wrap gap-1.5" data-field="company-overview-themes">
							<For each={entry().themes}>
								{(theme) => (
									<li
										class="rounded-full border border-slate-300 bg-slate-50 px-2.5 py-0.5 text-xs text-slate-800"
										lang={locale()}
										title={theme.reason[locale()]}
									>
										{theme.label[locale()]}
										<Marks evidence={theme.reason.evidence} />
									</li>
								)}
							</For>
						</ul>
					</Show>
				</Row>
			</dl>
			<SourceLine ids={rowSources()} references={references()} />
			<div class="max-w-xl">
				<KeyFacts overview={props.overview} references={references()} />
			</div>
			<References references={shownReferences()} />
			<p class={SMALL} data-field="company-overview-written-by">
				{m().writtenBy(
					props.overview.agentId,
					props.overview.model,
					formatPeriodEnd(localDayOf(props.overview.generatedAt), locale()),
				)}
			</p>
		</div>
	);
}

/** A labelled row: 四季報's 【label】 on the left, the field on the right. */
function Row(props: { readonly label: string; readonly children: JSX.Element }): JSX.Element {
	const m = useMessages(companyOverviewMessages);
	return (
		<div class="grid grid-cols-[minmax(6rem,8rem)_1fr] gap-x-3 border-b border-slate-100 py-1.5">
			<dt class="text-xs font-semibold text-slate-700">{m().rowLabel(props.label)}</dt>
			<dd class={`min-w-0 break-words ${BODY}`}>{props.children}</dd>
		</div>
	);
}

function NotStated(): JSX.Element {
	const m = useMessages(companyOverviewMessages);
	return (
		<span class="text-xs italic text-slate-600" data-unavailable="true">
			{m().notStated}
		</span>
	);
}

/** Small superscript marks ("S2") naming the sources a field rests on. */
function Marks(props: { readonly evidence: readonly OverviewEvidence[] }): JSX.Element {
	return <SourceMarks ids={sourceIdsOf(props.evidence)} />;
}

function SourceMarks(props: { readonly ids: readonly OverviewSourceId[] }): JSX.Element {
	const m = useMessages(companyOverviewMessages);
	return (
		<For each={props.ids}>
			{(id) => (
				// <sup> is set at 75% of the surrounding text (Tailwind's preflight): small, no arbitrary size.
				<sup class="ml-0.5 font-normal text-slate-600" title={m().sourceMark(id)}>
					{id}
				</sup>
			)}
		</For>
	);
}

/** "出所: S2 Form 10-K 第1項 …" in small text; nothing when no source is cited. */
function SourceLine(props: {
	readonly ids: readonly OverviewSourceId[];
	readonly references: ReadonlyMap<OverviewSourceId, OverviewReference>;
}): JSX.Element {
	const m = useMessages(companyOverviewMessages);
	const locale = useLocale();
	return (
		<Show when={props.ids.length > 0}>
			<p class={SMALL} data-field="company-overview-source-line">
				{`${m().sourceLine}: `}
				{props.ids
					.map((id) => {
						const reference = props.references.get(id);
						return reference === undefined ? id : `${id} ${reference.title[locale()]}`;
					})
					.join(" / ")}
			</p>
		</Show>
	);
}

/** 基本情報: market, sector (Japan) and fiscal year end from stored records; the facts a source states. */
function KeyFacts(props: {
	readonly overview: CompanyOverviewView;
	readonly references: ReadonlyMap<OverviewSourceId, OverviewReference>;
}): JSX.Element {
	const m = useMessages(companyOverviewMessages);
	const model = useMessages(watchlistModelMessages);
	const locale = useLocale();
	const facts = () => props.overview.facts;
	const listingText = (): string | null => {
		const listing = facts().listing;
		if (listing === null) return null;
		const known = stockListingSchema.safeParse(listing);
		return known.success ? model().listingName(known.data) : listing;
	};
	const month = () => {
		const end = facts().fiscalYearEnd;
		return end === null ? null : fiscalMonthText(end, locale());
	};
	const sources = createMemo((): OverviewSourceId[] => {
		const ids = new Set<OverviewSourceId>();
		for (const id of [facts().cites.listing, facts().cites.sector]) {
			if (id !== null) ids.add(id);
		}
		for (const fact of props.overview.entry.profile) {
			for (const id of sourceIdsOf(fact.evidence)) ids.add(id);
		}
		return [...ids].sort();
	});
	const cite = (id: OverviewSourceId | null): JSX.Element =>
		id === null ? null : <SourceMarks ids={[id]} />;
	return (
		<section data-field="company-overview-key-facts">
			<h5 class={SUBHEADING}>{m().keyFacts}</h5>
			<table class="mt-1 w-full text-sm">
				<tbody>
					<FactRow term={m().market}>
						<Show when={listingText()} fallback={<NotStated />}>
							{(text) => (
								<>
									{text()}
									{cite(facts().cites.listing)}
								</>
							)}
						</Show>
					</FactRow>
					<Show when={facts().sector}>
						{(sector) => (
							<FactRow term={m().sector}>
								<span lang="ja">{sector()}</span>
								{cite(facts().cites.sector)}
							</FactRow>
						)}
					</Show>
					<FactRow term={m().fiscalYearEnd}>
						<Show when={month()} fallback={<NotStated />}>
							{(text) => text()}
						</Show>
					</FactRow>
					<For each={["founded", "employees", "headquarters"] as const}>
						{(field) => {
							const fact = () => props.overview.entry.profile.find((item) => item.field === field);
							return (
								<FactRow term={m().profileField(field)}>
									<Show when={fact()} fallback={<NotStated />}>
										{(found) => (
											<span lang={locale()}>
												{found().value[locale()]}
												<Marks evidence={found().evidence} />
											</span>
										)}
									</Show>
								</FactRow>
							);
						}}
					</For>
				</tbody>
			</table>
			<SourceLine ids={sources()} references={props.references} />
		</section>
	);
}

function FactRow(props: { readonly term: string; readonly children: JSX.Element }): JSX.Element {
	return (
		<tr class="border-b border-slate-100">
			<th scope="row" class="w-36 py-1 pr-2 text-left text-xs font-medium text-slate-700">
				{props.term}
			</th>
			<td class="py-1 text-slate-900">{props.children}</td>
		</tr>
	);
}

/** The numbered 出典 list in small text: title, publisher, date, note, link. */
function References(props: { readonly references: readonly OverviewReference[] }): JSX.Element {
	const m = useMessages(companyOverviewMessages);
	const locale = useLocale();
	return (
		<section data-field="company-overview-references">
			<h5 class="text-xs font-semibold text-slate-700">{m().references}</h5>
			<ol class={`mt-0.5 space-y-0.5 ${SMALL}`}>
				<For each={props.references}>
					{(reference) => (
						<li class="break-all">
							{`[${reference.id}] ${[
								reference.title[locale()],
								reference.publisher,
								...(reference.asOf === null ? [] : [formatPeriodEnd(reference.asOf, locale())]),
								...(reference.note === null ? [] : [reference.note[locale()]]),
							].join(locale() === "ja" ? "。" : ". ")} `}
							<Show when={reference.url}>{(url) => <SafeLink url={url()}>{url()}</SafeLink>}</Show>
						</li>
					)}
				</For>
			</ol>
		</section>
	);
}
