import { MAX_REQUEST_BODY_BYTES, type WorkspaceSummary } from "@research/contracts";
import { parseJson } from "@research/domain";
import type { MessagesOf } from "@research/i18n";
import { useMessages } from "@research/i18n/solid";
import {
	batch,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { ApiClient, IssuedRunnerCredential } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { focusTab, tabElementId, tabKeyTarget } from "../components/Tabs.tsx";
import {
	BUTTON,
	BUTTON_DANGER,
	BUTTON_PRIMARY,
	Empty,
	ErrorNotice,
	Field,
	type IconButtonName,
	IconGlyph,
	INPUT,
	Notice,
	RemoteView,
	Select,
} from "../components/ui.tsx";
import type { LocaleState } from "../i18n/localeState.ts";
import { downloadTextFile, fileSlug } from "../lib/download.ts";
import { formatInstant } from "../lib/format.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { createRemote } from "../lib/remote.ts";
import { SETTINGS_SECTIONS, type SettingsSection } from "../router.ts";
import { AgentSettingsSection } from "./AgentSettingsSection.tsx";
import { agentSettingsMessages } from "./agentSettings.messages.ts";
import { CalendarSettingsSection } from "./CalendarSettingsSection.tsx";
import { calendarSettingsMessages } from "./calendarSettings.messages.tsx";
import { LanguageSettingsSection } from "./LanguageSettingsSection.tsx";
import { settingsLanguageMessages } from "./languageSettings.messages.ts";
import { SettingRow, SettingsPane } from "./SettingsLayout.tsx";
import { settingsMessages } from "./settings.messages.ts";

interface ActionFailure {
	readonly title: string;
	readonly error: ApiFailure;
}

function TextField(props: {
	readonly label: string;
	readonly value: string;
	readonly onInput: (value: string) => void;
	readonly type?: "text" | "url" | "number";
	readonly min?: number;
	readonly max?: number;
	readonly hint?: string;
}): JSX.Element {
	return (
		<Field label={props.label} hint={props.hint} layoutClass="min-w-0 flex-[1_1_10rem]">
			{(fieldId) => (
				<input
					id={fieldId}
					type={props.type ?? "text"}
					class={INPUT}
					min={props.min}
					max={props.max}
					value={props.value}
					onInput={(event) => props.onInput(event.currentTarget.value)}
				/>
			)}
		</Field>
	);
}

/* ---------- Runner credentials ---------- */

function RunnerCredentials(props: { readonly api: ApiClient }): JSX.Element {
	const m = useMessages(settingsMessages);
	const credentials = createRemote(() => props.api.listRunnerCredentials());
	const [label, setLabel] = createSignal("");
	const [expiresInDays, setExpiresInDays] = createSignal("30");
	// The token lives only in this signal: never in storage, and gone once dismissed (SEC-005).
	const [issued, setIssued] = createSignal<IssuedRunnerCredential | null>(null);
	const [copyStatus, setCopyStatus] = createSignal<string | null>(null);
	const [failure, setFailure] = createSignal<ActionFailure | null>(null);
	const [busy, setBusy] = createSignal(false);

	const issue = async (event: SubmitEvent) => {
		event.preventDefault();
		if (busy()) return;
		setBusy(true);
		setFailure(null);
		setCopyStatus(null);
		const result = await props.api.issueRunnerCredential({
			label: label().trim(),
			expiresInDays: Number(expiresInDays()),
		});
		setBusy(false);
		if (result.ok) {
			setIssued(result.value);
			setLabel("");
			await credentials.reload();
		} else {
			setFailure({ title: m().notIssued, error: result.error });
		}
	};

	const copyToken = async (token: string) => {
		let status: string;
		try {
			await navigator.clipboard.writeText(token);
			status = m().tokenCopied;
		} catch {
			// Clipboard access can be denied by the browser; the token stays visible to copy by hand.
			status = m().copyBlocked;
		}
		// The outcome belongs to the token it was started for: if that token has been hidden or
		// replaced meanwhile, saying "copied" next to another token would be false.
		if (issued()?.token === token) setCopyStatus(status);
	};

	const revoke = async (credentialId: string) => {
		if (busy()) return;
		setBusy(true);
		setFailure(null);
		const result = await props.api.revokeRunnerCredential(credentialId);
		setBusy(false);
		if (result.ok) await credentials.reload();
		else setFailure({ title: m().notRevoked, error: result.error });
	};

	return (
		<SettingsPane title={m().credentialsTitle} intro={m().credentialsIntro}>
			<SettingRow
				label={m().newCredentialTitle}
				description={m().newCredentialHint}
				below={
					<>
						<form
							aria-label={m().issueFormLabel}
							class="flex flex-wrap items-start gap-2"
							onSubmit={issue}
						>
							<TextField label={m().credentialLabel} value={label()} onInput={setLabel} />
							<TextField
								label={m().expiresInDays}
								type="number"
								min={1}
								max={90}
								value={expiresInDays()}
								onInput={setExpiresInDays}
								hint="1–90"
							/>
							<button
								type="submit"
								class={`${BUTTON_PRIMARY} mt-4`}
								disabled={busy() || label().trim() === ""}
							>
								{m().issueCredential}
							</button>
						</form>
						<Show when={failure()}>
							{(current) => <ErrorNotice failure={current().error} title={current().title} />}
						</Show>
						<Show when={issued()}>
							{(current) => (
								<section
									aria-label={m().newTokenLabel}
									class="rounded border border-amber-400 bg-amber-50 p-2"
								>
									<p role="alert" class="text-sm font-semibold text-amber-950">
										{m().copyTokenNow}
									</p>
									<p class="mt-1 text-xs text-slate-800">
										{m().credentialExpires(
											current().credential.label,
											formatInstant(current().credential.expiresAt),
										)}
									</p>
									<code
										data-field="runner-token"
										class="mt-1 block break-all rounded border border-slate-300 bg-white p-2 font-mono text-xs"
									>
										{current().token}
									</code>
									<div class="mt-2 flex flex-wrap items-center gap-2">
										<button
											type="button"
											class={BUTTON}
											onClick={() => void copyToken(current().token)}
										>
											{m().copyToken}
										</button>
										<button
											type="button"
											class={BUTTON}
											onClick={() => {
												setIssued(null);
												setCopyStatus(null);
											}}
										>
											{m().hideToken}
										</button>
										<Show when={copyStatus()}>
											{(text) => <output class="text-xs text-slate-800">{text()}</output>}
										</Show>
									</div>
								</section>
							)}
						</Show>
					</>
				}
			/>
			<SettingRow
				label={m().issuedTitle}
				heading
				description={m().issuedHint}
				below={
					<RemoteView
						remote={credentials.state()}
						label={m().credentialsThing}
						onRetry={() => void credentials.reload()}
					>
						{(list) => (
							<Show when={list().length > 0} fallback={<Empty>{m().noCredentials}</Empty>}>
								<ul aria-label={m().issuedTitle} class="divide-y divide-slate-200">
									<For each={list()}>
										{(credential) => (
											<li
												class="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
												data-credential-id={credential.credentialId}
											>
												<div class="min-w-0">
													<p class="text-sm font-medium text-slate-900">
														{credential.label}
														<span
															class="ml-2 text-xs font-normal text-slate-700"
															data-field="credential-status"
														>
															{credential.revokedAt === null
																? m().active
																: m().revokedAt(formatInstant(credential.revokedAt))}
														</span>
													</p>
													<p class="text-2xs text-slate-600">
														{m().createdAt(formatInstant(credential.createdAt))} ·{" "}
														{m().expiresAt(formatInstant(credential.expiresAt))} ·{" "}
														{credential.lastUsedAt === null
															? m().neverUsed
															: m().lastUsedAt(formatInstant(credential.lastUsedAt))}
													</p>
												</div>
												<Show when={credential.revokedAt === null}>
													<button
														type="button"
														class={`${BUTTON_DANGER} self-start sm:self-auto`}
														aria-label={m().revokeNamed(credential.label)}
														disabled={busy()}
														onClick={() => void revoke(credential.credentialId)}
													>
														{m().revoke}
													</button>
												</Show>
											</li>
										)}
									</For>
								</ul>
							</Show>
						)}
					</RemoteView>
				}
			/>
		</SettingsPane>
	);
}

/* ---------- Export / import ---------- */

function invalidFile(message: string, text: MessagesOf<typeof settingsMessages>): ActionFailure {
	return {
		title: text.notImported,
		error: {
			kind: "invalid-request",
			code: "INVALID_REQUEST",
			status: null,
			message,
			detail: null,
			issues: [],
		},
	};
}

function ExportImport(props: {
	readonly api: ApiClient;
	readonly onOpenWorkspace: (workspaceId: string) => void;
}): JSX.Element {
	const m = useMessages(settingsMessages);
	const workspaces = createRemote(() => props.api.listWorkspaces());
	const [selectedId, setSelectedId] = createSignal("");
	// Each row shows its own failure, under the control that caused it.
	const [exportFailure, setExportFailure] = createSignal<ActionFailure | null>(null);
	const [failure, setFailure] = createSignal<ActionFailure | null>(null);
	const [imported, setImported] = createSignal<WorkspaceSummary | null>(null);
	const [busy, setBusy] = createSignal(false);
	const pickerId = createUniqueId();
	const fileId = createUniqueId();

	const selected = () =>
		(workspaces.value() ?? []).find((workspace) => workspace.workspaceId === selectedId()) ?? null;

	const exportAs = async (format: "json" | "markdown") => {
		const workspace = selected();
		if (workspace === null || busy()) return;
		setBusy(true);
		setExportFailure(null);
		const baseName = `${fileSlug(workspace.title)}-export`;
		if (format === "json") {
			const result = await props.api.exportWorkspaceJson(workspace.workspaceId);
			if (result.ok) {
				downloadTextFile(
					document,
					`${baseName}.json`,
					"application/json",
					JSON.stringify(result.value, null, 2),
				);
			} else {
				setExportFailure({ title: m().jsonExportFailed, error: result.error });
			}
		} else {
			const result = await props.api.exportWorkspaceMarkdown(workspace.workspaceId);
			if (result.ok) downloadTextFile(document, `${baseName}.md`, "text/markdown", result.value);
			else setExportFailure({ title: m().markdownExportFailed, error: result.error });
		}
		setBusy(false);
	};

	const importFile = async (input: HTMLInputElement) => {
		const file = input.files?.[0];
		if (file === undefined || busy()) return;
		setBusy(true);
		setFailure(null);
		setImported(null);
		if (file.size > MAX_REQUEST_BODY_BYTES) {
			setFailure(invalidFile(m().fileTooLarge(MAX_REQUEST_BODY_BYTES), m()));
		} else {
			const parsed = parseJson(await file.text());
			if (!parsed.ok) {
				setFailure(invalidFile(m().fileNotJson, m()));
			} else {
				const result = await props.api.importWorkspace(parsed.value);
				if (result.ok) {
					setImported(result.value);
					await workspaces.reload();
				} else {
					setFailure({ title: m().notImported, error: result.error });
				}
			}
		}
		// Allow choosing the same file again after fixing it.
		input.value = "";
		setBusy(false);
	};

	return (
		<SettingsPane title={m().exportTitle} intro={m().exportIntro}>
			<SettingRow
				label={m().workspaceToExport}
				labelFor={pickerId}
				description={m().exportHint}
				control={
					<RemoteView
						remote={workspaces.state()}
						label={m().workspacesThing}
						onRetry={() => void workspaces.reload()}
					>
						{(list) => (
							<div class="space-y-1">
								<Select
									id={pickerId}
									onChange={(event) => setSelectedId(event.currentTarget.value)}
								>
									<option value="" selected={selectedId() === ""}>
										{list().length === 0 ? m().noWorkspaces : m().chooseWorkspace}
									</option>
									<For each={list()}>
										{(workspace) => (
											<option
												value={workspace.workspaceId}
												selected={workspace.workspaceId === selectedId()}
											>
												{workspace.title}
											</option>
										)}
									</For>
								</Select>
								<div class="flex flex-wrap gap-1">
									<button
										type="button"
										class={BUTTON}
										disabled={busy() || selected() === null}
										onClick={() => void exportAs("json")}
									>
										{m().downloadJson}
									</button>
									<button
										type="button"
										class={BUTTON}
										disabled={busy() || selected() === null}
										onClick={() => void exportAs("markdown")}
									>
										{m().downloadMarkdown}
									</button>
								</div>
							</div>
						)}
					</RemoteView>
				}
				below={
					<Show when={exportFailure()}>
						{(current) => <ErrorNotice failure={current().error} title={current().title} />}
					</Show>
				}
			/>
			<SettingRow
				label={m().importFile}
				labelFor={fileId}
				description={m().importHint}
				control={
					<input
						id={fileId}
						type="file"
						accept="application/json,.json"
						class="w-full text-xs text-slate-700 file:mr-2 file:min-h-6 file:cursor-pointer file:rounded file:border-0 file:bg-slate-200 file:px-2 file:py-1 file:text-xs file:font-medium file:text-slate-900 hover:file:bg-slate-300 disabled:opacity-50"
						disabled={busy()}
						onChange={(event) => void importFile(event.currentTarget)}
					/>
				}
				below={
					<>
						<Show when={failure()}>
							{(current) => <ErrorNotice failure={current().error} title={current().title} />}
						</Show>
						<Show when={imported()}>
							{(workspace) => (
								<Notice tone="success">
									{m().importedAs(workspace().title)}{" "}
									<button
										type="button"
										class={BUTTON}
										onClick={() => props.onOpenWorkspace(workspace().workspaceId)}
									>
										{m().openImported}
									</button>
								</Notice>
							)}
						</Show>
					</>
				}
			/>
		</SettingsPane>
	);
}

const CATEGORY_ICONS: { readonly [S in SettingsSection]: IconButtonName } = {
	agent: "cpu",
	calendar: "calendar3",
	language: "globe2",
	runner: "key",
	data: "database",
};

/** The key a vertical list's ↑ / ↓ stand for in the shared tab-strip keys (← / →). */
function horizontalKey(key: string): string {
	if (key === "ArrowDown") return "ArrowRight";
	if (key === "ArrowUp") return "ArrowLeft";
	return key;
}

/**
 * Settings (ADR-0052), in the manner of ChatGPT's settings: the categories
 * listed on the left with their icons, one category's settings on the right.
 * The list is a WAI-ARIA tab list with automatic activation — one tab stop,
 * ↑ / ↓ (and ← / →) move and wrap, Home / End jump — and each category is a
 * tab panel, mounted the first time it is shown and kept while the page is
 * open, so a half-filled form survives a look at another category. Below the
 * `md` breakpoint the list is a row above the pane that scrolls sideways.
 */
export function SettingsView(props: {
	readonly api: ApiClient;
	/** The route's category; null (`#/settings`) shows the AI agent. */
	readonly section: SettingsSection | null;
	/** A category chosen in the list: the caller puts it in the URL. */
	readonly onSelectSection: (section: SettingsSection) => void;
	readonly visibility: VisibilitySource;
	/** The UI language and its stored choice (ADR-0032). */
	readonly localeState: LocaleState;
	readonly onOpenWorkspace: (workspaceId: string) => void;
}): JSX.Element {
	const m = useMessages(settingsMessages);
	const agentText = useMessages(agentSettingsMessages);
	const calendarText = useMessages(calendarSettingsMessages);
	const languageText = useMessages(settingsLanguageMessages);
	const idPrefix = `settings-${createUniqueId()}`;
	const panelId = (section: SettingsSection): string => `${idPrefix}-panel-${section}`;
	const selected = (): SettingsSection => props.section ?? "agent";
	// The category a link brought the owner to (`#/settings/agent` focuses the
	// backend select, `#/settings/calendar` the Calendar heading). A choice in
	// the list is in the route too, but it is not a link: it clears the target
	// before the route changes, so no pane ever sees itself linked while the
	// owner walks the list, and focus stays on the tab.
	const [linked, setLinked] = createSignal<SettingsSection | null>(props.section);
	/** The category this view just asked the router for, until the route shows it. */
	let pendingChoice: SettingsSection | null = null;
	// The router sets an equal route again when the browser's `hashchange`
	// follows a navigation; only a different category is an arrival.
	const routeSection = createMemo(() => props.section);
	createEffect(
		on(
			routeSection,
			(section) => {
				const ownChoice = pendingChoice !== null && section === pendingChoice;
				pendingChoice = null;
				if (!ownChoice) setLinked(section);
			},
			{ defer: true },
		),
	);
	const [shown, setShown] = createSignal<ReadonlySet<SettingsSection>>(new Set([selected()]));
	createEffect(() => {
		const current = selected();
		setShown((previous) => (previous.has(current) ? previous : new Set([...previous, current])));
	});
	const mounted = (section: SettingsSection): boolean =>
		section === selected() || shown().has(section);

	// The list is a column from `md` (48rem) up and a row below it; its
	// orientation tells assistive technology which arrows to expect (both work).
	const wideQuery =
		typeof window !== "undefined" && typeof window.matchMedia === "function"
			? window.matchMedia("(min-width: 48rem)")
			: null;
	const [wide, setWide] = createSignal(wideQuery?.matches ?? true);
	if (wideQuery !== null) {
		const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
		wideQuery.addEventListener("change", onChange);
		onCleanup(() => wideQuery.removeEventListener("change", onChange));
	}
	// A link to a later category on a phone: bring its tab into the row's view.
	onMount(() => {
		const tab = document.getElementById(tabElementId(idPrefix, selected()));
		if (tab instanceof HTMLElement && typeof tab.scrollIntoView === "function") {
			tab.scrollIntoView({ block: "nearest", inline: "nearest" });
		}
	});

	const label = (section: SettingsSection): string => {
		switch (section) {
			case "agent":
				return agentText().title;
			case "calendar":
				return calendarText().title;
			case "language":
				return languageText().title;
			case "runner":
				return m().credentialsTitle;
			case "data":
				return m().exportTitle;
		}
	};
	const choose = (section: SettingsSection): void => {
		batch(() => {
			setLinked(null);
			if (section === selected()) return;
			pendingChoice = section;
			props.onSelectSection(section);
		});
	};
	const move = (event: KeyboardEvent, index: number): void => {
		const target = tabKeyTarget(horizontalKey(event.key), index, SETTINGS_SECTIONS.length);
		if (target === null) return;
		event.preventDefault();
		const section = SETTINGS_SECTIONS[target];
		if (section === undefined) return;
		choose(section);
		focusTab(idPrefix, section);
	};
	const panel = (section: SettingsSection): JSX.Element => {
		switch (section) {
			case "agent":
				return (
					<AgentSettingsSection
						api={props.api}
						agentSection={linked()}
						visibility={props.visibility}
					/>
				);
			case "calendar":
				return (
					<CalendarSettingsSection
						api={props.api}
						visibility={props.visibility}
						section={linked()}
					/>
				);
			case "language":
				return <LanguageSettingsSection localeState={props.localeState} />;
			case "runner":
				return <RunnerCredentials api={props.api} />;
			case "data":
				return <ExportImport api={props.api} onOpenWorkspace={props.onOpenWorkspace} />;
		}
	};

	return (
		<div class="w-full max-w-4xl overflow-hidden rounded border border-slate-300 bg-white md:grid md:grid-cols-[14rem_minmax(0,1fr)]">
			<div
				role="tablist"
				aria-label={m().categoriesLabel}
				aria-orientation={wide() ? "vertical" : "horizontal"}
				class="flex gap-1 overflow-x-auto border-b border-slate-200 p-2 md:flex-col md:overflow-visible md:border-r md:border-b-0"
			>
				<For each={SETTINGS_SECTIONS}>
					{(section, index) => (
						<button
							type="button"
							role="tab"
							id={tabElementId(idPrefix, section)}
							data-settings-category={section}
							aria-selected={section === selected()}
							aria-controls={panelId(section)}
							tabIndex={section === selected() ? 0 : -1}
							class="flex min-h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded px-2 md:whitespace-normal py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 aria-selected:bg-slate-200 aria-selected:font-medium aria-selected:text-slate-900 md:w-full"
							onClick={() => choose(section)}
							onKeyDown={(event) => move(event, index())}
						>
							<span class="flex shrink-0">
								<IconGlyph name={CATEGORY_ICONS[section]} />
							</span>
							<span>{label(section)}</span>
						</button>
					)}
				</For>
			</div>
			<div class="min-w-0 p-4">
				<For each={SETTINGS_SECTIONS}>
					{(section) => (
						<div
							role="tabpanel"
							id={panelId(section)}
							aria-labelledby={tabElementId(idPrefix, section)}
							hidden={section !== selected()}
						>
							<Show when={mounted(section)}>{panel(section)}</Show>
						</div>
					)}
				</For>
			</div>
		</div>
	);
}
