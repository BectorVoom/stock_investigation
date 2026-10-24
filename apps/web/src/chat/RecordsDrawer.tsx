import type {
	Claim,
	DemandScenario,
	Evidence,
	FinancialObservation,
	InvestorFiling,
	PositionObservation,
	RunRecords,
	Security,
} from "@research/contracts";
import { reportedPositionChangePhrase } from "@research/domain";
import type { MessagesOf } from "@research/i18n";
import { useMessages } from "@research/i18n/solid";
import {
	ClaimStatusBadge,
	ClaimTypeBadge,
	DateText,
	formatNumber,
	positionLabelMessages,
	SafeLink,
	SourceCitation,
	Unavailable,
} from "@research/ui-registry";
import {
	type Accessor,
	createMemo,
	createUniqueId,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { ApiClient } from "../api/client.ts";
import { BUTTON, Empty, RemoteView } from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import { createRemote } from "../lib/remote.ts";
import { recordsMessages } from "./records.messages.tsx";

type RecordsText = MessagesOf<typeof recordsMessages>;

type EvidenceMap = ReadonlyMap<string, Evidence>;
type SecurityMap = ReadonlyMap<string, Security>;

/** Wraps a nullable number so `<Show>` treats 0 as present and null as absent (DATA-011). */
function boxed(value: number | null): { readonly value: number } | null {
	return value === null ? null : { value };
}

function Section(props: {
	readonly title: string;
	readonly count: number;
	readonly emptyText: string;
	readonly note?: string;
	readonly children: JSX.Element;
}): JSX.Element {
	const m = useMessages(recordsMessages);
	return (
		<section aria-label={props.title} class="mt-4">
			<h4 class="text-sm font-semibold text-slate-900">
				{m().sectionTitle(props.title, props.count)}
			</h4>
			<Show when={props.note}>{(note) => <p class="text-xs text-slate-700">{note()}</p>}</Show>
			<Show when={props.count > 0} fallback={<Empty>{props.emptyText}</Empty>}>
				{props.children}
			</Show>
		</section>
	);
}

function EvidenceRefs(props: {
	readonly label: string;
	readonly evidenceIds: readonly string[];
	readonly evidence: EvidenceMap;
}): JSX.Element {
	return (
		<Show when={props.evidenceIds.length > 0}>
			<p class="mt-1 text-xs font-semibold text-slate-700">{props.label}</p>
			<ul aria-label={props.label} class="list-disc pl-5 text-xs">
				<For each={props.evidenceIds}>
					{(evidenceId) => (
						<li>
							<SourceCitation sourceId={evidenceId} sources={props.evidence} />
						</li>
					)}
				</For>
			</ul>
		</Show>
	);
}

/** A retained source passage, or an explicit statement that none was kept. */
function CitedPassage(props: {
	readonly label: string;
	readonly quote: string | null;
}): JSX.Element {
	const m = useMessages(recordsMessages);
	return (
		<p data-field="cited-passage" class="text-xs text-slate-800">
			<span class="font-semibold">{props.label}: </span>
			<Show
				when={props.quote !== null && props.quote !== ""}
				fallback={<Unavailable reason={m().noPassageRetained} />}
			>
				<q>{props.quote}</q>
			</Show>
		</p>
	);
}

function SecurityName(props: {
	readonly securityId: string;
	readonly securities: SecurityMap;
}): JSX.Element {
	const m = useMessages(recordsMessages);
	const security = createMemo(() => props.securities.get(props.securityId));
	return (
		<Show
			when={security()}
			fallback={
				<span class="italic text-amber-900">{m().securityUnavailable(props.securityId)}</span>
			}
		>
			{(current) => (
				<>
					<span data-security-id={props.securityId}>
						{current().issuerName} —{" "}
						<span class="font-mono">
							{current().ticker} · {current().exchange}
						</span>{" "}
						({current().country})
					</span>{" "}
					<span
						data-listing-verification={current().listingVerification}
						class="rounded border px-1 text-2xs font-normal"
						classList={{
							"border-emerald-700 text-emerald-900":
								current().listingVerification === "source-verified",
							"border-dashed border-amber-700 text-amber-900":
								current().listingVerification === "unverified",
						}}
					>
						{m().listingVerification(current().listingVerification)}
					</span>
				</>
			)}
		</Show>
	);
}

/* ---------- Claims ---------- */

const CLAIM_GROUPS = ["supported", "conflicting", "unsupported"] as const;

/**
 * Plain-language text for a verification issue. A code this view has no wording
 * for yet is shown as its stable machine code rather than hidden, so adding an
 * issue code to the contracts never breaks or silences this list.
 */
function describeIssue(issue: Claim["issues"][number], text: RecordsText): string {
	const code: string = issue.code;
	switch (issue.code) {
		case "UNKNOWN_EVIDENCE":
			return text.unknownEvidence(issue.evidenceId);
		case "QUOTE_NOT_FOUND":
			return text.quoteNotFound(issue.evidenceId);
		case "QUOTE_TOO_SHORT":
			return text.quoteTooShort(issue.evidenceId);
		case "MISSING_QUOTE":
			return text.missingQuote(issue.evidenceId);
		case "NUMBER_NOT_IN_EVIDENCE":
			return text.numberNotInEvidence(issue.numberText);
		case "NO_SUPPORTING_EVIDENCE":
			return text.noSupportingEvidence;
		case "NOT_INDEPENDENTLY_VERIFIED":
			return text.notIndependentlyVerified;
		default:
			return code;
	}
}

function ClaimCard(props: { readonly claim: Claim; readonly evidence: EvidenceMap }): JSX.Element {
	const m = useMessages(recordsMessages);
	const linked = (relation: Claim["links"][number]["relation"]) =>
		props.claim.links.filter((link) => link.relation === relation).map((link) => link.evidenceId);
	return (
		<li data-claim-id={props.claim.claimId} class="rounded border border-slate-200 p-2">
			<p class="text-sm text-slate-900">{props.claim.text}</p>
			<p class="mt-0.5 flex flex-wrap gap-1">
				<ClaimTypeBadge claimType={props.claim.claimType} />
				<ClaimStatusBadge status={props.claim.status} />
			</p>
			<EvidenceRefs
				label={m().supportingEvidence}
				evidenceIds={linked("supports")}
				evidence={props.evidence}
			/>
			<EvidenceRefs
				label={m().contradictingEvidence}
				evidenceIds={linked("contradicts")}
				evidence={props.evidence}
			/>
			<EvidenceRefs label={m().context} evidenceIds={linked("context")} evidence={props.evidence} />
			<Show when={props.claim.issues.length > 0}>
				<p class="mt-1 text-xs font-semibold text-red-900">{m().verificationIssues}</p>
				<ul aria-label={m().verificationIssues} class="list-disc pl-5 text-xs text-red-900">
					<For each={props.claim.issues}>{(issue) => <li>{describeIssue(issue, m())}</li>}</For>
				</ul>
			</Show>
		</li>
	);
}

/* ---------- Demand scenarios ---------- */

const SCENARIO_CASES = ["bear", "base", "bull"] as const;
const percentFormat = new Intl.NumberFormat("en-US", {
	style: "percent",
	maximumFractionDigits: 1,
});

function ScenarioCard(props: {
	readonly scenario: DemandScenario;
	readonly evidence: EvidenceMap;
}): JSX.Element {
	const m = useMessages(recordsMessages);
	const scenario = () => props.scenario;
	const baselineEvidenceIds = () => {
		const evidenceId = scenario().baselineEvidenceId;
		return evidenceId === null ? [] : [evidenceId];
	};
	return (
		<li data-scenario-id={scenario().scenarioId} class="rounded border border-slate-200 p-2">
			<p class="text-sm font-semibold text-slate-900">{scenario().productOrService}</p>
			<p class="text-xs text-slate-800">
				{m().scenarioSummary(
					m().quantityKind(scenario().quantityKind),
					scenario().unit,
					scenario().baseYear,
					scenario().targetYear,
				)}
				<Show
					when={boxed(scenario().baselineValue)}
					fallback={<Unavailable reason={m().noSourcedBaseline} />}
				>
					{(baseline) => (
						<span data-field="baseline">
							{formatNumber(baseline().value)} {scenario().unit}
						</span>
					)}
				</Show>
			</p>
			<table class="mt-1 w-full border-collapse text-left text-xs">
				<caption class="caption-top text-left text-slate-600">
					{m().scenarioCaption(scenario().targetYear, scenario().unit)}
				</caption>
				<thead>
					<tr class="border-b border-slate-300">
						<th scope="col" class="pr-2">
							{m().caseHeader}
						</th>
						<th scope="col" class="pr-2 text-right">
							{m().targetHeader(scenario().unit)}
						</th>
						<th scope="col" class="pr-2 text-right">
							{m().derivedCagr}
						</th>
						<th scope="col">{m().assumptions}</th>
					</tr>
				</thead>
				<tbody>
					<For each={SCENARIO_CASES}>
						{(caseName) => (
							<tr class="border-b border-slate-200 align-top" data-case={caseName}>
								<th scope="row" class="pr-2 font-medium capitalize">
									{m().scenarioCase(caseName)}
								</th>
								<td class="pr-2 text-right tabular-nums">
									{formatNumber(scenario()[caseName].targetValue)}
								</td>
								<td class="pr-2 text-right tabular-nums" data-field="cagr">
									{(() => {
										const cagr = scenario().derivedCagr[caseName];
										return cagr === null
											? m().notDerivable
											: m().perYear(percentFormat.format(cagr));
									})()}
								</td>
								<td>{scenario()[caseName].assumptions.join("; ") || m().noneStated}</td>
							</tr>
						)}
					</For>
				</tbody>
			</table>
			<dl class="mt-1 text-xs">
				<dt class="font-semibold text-slate-700">{m().drivers}</dt>
				<dd>{scenario().drivers.join("; ") || m().noneStated}</dd>
				<dt class="font-semibold text-slate-700">{m().barriers}</dt>
				<dd>{scenario().barriers.join("; ") || m().noneStated}</dd>
				<dt class="font-semibold text-slate-700">{m().falsifiers}</dt>
				<dd>{scenario().falsifiers.join("; ") || m().noneStated}</dd>
				<dt class="font-semibold text-slate-700">{m().methodology}</dt>
				<dd>{scenario().methodology}</dd>
			</dl>
			<Show when={scenario().baselineValue !== null}>
				<CitedPassage label={m().baselinePassage} quote={scenario().baselineQuote} />
			</Show>
			<EvidenceRefs
				label={m().baselineEvidence}
				evidenceIds={baselineEvidenceIds()}
				evidence={props.evidence}
			/>
			<EvidenceRefs
				label={m().supportingEvidence}
				evidenceIds={scenario().supportingEvidenceIds}
				evidence={props.evidence}
			/>
			<EvidenceRefs
				label={m().contraryEvidence}
				evidenceIds={scenario().contraryEvidenceIds}
				evidence={props.evidence}
			/>
		</li>
	);
}

/* ---------- Financial observations ---------- */

function financialValue(observation: FinancialObservation, text: RecordsText): string | null {
	if (observation.value === null) return null;
	const value = formatNumber(observation.value);
	if (observation.unit === "ratio") return value;
	const currency = observation.currency ?? text.currencyNotStated;
	return observation.unit === "currency" ? `${value} ${currency}` : text.perShare(value, currency);
}

function describePeriod(period: FinancialObservation["period"], text: RecordsText): string {
	if (period === null) return text.periodNotStated;
	return text.period(period.fiscalYear, period.fiscalPeriod, period.periodStart, period.periodEnd);
}

function FinancialTable(props: {
	readonly observations: readonly FinancialObservation[];
	readonly securities: SecurityMap;
	readonly evidence: EvidenceMap;
}): JSX.Element {
	const m = useMessages(recordsMessages);
	return (
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-left text-xs">
				<caption class="caption-top text-left text-slate-600">{m().financialCaption}</caption>
				<thead>
					<tr class="border-b border-slate-300">
						<th scope="col" class="pr-2">
							{m().security}
						</th>
						<th scope="col" class="pr-2">
							{m().metric}
						</th>
						<th scope="col" class="pr-2 text-right">
							{m().value}
						</th>
						<th scope="col" class="pr-2">
							{m().periodAndBasis}
						</th>
						<th scope="col" class="pr-2">
							{m().marketDataAsOf}
						</th>
						<th scope="col" class="pr-2">
							{m().formula}
						</th>
						<th scope="col">{m().source}</th>
					</tr>
				</thead>
				<tbody>
					<For each={props.observations}>
						{(observation) => (
							<tr
								class="border-b border-slate-200 align-top"
								data-observation-id={observation.observationId}
							>
								<th scope="row" class="pr-2 font-medium">
									<SecurityName securityId={observation.securityId} securities={props.securities} />
								</th>
								<td class="pr-2">{observation.metricCode}</td>
								<td class="pr-2 text-right tabular-nums" data-field="value">
									<Show
										when={financialValue(observation, m())}
										fallback={
											<Unavailable reason={observation.unavailableReason ?? m().reasonNotStated} />
										}
									>
										{(value) => value()}
									</Show>
								</td>
								<td class="pr-2">
									{describePeriod(observation.period, m())};{" "}
									{m().actualOrEstimate(observation.actualOrEstimate)};{" "}
									{observation.accountingStandard ?? m().accountingStandardNotStated}
								</td>
								<td class="pr-2">
									<DateText iso={observation.marketDataAsOf} missing={m().notPriceDerived} />
								</td>
								<td class="pr-2">{observation.formula ?? m().notStated}</td>
								<td>
									<Show
										when={observation.sourceEvidenceId}
										fallback={<span class="italic">{m().noSourceValue}</span>}
									>
										{(sourceId) => (
											<SourceCitation sourceId={sourceId()} sources={props.evidence} />
										)}
									</Show>
								</td>
							</tr>
						)}
					</For>
				</tbody>
			</table>
		</div>
	);
}

/* ---------- Positions (JP and US are never merged: FR-007 / DATA-006) ---------- */

function PositionCard(props: {
	readonly observation: PositionObservation;
	readonly securities: SecurityMap;
	readonly evidence: EvidenceMap;
}): JSX.Element {
	const m = useMessages(recordsMessages);
	const figures = () => props.observation.figures;
	const jp = () => {
		const current = figures();
		return current !== null && current.metric === "jp-margin-balance" ? current : null;
	};
	const us = () => {
		const current = figures();
		return current !== null && current.metric === "us-short-interest" ? current : null;
	};
	return (
		<li
			data-observation-id={props.observation.observationId}
			class="rounded border border-slate-200 p-2"
		>
			<p class="text-sm font-medium text-slate-900">
				<SecurityName securityId={props.observation.securityId} securities={props.securities} />
			</p>
			<Show when={figures() === null}>
				<p class="text-xs">
					<Unavailable reason={props.observation.unavailableReason ?? m().reasonNotStated} />
				</p>
			</Show>
			<Show when={jp()}>
				{(balance) => (
					<dl class="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
						<dt>{m().marginBuy}</dt>
						<dd data-field="jp-margin-buy">
							{m().shares(formatNumber(balance().marginBuyBalanceShares))}
						</dd>
						<dt>{m().marginSell}</dt>
						<dd data-field="jp-margin-sell">
							{m().shares(formatNumber(balance().marginSellBalanceShares))}
						</dd>
					</dl>
				)}
			</Show>
			<Show when={us()}>
				{(shortInterest) => (
					<dl class="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
						<dt>{m().reportedShortInterest}</dt>
						<dd data-field="us-short-interest">
							{m().shares(formatNumber(shortInterest().reportedShortInterestShares))}
						</dd>
						<dt>{m().averageDailyVolume}</dt>
						<dd>
							<Show
								when={boxed(shortInterest().averageDailyVolumeShares)}
								fallback={<Unavailable reason={m().notReported} />}
							>
								{(volume) => <span>{m().shares(formatNumber(volume().value))}</span>}
							</Show>
						</dd>
					</dl>
				)}
			</Show>
			<p class="mt-1 text-xs text-slate-700">
				{m().positionDates(
					<DateText iso={props.observation.asOfDate} missing={m().dateNotStated} />,
					<DateText iso={props.observation.disseminatedAt} missing={m().dateNotStated} />,
					props.observation.metricDefinition,
				)}
			</p>
			<p class="text-xs">
				<Show
					when={props.observation.sourceEvidenceId}
					fallback={<span class="italic">{m().noSourceFigures}</span>}
				>
					{(sourceId) => <SourceCitation sourceId={sourceId()} sources={props.evidence} />}
				</Show>
			</p>
		</li>
	);
}

function PositionSection(props: {
	readonly metric: PositionObservation["metric"];
	readonly observations: readonly PositionObservation[];
	readonly securities: SecurityMap;
	readonly evidence: EvidenceMap;
}): JSX.Element {
	const m = useMessages(recordsMessages);
	const position = useMessages(positionLabelMessages);
	const matching = createMemo(() =>
		props.observations.filter((observation) => observation.metric === props.metric),
	);
	return (
		<Section
			title={position().heading(props.metric)}
			count={matching().length}
			note={position().caveat(props.metric)}
			emptyText={m().noObservations}
		>
			<ul class="mt-1 space-y-2">
				<For each={matching()}>
					{(observation) => (
						<PositionCard
							observation={observation}
							securities={props.securities}
							evidence={props.evidence}
						/>
					)}
				</For>
			</ul>
		</Section>
	);
}

/* ---------- Investor filings (reported holdings, never "purchases": FR-008 / DATA-007) ---------- */

function FilingCard(props: {
	readonly filing: InvestorFiling;
	readonly evidence: EvidenceMap;
}): JSX.Element {
	const m = useMessages(recordsMessages);
	return (
		<li data-filing-id={props.filing.filingId} class="rounded border border-slate-200 p-2">
			<p class="text-sm text-slate-900">
				{m().filingHeadline(
					<span class="font-semibold">{props.filing.investorName}</span>,
					<DateText iso={props.filing.reportPeriodEnd} missing={m().dateNotStated} />,
					props.filing.form,
					<DateText iso={props.filing.filedAt} missing={m().dateNotStated} />,
					<SafeLink url={props.filing.filingUrl}>{m().viewFiling}</SafeLink>,
				)}
			</p>
			<p class="text-xs text-slate-700">
				{m().filerNote(
					props.filing.reportingEntityIdentifier.scheme,
					props.filing.reportingEntityIdentifier.value,
				)}
			</p>
			<Show when={props.filing.holdings.length > 0} fallback={<Empty>{m().noHoldings}</Empty>}>
				<table class="mt-1 w-full border-collapse text-left text-xs">
					<caption class="caption-top text-left text-slate-600">
						{m().holdingsCaption(props.filing.investorName, props.filing.reportPeriodEnd)}
					</caption>
					<thead>
						<tr class="border-b border-slate-300">
							<th scope="col" class="pr-2">
								{m().issuer}
							</th>
							<th scope="col" class="pr-2 text-right">
								{m().reportedShares}
							</th>
							<th scope="col" class="pr-2 text-right">
								{m().reportedValue}
							</th>
							<th scope="col">{m().changeVersusPrior}</th>
						</tr>
					</thead>
					<tbody>
						<For each={props.filing.holdings}>
							{(holding) => (
								<tr class="border-b border-slate-200">
									<th scope="row" class="pr-2 font-medium">
										{holding.issuerName}
									</th>
									<td class="pr-2 text-right tabular-nums">
										{formatNumber(holding.reportedShares)}
									</td>
									<td class="pr-2 text-right tabular-nums">
										<Show
											when={boxed(holding.reportedValueUsd)}
											fallback={<Unavailable reason={m().notReported} />}
										>
											{(reported) => formatNumber(reported().value)}
										</Show>
									</td>
									<td data-field="reported-change">
										{holding.changeFromPriorFiling === null
											? m().notCompared
											: reportedPositionChangePhrase(holding.changeFromPriorFiling)}
									</td>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</Show>
			<p class="mt-1 text-xs">
				<SourceCitation sourceId={props.filing.sourceEvidenceId} sources={props.evidence} />
			</p>
		</li>
	);
}

/* ---------- Drawer ---------- */

function RecordsBody(props: { readonly records: Accessor<RunRecords> }): JSX.Element {
	const m = useMessages(recordsMessages);
	const records = props.records;
	const evidence = createMemo(
		() => new Map(records().evidence.map((item) => [item.evidenceId, item] as const)),
	);
	const securities = createMemo(
		() => new Map(records().securities.map((item) => [item.securityId, item] as const)),
	);
	return (
		<>
			<For each={CLAIM_GROUPS}>
				{(group) => {
					const claims = createMemo(() =>
						records().claims.filter((claim) => claim.status === group),
					);
					return (
						<Section
							title={m().claimGroup(group)}
							count={claims().length}
							emptyText={m().noClaims(group)}
						>
							<ul class="mt-1 space-y-2">
								<For each={claims()}>
									{(claim) => <ClaimCard claim={claim} evidence={evidence()} />}
								</For>
							</ul>
						</Section>
					);
				}}
			</For>

			<Section
				title={m().demandScenarios}
				count={records().scenarios.length}
				emptyText={m().noScenarios}
			>
				<ul class="mt-1 space-y-2">
					<For each={records().scenarios}>
						{(scenario) => <ScenarioCard scenario={scenario} evidence={evidence()} />}
					</For>
				</ul>
			</Section>

			<Section
				title={m().supplierLinks}
				count={records().supplierLinks.length}
				emptyText={m().noSupplierLinks}
			>
				<ul class="mt-1 space-y-2">
					<For each={records().supplierLinks}>
						{(link) => (
							<li
								data-supplier-link-id={link.supplierLinkId}
								class="rounded border border-slate-200 p-2"
							>
								<p class="text-sm font-medium text-slate-900">
									<SecurityName securityId={link.securityId} securities={securities()} />
								</p>
								<p class="text-xs text-slate-800">
									{m().supplies(link.productsOrServices.join("; "))}
								</p>
								<p class="text-xs text-slate-800">{m().businessExposure(link.businessExposure)}</p>
								<CitedPassage label={m().issuerPassage} quote={link.relationshipQuote} />
								<EvidenceRefs
									label={m().supplierEvidence}
									evidenceIds={link.evidenceIds}
									evidence={evidence()}
								/>
							</li>
						)}
					</For>
				</ul>
			</Section>

			<Section
				title={m().financialObservations}
				count={records().financialObservations.length}
				emptyText={m().noFinancial}
			>
				<FinancialTable
					observations={records().financialObservations}
					securities={securities()}
					evidence={evidence()}
				/>
			</Section>

			<PositionSection
				metric="jp-margin-balance"
				observations={records().positionObservations}
				securities={securities()}
				evidence={evidence()}
			/>
			<PositionSection
				metric="us-short-interest"
				observations={records().positionObservations}
				securities={securities()}
				evidence={evidence()}
			/>

			<Section
				title={m().investorFilings}
				count={records().investorFilings.length}
				note={m().filingsNote}
				emptyText={m().noFilings}
			>
				<ul class="mt-1 space-y-2">
					<For each={records().investorFilings}>
						{(filing) => <FilingCard filing={filing} evidence={evidence()} />}
					</For>
				</ul>
			</Section>

			<Section
				title={m().pricingPower}
				count={records().pricingPower.length}
				note={m().pricingNote}
				emptyText={m().noPricing}
			>
				<ul class="mt-1 space-y-2">
					<For each={records().pricingPower}>
						{(record) => (
							<li
								data-pricing-power-id={record.pricingPowerId}
								class="rounded border border-slate-200 p-2"
							>
								<p class="text-sm font-medium text-slate-900">
									<SecurityName securityId={record.securityId} securities={securities()} />
								</p>
								<p class="text-xs text-slate-800">
									{describePeriod(record.period, m())}
									{m().assessment}{" "}
									<span class="font-semibold">
										{m().classification(record.assessment.classification)}
									</span>
									<Show when={record.assessment.missingInputs.length > 0}>
										{m().missingInputs(record.assessment.missingInputs.join(", "))}
									</Show>
								</p>
								<EvidenceRefs
									label={m().evidence}
									evidenceIds={record.evidenceIds}
									evidence={evidence()}
								/>
							</li>
						)}
					</For>
				</ul>
			</Section>

			<Section title={m().allEvidence} count={records().evidence.length} emptyText={m().noEvidence}>
				<ul class="mt-1 list-disc space-y-0.5 pl-5 text-xs">
					<For each={records().evidence}>
						{(item) => (
							<li>
								<SourceCitation sourceId={item.evidenceId} sources={evidence()} />
								<span class="text-slate-600"> — {m().sourceClass(item.sourceClass)}</span>
							</li>
						)}
					</For>
				</ul>
			</Section>
		</>
	);
}

/** Everything a run stored: claims with both sides of the evidence, scenarios, suppliers, finance. */
export function RecordsDrawer(props: {
	readonly api: ApiClient;
	readonly runId: string;
	readonly startedAt: string | null;
	/** The control that opened the drawer, for focus return on close. WHY an
	 * explicit prop instead of `document.activeElement`: Safari does not move
	 * focus to a button when it is clicked, so reading the active element at
	 * open time finds the wrong control there. Callers pass the click event's
	 * `currentTarget`. */
	readonly opener: HTMLElement | null;
	readonly onClose: () => void;
}): JSX.Element {
	const m = useMessages(recordsMessages);
	const records = createRemote(() => props.api.getRunRecords(props.runId));
	// A modal dialog (guideline section 6): labelled by its heading, over a
	// semi-transparent backdrop. Focus moves in on open, Tab cycles inside,
	// Escape closes, and focus returns to the opening control on close. The
	// drawer portals to the document body so the whole page behind it can
	// go `inert` while it is open.
	const headingId = createUniqueId();
	let dialog: HTMLElement | undefined;
	let closeButton: HTMLButtonElement | undefined;
	let inertBehind: HTMLElement | null = null;

	const focusableItems = (): HTMLElement[] => {
		const root = dialog;
		if (root === undefined) return [];
		const nodes = root.querySelectorAll(
			'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
		);
		const items: HTMLElement[] = [];
		for (const node of nodes) {
			if (node instanceof HTMLElement) items.push(node);
		}
		return items;
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			props.onClose();
			return;
		}
		if (event.key !== "Tab") return;
		const items = focusableItems();
		const first = items[0];
		const last = items[items.length - 1];
		if (first === undefined || last === undefined) return;
		if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		} else if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		}
	};

	onMount(() => {
		const behind = document.querySelector("main");
		if (behind instanceof HTMLElement) {
			inertBehind = behind;
			inertBehind.inert = true;
		}
		closeButton?.focus();
	});
	onCleanup(() => {
		if (inertBehind !== null) {
			inertBehind.inert = false;
			inertBehind = null;
		}
		if (props.opener instanceof HTMLElement) props.opener.focus();
	});

	return (
		<Portal>
			<div
				data-drawer-backdrop="true"
				aria-hidden="true"
				class="fixed inset-0 z-20 bg-slate-900/50"
				onClick={() => props.onClose()}
			/>
			<aside
				ref={(element) => {
					dialog = element;
				}}
				role="dialog"
				aria-modal="true"
				aria-labelledby={headingId}
				class="fixed inset-y-0 right-0 z-30 w-full max-w-3xl wrap-anywhere overflow-y-auto border-l border-slate-300 bg-white p-4"
				onKeyDown={onKeyDown}
			>
				<div class="flex items-start justify-between gap-2">
					<div>
						<h3 id={headingId} class="text-base font-semibold text-slate-900">
							{m().drawerTitle}
						</h3>
						<p class="text-xs text-slate-600">
							{m().run} <span class="font-mono">{props.runId}</span>
							<Show when={props.startedAt}>
								{(startedAt) => <span>{m().startedAt(formatInstant(startedAt()))}</span>}
							</Show>
						</p>
					</div>
					<button
						ref={(element) => {
							closeButton = element;
						}}
						type="button"
						class={BUTTON}
						onClick={() => props.onClose()}
					>
						{m().closeRecords}
					</button>
				</div>
				<RemoteView
					remote={records.state()}
					label={m().runRecords}
					onRetry={() => void records.reload()}
				>
					{(value) => <RecordsBody records={value} />}
				</RemoteView>
			</aside>
		</Portal>
	);
}
