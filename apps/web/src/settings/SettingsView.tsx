import { MAX_REQUEST_BODY_BYTES, type WorkspaceSummary } from "@research/contracts";
import { parseJson } from "@research/domain";
import type { MessagesOf } from "@research/i18n";
import { useMessages } from "@research/i18n/solid";
import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import type { ApiClient, IssuedRunnerCredential, Session } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import {
	BUTTON,
	BUTTON_DANGER,
	BUTTON_PRIMARY,
	Empty,
	ErrorNotice,
	Field,
	INPUT,
	LABEL,
	Notice,
	RemoteView,
	Section,
	Select,
} from "../components/ui.tsx";
import type { LocaleState } from "../i18n/localeState.ts";
import { downloadTextFile, fileSlug } from "../lib/download.ts";
import { formatInstant } from "../lib/format.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { createRemote, type Remote } from "../lib/remote.ts";
import { AgentSettingsSection } from "./AgentSettingsSection.tsx";
import { CalendarSettingsSection } from "./CalendarSettingsSection.tsx";
import { LanguageSettingsSection } from "./LanguageSettingsSection.tsx";
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
		<Field label={props.label} hint={props.hint} layoutClass="min-w-40 flex-1">
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
		<Section title={m().credentialsTitle}>
			<p class="text-xs text-slate-700">{m().credentialsIntro}</p>
			<form
				aria-label={m().issueFormLabel}
				class="mt-2 flex flex-wrap items-start gap-2"
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
						class="mt-2 rounded border border-amber-400 bg-amber-50 p-2"
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
							<button type="button" class={BUTTON} onClick={() => void copyToken(current().token)}>
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

			<RemoteView
				remote={credentials.state()}
				label={m().credentialsThing}
				onRetry={() => void credentials.reload()}
			>
				{(list) => (
					<Show when={list().length > 0} fallback={<Empty>{m().noCredentials}</Empty>}>
						<table class="mt-2 w-full border-collapse text-left text-xs">
							<caption class="caption-top text-left text-slate-600">
								{m().credentialsCaption}
							</caption>
							<thead>
								<tr class="border-b border-slate-300">
									<th scope="col" class="pr-2">
										{m().columnLabel}
									</th>
									<th scope="col" class="pr-2">
										{m().columnCreated}
									</th>
									<th scope="col" class="pr-2">
										{m().columnExpires}
									</th>
									<th scope="col" class="pr-2">
										{m().columnLastUsed}
									</th>
									<th scope="col" class="pr-2">
										{m().columnStatus}
									</th>
									<th scope="col">{m().columnActions}</th>
								</tr>
							</thead>
							<tbody>
								<For each={list()}>
									{(credential) => (
										<tr
											class="border-b border-slate-200"
											data-credential-id={credential.credentialId}
										>
											<th scope="row" class="py-1 pr-2 font-medium">
												{credential.label}
											</th>
											<td class="pr-2">{formatInstant(credential.createdAt)}</td>
											<td class="pr-2">{formatInstant(credential.expiresAt)}</td>
											<td class="pr-2">
												{credential.lastUsedAt === null
													? m().neverUsed
													: formatInstant(credential.lastUsedAt)}
											</td>
											<td class="pr-2" data-field="credential-status">
												{credential.revokedAt === null
													? m().active
													: m().revokedAt(formatInstant(credential.revokedAt))}
											</td>
											<td>
												<Show when={credential.revokedAt === null}>
													<button
														type="button"
														class={BUTTON_DANGER}
														aria-label={m().revokeNamed(credential.label)}
														disabled={busy()}
														onClick={() => void revoke(credential.credentialId)}
													>
														{m().revoke}
													</button>
												</Show>
											</td>
										</tr>
									)}
								</For>
							</tbody>
						</table>
					</Show>
				)}
			</RemoteView>
		</Section>
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
		setFailure(null);
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
				setFailure({ title: m().jsonExportFailed, error: result.error });
			}
		} else {
			const result = await props.api.exportWorkspaceMarkdown(workspace.workspaceId);
			if (result.ok) downloadTextFile(document, `${baseName}.md`, "text/markdown", result.value);
			else setFailure({ title: m().markdownExportFailed, error: result.error });
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
		<Section title={m().exportTitle}>
			<p class="text-xs text-slate-700">{m().exportIntro}</p>
			<RemoteView
				remote={workspaces.state()}
				label={m().workspacesThing}
				onRetry={() => void workspaces.reload()}
			>
				{(list) => (
					<div class="mt-2 flex flex-wrap items-end gap-2">
						<div>
							<label for={pickerId} class={LABEL}>
								{m().workspaceToExport}
							</label>
							<Select id={pickerId} onChange={(event) => setSelectedId(event.currentTarget.value)}>
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
						</div>
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
				)}
			</RemoteView>
			<div class="mt-3">
				<label for={fileId} class={LABEL}>
					{m().importFile}
				</label>
				<input
					id={fileId}
					type="file"
					accept="application/json,.json"
					class="text-xs"
					disabled={busy()}
					onChange={(event) => void importFile(event.currentTarget)}
				/>
			</div>
			<Show when={failure()}>
				{(current) => <ErrorNotice failure={current().error} title={current().title} />}
			</Show>
			<Show when={imported()}>
				{(workspace) => (
					<div class="mt-2">
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
					</div>
				)}
			</Show>
		</Section>
	);
}

/** Settings: AI agent, calendar, language, session, runner credentials, export/import. */
export function SettingsView(props: {
	readonly api: ApiClient;
	readonly session: Remote<Session>;
	/**
	 * The route's sub-section marker: `agent` focuses the AI agent section,
	 * `calendar` the Calendar section.
	 */
	readonly section: string | null;
	readonly visibility: VisibilitySource;
	/** The UI language and its stored choice (ADR-0032). */
	readonly localeState: LocaleState;
	readonly onReloadSession: () => void;
	readonly onOpenWorkspace: (workspaceId: string) => void;
}): JSX.Element {
	const m = useMessages(settingsMessages);
	return (
		<div class="space-y-3">
			<AgentSettingsSection
				api={props.api}
				agentSection={props.section}
				visibility={props.visibility}
			/>
			<CalendarSettingsSection
				api={props.api}
				visibility={props.visibility}
				section={props.section}
			/>
			<LanguageSettingsSection localeState={props.localeState} />
			<Section title={m().sessionTitle}>
				<RemoteView remote={props.session} label={m().sessionThing} onRetry={props.onReloadSession}>
					{(session) => (
						<dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
							<dt class="text-slate-600">{m().ownerId}</dt>
							<dd data-field="owner-id" class="font-mono">
								{session().ownerId}
							</dd>
							<dt class="text-slate-600">{m().signInMethod}</dt>
							<dd data-field="auth-mode">{session().authMode}</dd>
							<dt class="text-slate-600">{m().environment}</dt>
							<dd data-field="environment">{session().environment}</dd>
						</dl>
					)}
				</RemoteView>
			</Section>
			<RunnerCredentials api={props.api} />
			<ExportImport api={props.api} onOpenWorkspace={props.onOpenWorkspace} />
		</div>
	);
}
