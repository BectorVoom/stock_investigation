import {
	EQUITY_LIMITS,
	type EquityFactsResponse,
	type EquityImport,
	type EquityImportHistory,
	type EquityIssuerList,
	type EquityRecordsResponse,
	equityImportSchema,
} from "@research/contracts";
import { parseJson } from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import {
	BUTTON,
	BUTTON_PRIMARY,
	Empty,
	ErrorNotice,
	INPUT,
	Loading,
	Notice,
	Section,
} from "../components/ui.tsx";
import { downloadTextFile } from "../lib/download.ts";
import { equitiesMessages } from "./equities.messages.ts";
import { equityResearchSnapshot } from "./researchSnapshot.ts";

export function EquitiesView(props: { readonly api: ApiClient }): JSX.Element {
	const m = useMessages(equitiesMessages);
	const [issuers, setIssuers] = createSignal<EquityIssuerList>({ issuers: [], nextCursor: null });
	const [imports, setImports] = createSignal<EquityImportHistory>({
		imports: [],
		nextCursor: null,
	});
	const [facts, setFacts] = createSignal<EquityFactsResponse>({
		facts: [],
		nextCursor: null,
		ingestionVersion: 0,
	});
	const [records, setRecords] = createSignal<EquityRecordsResponse>({
		records: [],
		nextCursor: null,
	});
	const [selected, setSelected] = createSignal<EquityIssuerList["issuers"][number] | null>(null);
	const [query, setQuery] = createSignal("");
	const [informationCutoff, setInformationCutoff] = createSignal("");
	const [ingestionCutoff, setIngestionCutoff] = createSignal("");
	const [appliedCutoffs, setAppliedCutoffs] = createSignal<{
		informationCutoff?: string;
		ingestionCutoff?: string;
	}>({});
	let appliedSearch = "";
	const [loading, setLoading] = createSignal(true);
	const [detailsLoading, setDetailsLoading] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	type FailureScope = "companies" | "imports" | "facts" | "records" | "import" | "download";
	const [failures, setFailures] = createSignal<Partial<Record<FailureScope, ApiFailure>>>({});
	const setFailure = (scope: FailureScope, error: ApiFailure | undefined): void => {
		setFailures((current) => ({ ...current, [scope]: error }));
	};
	const [importsLoading, setImportsLoading] = createSignal(true);
	const [recordsLoading, setRecordsLoading] = createSignal(false);
	const [downloading, setDownloading] = createSignal<ReadonlySet<string>>(new Set());
	const [notice, setNotice] = createSignal<string | null>(null);
	const [pending, setPending] = createSignal<{
		readonly payload: EquityImport;
		readonly key: string;
		readonly count: number;
	} | null>(null);
	let disposed = false;
	let listGeneration = 0;
	let detailGeneration = 0;
	let recordGeneration = 0;
	let fileGeneration = 0;
	let importGeneration = 0;
	onCleanup(() => {
		disposed = true;
		listGeneration += 1;
		detailGeneration += 1;
		recordGeneration += 1;
		fileGeneration += 1;
		importGeneration += 1;
	});

	async function loadCompanies(append = false, refresh = false): Promise<void> {
		if (!append && !refresh) appliedSearch = query();
		const generation = ++listGeneration;
		setLoading(true);
		setFailure("companies", undefined);
		const result = await props.api.listEquityIssuers({
			q: appliedSearch,
			after: append ? (issuers().nextCursor ?? undefined) : undefined,
		});
		if (disposed || generation !== listGeneration) return;
		setLoading(false);
		if (!result.ok) {
			setFailure("companies", result.error);
			return;
		}
		setIssuers({
			...result.value,
			issuers: append ? [...issuers().issuers, ...result.value.issuers] : result.value.issuers,
		});
		const refreshed = result.value.issuers.find(
			(issuer) => issuer.issuerId === selected()?.issuerId,
		);
		if (refreshed !== undefined) setSelected(refreshed);
	}
	async function loadImports(append = false): Promise<void> {
		if (append && importsLoading()) return;
		const generation = ++importGeneration;
		setImportsLoading(true);
		setFailure("imports", undefined);
		const result = await props.api.listEquityImports({
			after: append ? (imports().nextCursor ?? undefined) : undefined,
		});
		if (disposed || generation !== importGeneration) return;
		setImportsLoading(false);
		if (!result.ok) {
			setFailure("imports", result.error);
			return;
		}
		setImports({
			...result.value,
			imports: append ? [...imports().imports, ...result.value.imports] : result.value.imports,
		});
	}
	async function loadFacts(append = false, refresh = false): Promise<void> {
		const issuer = selected();
		if (issuer === null) return;
		if (!append && !refresh) {
			setAppliedCutoffs({
				informationCutoff: informationCutoff() || undefined,
				ingestionCutoff: ingestionCutoff() || undefined,
			});
		}
		if (!append) setFacts({ facts: [], nextCursor: null, ingestionVersion: 0 });
		const generation = ++detailGeneration;
		setDetailsLoading(true);
		setFailure("facts", undefined);
		const result = await props.api.getEquityFacts(issuer.issuerId, {
			...appliedCutoffs(),
			ingestionVersion: append ? facts().ingestionVersion : undefined,
			after: append ? (facts().nextCursor ?? undefined) : undefined,
		});
		if (disposed || generation !== detailGeneration) return;
		setDetailsLoading(false);
		if (!result.ok) {
			setFailure("facts", result.error);
			return;
		}
		setFacts({
			...result.value,
			facts: append ? [...facts().facts, ...result.value.facts] : result.value.facts,
		});
	}
	async function loadRecords(append = false): Promise<void> {
		if (append && recordsLoading()) return;
		const generation = ++recordGeneration;
		const id = selected()?.issuerId;
		if (id === undefined) return;
		setRecordsLoading(true);
		setFailure("records", undefined);
		const result = await props.api.getEquityIssuerRecords(id, {
			after: append ? (records().nextCursor ?? undefined) : undefined,
		});
		if (disposed || generation !== recordGeneration || id !== selected()?.issuerId) return;
		setRecordsLoading(false);
		if (!result.ok) {
			setFailure("records", result.error);
			return;
		}
		setRecords({
			...result.value,
			records: append ? [...records().records, ...result.value.records] : result.value.records,
		});
	}
	function choose(issuer: EquityIssuerList["issuers"][number]): void {
		setSelected(issuer);
		setInformationCutoff(appliedCutoffs().informationCutoff ?? "");
		setIngestionCutoff(appliedCutoffs().ingestionCutoff ?? "");
		setFacts({ facts: [], nextCursor: null, ingestionVersion: 0 });
		setRecords({ records: [], nextCursor: null });
		void loadFacts(false, true);
		void loadRecords();
	}
	async function readFile(file: File | undefined): Promise<void> {
		const generation = ++fileGeneration;
		setPending(null);
		setNotice(null);
		if (file === undefined) return;
		if (file.size > EQUITY_LIMITS.maxImportBytes) {
			setNotice(m().invalidFile);
			return;
		}
		let text: string;
		try {
			text = await file.text();
		} catch {
			setNotice(m().invalidFile);
			return;
		}
		if (disposed || generation !== fileGeneration) return;
		const json = parseJson(text);
		if (!json.ok) {
			setNotice(m().invalidFile);
			return;
		}
		const parsed = equityImportSchema.safeParse(json.value);
		if (
			!parsed.success ||
			new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength >
				EQUITY_LIMITS.maxImportBytes
		) {
			setNotice(m().invalidFile);
			return;
		}
		const count = Object.values(parsed.data).reduce<number>(
			(n, v) => n + (Array.isArray(v) ? v.length : 0),
			0,
		);
		setPending({ payload: parsed.data, key: props.api.newIdempotencyKey(), count });
	}
	async function importFile(): Promise<void> {
		const current = pending();
		if (current === null || busy()) return;
		setBusy(true);
		setFailure("import", undefined);
		const result = await props.api.importEquities(current.payload, current.key);
		if (disposed) return;
		setBusy(false);
		if (!result.ok) {
			setFailure("import", result.error);
			return;
		}
		setPending(null);
		setNotice(m().imported(result.value.recordCount));
		await Promise.all([
			loadCompanies(false, true),
			loadImports(),
			loadFacts(false, true),
			loadRecords(),
		]);
	}
	async function downloadImport(importId: string): Promise<void> {
		if (downloading().has(importId)) return;
		setDownloading((current) => new Set([...current, importId]));
		setFailure("download", undefined);
		const result = await props.api.getEquityImport(importId);
		if (disposed) return;
		setDownloading((current) => new Set([...current].filter((id) => id !== importId)));
		if (!result.ok) {
			setFailure("download", result.error);
			return;
		}
		downloadTextFile(
			document,
			`${importId}.json`,
			"application/json",
			JSON.stringify(result.value, null, 2),
		);
	}
	async function copyForResearch(): Promise<void> {
		const snapshot = equityResearchSnapshot(selected()?.issuerId ?? "", facts(), appliedCutoffs());
		if (snapshot === null) {
			setNotice(m().snapshotTooLarge);
			return;
		}
		try {
			await navigator.clipboard.writeText(snapshot);
			setNotice(m().copied);
		} catch {
			setNotice(m().copyFailed);
		}
	}
	onMount(() => {
		void loadCompanies();
		void loadImports();
	});
	return (
		<div class="space-y-4">
			<Section title={m().title}>
				<p class="mb-3 text-sm text-slate-600">{m().description}</p>
				<form
					class="flex flex-wrap items-end gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void loadCompanies();
					}}
				>
					<label class="flex min-w-0 flex-1 flex-col gap-1 text-sm">
						{m().search}
						<input
							class={INPUT}
							value={query()}
							onInput={(event) => setQuery(event.currentTarget.value)}
							maxlength={100}
						/>
					</label>
					<button class={BUTTON} type="submit" disabled={loading()}>
						{m().searchButton}
					</button>
				</form>
			</Section>
			<For each={Object.values(failures()).filter((error) => error !== undefined)}>
				{(error) => <ErrorNotice title={m().loadFailed} failure={error} />}
			</For>
			<Show when={notice()}>{(text) => <Notice tone="info">{text()}</Notice>}</Show>
			<Section title={m().importTitle}>
				<p class="mb-3 text-sm text-slate-600">{m().importHelp}</p>
				<div class="flex flex-wrap items-end gap-3">
					<label class="flex min-w-0 flex-1 flex-col gap-1 text-sm">
						{m().file}
						<input
							type="file"
							accept="application/json,.json"
							disabled={busy()}
							onChange={(event) => {
								void readFile(event.currentTarget.files?.[0]);
							}}
						/>
					</label>
					<button
						class={BUTTON_PRIMARY}
						type="button"
						disabled={pending() === null || busy()}
						onClick={() => {
							void importFile();
						}}
					>
						{m().importButton}
					</button>
				</div>
				<Show when={pending()}>
					{(item) => (
						<output class="mt-2 block text-sm text-slate-600">
							{m().importReady(item().count)} {item().payload.coverageNote}
						</output>
					)}
				</Show>
			</Section>
			<Section title={m().companies}>
				<Show when={loading()}>
					<Loading label={m().loading} />
				</Show>
				<Show
					when={!loading() && failures().companies === undefined && issuers().issuers.length === 0}
				>
					<Empty>{query() === "" ? m().empty : m().noMatches}</Empty>
				</Show>
				<ul class="divide-y divide-slate-200">
					<For each={issuers().issuers}>
						{(issuer) => (
							<li class="py-2">
								<button
									type="button"
									class="w-full rounded px-2 py-2 text-left text-sm hover:bg-slate-100"
									aria-pressed={selected()?.issuerId === issuer.issuerId}
									onClick={() => choose(issuer)}
								>
									<span class="font-semibold">{issuer.localName ?? issuer.legalName}</span>
									<span class="ml-2 text-slate-600">
										{issuer.symbols.join(" · ")} · {m().count(issuer.factCount)}
									</span>
								</button>
							</li>
						)}
					</For>
				</ul>
				<Show when={issuers().nextCursor !== null}>
					<button
						class={BUTTON}
						type="button"
						disabled={loading()}
						onClick={() => {
							void loadCompanies(true);
						}}
					>
						{m().more}
					</button>
				</Show>
			</Section>
			<Show when={selected()} fallback={<p class="text-sm text-slate-600">{m().choose}</p>}>
				{(issuer) => (
					<>
						<Section title={`${issuer().legalName} · ${m().statements}`}>
							<p class="mb-3 text-sm text-slate-600">{m().cutoffHelp}</p>
							<form
								class="flex flex-col gap-2 sm:flex-row sm:items-end"
								onSubmit={(event) => {
									event.preventDefault();
									void loadFacts();
								}}
							>
								<label class="flex min-w-0 flex-1 flex-col gap-1 text-sm">
									{m().informationCutoff}
									<input
										class={INPUT}
										value={informationCutoff()}
										placeholder={m().cutoffExample}
										onInput={(event) => setInformationCutoff(event.currentTarget.value)}
									/>
								</label>
								<label class="flex min-w-0 flex-1 flex-col gap-1 text-sm">
									{m().ingestionCutoff}
									<input
										class={INPUT}
										value={ingestionCutoff()}
										placeholder={m().cutoffExample}
										onInput={(event) => setIngestionCutoff(event.currentTarget.value)}
									/>
								</label>
								<button class={BUTTON} type="submit" disabled={detailsLoading()}>
									{m().apply}
								</button>
							</form>
							<Show when={detailsLoading()}>
								<Loading label={m().loading} />
							</Show>
							<Show
								when={
									!detailsLoading() && failures().facts === undefined && facts().facts.length === 0
								}
							>
								<Empty>{m().noFacts}</Empty>
							</Show>
							<section class="mt-3 overflow-x-auto" tabindex="0" aria-label={m().statements}>
								<table class="min-w-3xl w-full text-left text-sm">
									<thead>
										<tr>
											<For each={[m().metric, m().period, m().value, m().basis, m().source]}>
												{(title) => (
													<th class="border-b border-slate-300 px-2 py-2 font-semibold" scope="col">
														{title}
													</th>
												)}
											</For>
										</tr>
									</thead>
									<tbody>
										<For each={facts().facts}>
											{(fact) => (
												<tr class="border-b border-slate-200 align-top">
													<td class="px-2 py-2">
														{fact.metric.label}
														<details class="mt-1 text-xs text-slate-600">
															<summary>{m().provenance}</summary>
															<dl class="space-y-1">
																<dt>{m().factId}</dt>
																<dd class="break-all">{fact.factId}</dd>
																<dt>{m().sourceConcept}</dt>
																<dd class="break-all">{fact.sourceConcept}</dd>
																<dt>{m().sourceLocator}</dt>
																<dd class="break-all">{fact.sourceLocator}</dd>
																<dt>{m().knownAt}</dt>
																<dd>{fact.committedAt}</dd>
																<dt>{m().retrievedAt}</dt>
																<dd>{fact.document.retrievedAt}</dd>
																<Show when={fact.shareBasis}>
																	<dt>{m().shareBasis}</dt>
																	<dd>{fact.shareBasis}</dd>
																</Show>
																<dt>{m().dimensions}</dt>
																<dd class="break-all">{JSON.stringify(fact.dimensions)}</dd>
															</dl>
														</details>
													</td>
													<td class="px-2 py-2">
														{fact.statement.periodStart} {fact.statement.periodEnd}
														<div class="text-xs text-slate-600">{fact.statement.periodKind}</div>
													</td>
													<td class="whitespace-nowrap px-2 py-2 font-mono">
														<span>
															{fact.valueDecimal ?? `${m().unavailable}: ${fact.unavailableReason}`}
														</span>
														<div class="text-xs text-slate-600">
															{fact.metric.unit}{" "}
															{fact.metric.unit === "currency" ||
															fact.metric.unit === "currency-per-share"
																? fact.statement.reportingCurrency
																: ""}
														</div>
													</td>
													<td class="px-2 py-2">
														{fact.statement.accountingStandard}
														<div class="text-xs text-slate-600">
															{fact.filing.amendmentOfFilingId === null
																? m().originalDisclosure
																: m().amendmentOf(fact.filing.amendmentOfFilingId)}
														</div>
														<div>
															{fact.statement.scope === "consolidated"
																? m().consolidated
																: m().separate}
														</div>
														<div>
															{fact.actualOrEstimate === "actual" ? m().actual : m().estimate}
														</div>
													</td>
													<td class="px-2 py-2">
														<SafeLink url={fact.document.url}>{fact.document.title}</SafeLink>
														<div class="mt-1 text-xs text-slate-600">
															{fact.filing.publicAvailableAt ?? m().unknownAvailability}
														</div>
													</td>
												</tr>
											)}
										</For>
									</tbody>
								</table>
							</section>
							<div class="mt-3 flex flex-wrap gap-2">
								<Show when={facts().nextCursor !== null}>
									<button
										class={BUTTON}
										type="button"
										disabled={detailsLoading()}
										onClick={() => {
											void loadFacts(true);
										}}
									>
										{m().more}
									</button>
								</Show>
								<button
									class={BUTTON}
									type="button"
									disabled={facts().facts.length === 0 || detailsLoading()}
									onClick={() => {
										void copyForResearch();
									}}
								>
									{m().copy}
								</button>
							</div>
						</Section>
						<Section title={m().otherData}>
							<p class="mb-3 text-sm text-slate-600">{m().currentData}</p>
							<Show when={recordsLoading()}>
								<Loading label={m().loading} />
							</Show>
							<For each={records().records}>
								{(record) => (
									<details class="border-b border-slate-200 py-2 text-sm">
										<summary class="break-all">
											{record.recordType} · {record.recordId}
										</summary>
										<pre class="mt-2 whitespace-pre-wrap break-all text-xs">
											{JSON.stringify(record.body, null, 2)}
										</pre>
									</details>
								)}
							</For>
							<Show when={records().nextCursor !== null}>
								<button
									class={BUTTON}
									disabled={recordsLoading()}
									type="button"
									onClick={() => {
										void loadRecords(true);
									}}
								>
									{m().more}
								</button>
							</Show>
						</Section>
					</>
				)}
			</Show>
			<Section title={m().imports}>
				<Show when={importsLoading()}>
					<Loading label={m().loading} />
				</Show>
				<Show
					when={
						!importsLoading() && failures().imports === undefined && imports().imports.length === 0
					}
				>
					<Empty>{m().noImports}</Empty>
				</Show>
				<ul class="divide-y divide-slate-200">
					<For each={imports().imports}>
						{(item) => (
							<li class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
								<div>
									<time>{item.committedAt}</time>
									<p class="text-slate-600">{item.coverageNote}</p>
								</div>
								<button
									disabled={downloading().has(item.importId)}
									class={BUTTON}
									type="button"
									onClick={() => {
										void downloadImport(item.importId);
									}}
								>
									{m().download}
								</button>
							</li>
						)}
					</For>
				</ul>
				<Show when={imports().nextCursor !== null}>
					<button
						class={BUTTON}
						disabled={importsLoading()}
						type="button"
						onClick={() => {
							void loadImports(true);
						}}
					>
						{m().more}
					</button>
				</Show>
			</Section>
		</div>
	);
}
