import { MAX_REQUEST_BODY_BYTES, type WorkspaceSummary } from "@research/contracts";
import { DateText, SafeLink } from "@research/ui-registry";
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
import { downloadTextFile, fileSlug } from "../lib/download.ts";
import { formatInstant } from "../lib/format.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { createRemote, type Remote } from "../lib/remote.ts";
import { AgentSettingsSection } from "./AgentSettingsSection.tsx";

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
			setFailure({ title: "The credential was not issued.", error: result.error });
		}
	};

	const copyToken = async (token: string) => {
		let status: string;
		try {
			await navigator.clipboard.writeText(token);
			status = "Token copied to the clipboard.";
		} catch {
			// Clipboard access can be denied by the browser; the token stays visible to copy by hand.
			status = "Copying was blocked by the browser — select the token and copy it manually.";
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
		else setFailure({ title: "The credential was not revoked.", error: result.error });
	};

	return (
		<Section title="Runner credentials">
			<p class="text-xs text-slate-700">
				A credential lets the local runner on your PC claim jobs. It cannot act as you in this app.
			</p>
			<form
				aria-label="Issue runner credential"
				class="mt-2 flex flex-wrap items-start gap-2"
				onSubmit={issue}
			>
				<TextField label="Credential label" value={label()} onInput={setLabel} />
				<TextField
					label="Expires in days"
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
					Issue runner credential
				</button>
			</form>
			<Show when={failure()}>
				{(current) => <ErrorNotice failure={current().error} title={current().title} />}
			</Show>

			<Show when={issued()}>
				{(current) => (
					<section
						aria-label="New runner token"
						class="mt-2 rounded border border-amber-400 bg-amber-50 p-2"
					>
						<p role="alert" class="text-sm font-semibold text-amber-950">
							Copy this token now. It is shown only once and cannot be displayed again.
						</p>
						<p class="mt-1 text-xs text-slate-800">
							Credential “{current().credential.label}”, expires{" "}
							{formatInstant(current().credential.expiresAt)}.
						</p>
						<code
							data-field="runner-token"
							class="mt-1 block break-all rounded border border-slate-300 bg-white p-2 font-mono text-xs"
						>
							{current().token}
						</code>
						<div class="mt-2 flex flex-wrap items-center gap-2">
							<button type="button" class={BUTTON} onClick={() => void copyToken(current().token)}>
								Copy token
							</button>
							<button
								type="button"
								class={BUTTON}
								onClick={() => {
									setIssued(null);
									setCopyStatus(null);
								}}
							>
								I have stored the token — hide it
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
				label="runner credentials"
				onRetry={() => void credentials.reload()}
			>
				{(list) => (
					<Show
						when={list().length > 0}
						fallback={<Empty>No runner credentials issued yet.</Empty>}
					>
						<table class="mt-2 w-full border-collapse text-left text-xs">
							<caption class="caption-top text-left text-slate-600">
								Issued runner credentials (tokens are never shown again)
							</caption>
							<thead>
								<tr class="border-b border-slate-300">
									<th scope="col" class="pr-2">
										Label
									</th>
									<th scope="col" class="pr-2">
										Created
									</th>
									<th scope="col" class="pr-2">
										Expires
									</th>
									<th scope="col" class="pr-2">
										Last used
									</th>
									<th scope="col" class="pr-2">
										Status
									</th>
									<th scope="col">Actions</th>
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
													? "never used"
													: formatInstant(credential.lastUsedAt)}
											</td>
											<td class="pr-2" data-field="credential-status">
												{credential.revokedAt === null
													? "active"
													: `revoked ${formatInstant(credential.revokedAt)}`}
											</td>
											<td>
												<Show when={credential.revokedAt === null}>
													<button
														type="button"
														class={BUTTON_DANGER}
														aria-label={`Revoke ${credential.label}`}
														disabled={busy()}
														onClick={() => void revoke(credential.credentialId)}
													>
														Revoke
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

/* ---------- Approved image assets ---------- */

function ApprovedAssets(props: { readonly api: ApiClient }): JSX.Element {
	const assets = createRemote(() => props.api.listAssets());
	const [imageUrl, setImageUrl] = createSignal("");
	const [altText, setAltText] = createSignal("");
	const [permissionBasis, setPermissionBasis] = createSignal("");
	const [sourceEvidenceId, setSourceEvidenceId] = createSignal("");
	const [failure, setFailure] = createSignal<ActionFailure | null>(null);
	const [busy, setBusy] = createSignal(false);

	const approve = async (event: SubmitEvent) => {
		event.preventDefault();
		if (busy()) return;
		setBusy(true);
		setFailure(null);
		const result = await props.api.approveAsset({
			imageUrl: imageUrl().trim(),
			altText: altText(),
			permissionBasis: permissionBasis(),
			sourceEvidenceId: sourceEvidenceId().trim() === "" ? null : sourceEvidenceId().trim(),
		});
		setBusy(false);
		if (result.ok) {
			setImageUrl("");
			setAltText("");
			setPermissionBasis("");
			setSourceEvidenceId("");
			await assets.reload();
		} else {
			setFailure({ title: "The image was not approved.", error: result.error });
		}
	};

	const remove = async (assetId: string) => {
		if (busy()) return;
		setBusy(true);
		setFailure(null);
		const result = await props.api.deleteAsset(assetId);
		setBusy(false);
		if (result.ok) await assets.reload();
		else setFailure({ title: "The image was not removed.", error: result.error });
	};

	return (
		<Section title="Approved images">
			<p class="text-xs text-slate-700">
				Only images you approve here, with a stated permission basis, can appear in a workspace.
			</p>
			<form
				aria-label="Approve image"
				class="mt-2 flex flex-wrap items-start gap-2"
				onSubmit={approve}
			>
				<TextField
					label="Image URL"
					type="url"
					value={imageUrl()}
					onInput={setImageUrl}
					hint="https only"
				/>
				<TextField label="Alt text" value={altText()} onInput={setAltText} />
				<TextField
					label="Permission basis"
					value={permissionBasis()}
					onInput={setPermissionBasis}
					hint="e.g. press kit, licence, own work"
				/>
				<TextField
					label="Source evidence id (optional)"
					value={sourceEvidenceId()}
					onInput={setSourceEvidenceId}
				/>
				<button
					type="submit"
					class={`${BUTTON_PRIMARY} mt-4`}
					disabled={
						busy() ||
						imageUrl().trim() === "" ||
						altText().trim() === "" ||
						permissionBasis().trim() === ""
					}
				>
					Approve image
				</button>
			</form>
			<Show when={failure()}>
				{(current) => <ErrorNotice failure={current().error} title={current().title} />}
			</Show>
			<RemoteView
				remote={assets.state()}
				label="approved images"
				onRetry={() => void assets.reload()}
			>
				{(list) => (
					<Show when={list().length > 0} fallback={<Empty>No images approved yet.</Empty>}>
						<ul aria-label="Approved image list" class="mt-2 space-y-1 text-xs">
							<For each={list()}>
								{(asset) => (
									<li
										data-asset-id={asset.assetId}
										class="flex flex-wrap items-start justify-between gap-2 rounded border border-slate-200 p-2"
									>
										<div class="min-w-0">
											<p class="font-mono text-slate-600">{asset.assetId}</p>
											<p>
												<SafeLink url={asset.imageUrl}>{asset.imageUrl}</SafeLink>
											</p>
											<p>Alt text: {asset.altText}</p>
											<p>Permission: {asset.permissionBasis}</p>
											<p class="text-slate-600">
												Approved <DateText iso={asset.createdAt} missing="date not stated" />
												{asset.sourceEvidenceId === null
													? ""
													: ` · source evidence ${asset.sourceEvidenceId}`}
											</p>
										</div>
										<button
											type="button"
											class={BUTTON_DANGER}
											aria-label={`Remove image ${asset.assetId}`}
											disabled={busy()}
											onClick={() => void remove(asset.assetId)}
										>
											Remove
										</button>
									</li>
								)}
							</For>
						</ul>
					</Show>
				)}
			</RemoteView>
		</Section>
	);
}

/* ---------- Export / import ---------- */

function parseJsonFile(
	text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
	try {
		const value: unknown = JSON.parse(text);
		return { ok: true, value };
	} catch {
		// Not JSON at all: reported to the owner as an invalid import file.
		return { ok: false };
	}
}

function invalidFile(message: string): ActionFailure {
	return {
		title: "The file was not imported.",
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
				setFailure({ title: "The JSON export failed.", error: result.error });
			}
		} else {
			const result = await props.api.exportWorkspaceMarkdown(workspace.workspaceId);
			if (result.ok) downloadTextFile(document, `${baseName}.md`, "text/markdown", result.value);
			else setFailure({ title: "The Markdown export failed.", error: result.error });
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
			setFailure(
				invalidFile(`The file is larger than the ${MAX_REQUEST_BODY_BYTES} byte import limit.`),
			);
		} else {
			const parsed = parseJsonFile(await file.text());
			if (!parsed.ok) {
				setFailure(invalidFile("The file is not valid JSON."));
			} else {
				const result = await props.api.importWorkspace(parsed.value);
				if (result.ok) {
					setImported(result.value);
					await workspaces.reload();
				} else {
					setFailure({ title: "The file was not imported.", error: result.error });
				}
			}
		}
		// Allow choosing the same file again after fixing it.
		input.value = "";
		setBusy(false);
	};

	return (
		<Section title="Export and import">
			<p class="text-xs text-slate-700">
				Exports are versioned and include citations. Imports are validated; an invalid file is
				rejected and changes nothing.
			</p>
			<RemoteView
				remote={workspaces.state()}
				label="workspaces"
				onRetry={() => void workspaces.reload()}
			>
				{(list) => (
					<div class="mt-2 flex flex-wrap items-end gap-2">
						<div>
							<label for={pickerId} class={LABEL}>
								Workspace to export
							</label>
							<Select id={pickerId} onChange={(event) => setSelectedId(event.currentTarget.value)}>
								<option value="" selected={selectedId() === ""}>
									{list().length === 0 ? "No workspaces yet" : "Choose a workspace…"}
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
							Download JSON export
						</button>
						<button
							type="button"
							class={BUTTON}
							disabled={busy() || selected() === null}
							onClick={() => void exportAs("markdown")}
						>
							Download Markdown export
						</button>
					</div>
				)}
			</RemoteView>
			<div class="mt-3">
				<label for={fileId} class={LABEL}>
					Import workspace file (JSON export)
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
							Imported as “{workspace().title}”.{" "}
							<button
								type="button"
								class={BUTTON}
								onClick={() => props.onOpenWorkspace(workspace().workspaceId)}
							>
								Open imported workspace
							</button>
						</Notice>
					</div>
				)}
			</Show>
		</Section>
	);
}

/** Settings: AI agent, session, runner credentials, approved images, export/import. */
export function SettingsView(props: {
	readonly api: ApiClient;
	readonly session: Remote<Session>;
	/** From the `#/settings/agent` route marker; focuses the AI agent section. */
	readonly agentSection: string | null;
	readonly visibility: VisibilitySource;
	readonly onReloadSession: () => void;
	readonly onOpenWorkspace: (workspaceId: string) => void;
}): JSX.Element {
	return (
		<div class="space-y-3">
			<AgentSettingsSection
				api={props.api}
				agentSection={props.agentSection}
				visibility={props.visibility}
			/>
			<Section title="Session">
				<RemoteView remote={props.session} label="session" onRetry={props.onReloadSession}>
					{(session) => (
						<dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
							<dt class="text-slate-600">Owner id</dt>
							<dd data-field="owner-id" class="font-mono">
								{session().ownerId}
							</dd>
							<dt class="text-slate-600">Sign-in method</dt>
							<dd data-field="auth-mode">{session().authMode}</dd>
							<dt class="text-slate-600">Environment</dt>
							<dd data-field="environment">{session().environment}</dd>
						</dl>
					)}
				</RemoteView>
			</Section>
			<RunnerCredentials api={props.api} />
			<ApprovedAssets api={props.api} />
			<ExportImport api={props.api} onOpenWorkspace={props.onOpenWorkspace} />
		</div>
	);
}
