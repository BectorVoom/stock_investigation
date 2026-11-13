import type { ChatMessage, Claim, Evidence, ScheduledTask } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { AnswerClaims } from "../chat/Citations.tsx";
import { BUTTON, Empty, ErrorNotice, Loading, Section } from "../components/ui.tsx";
import { createRemote } from "../lib/remote.ts";
import { newsMessages } from "./news.messages.ts";

function TaskNewsHistory(props: {
	readonly api: ApiClient;
	readonly task: ScheduledTask;
}): JSX.Element {
	const m = useMessages(newsMessages);
	const [messages, setMessages] = createSignal<readonly ChatMessage[]>([]);
	const [claims, setClaims] = createSignal<ReadonlyMap<string, Claim>>(new Map());
	const [evidence, setEvidence] = createSignal<ReadonlyMap<string, Evidence>>(new Map());
	const [earlier, setEarlier] = createSignal(false);
	const [before, setBefore] = createSignal<number | null>(null);
	const [busy, setBusy] = createSignal(false);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const load = async () => {
		if (busy()) return;
		setBusy(true);
		const cursor = before();
		const result = await props.api.getConversation(
			props.task.workspaceId,
			null,
			cursor === null ? null : { before: cursor },
		);
		setBusy(false);
		if (!result.ok) {
			setFailure(result.error);
			return;
		}
		setFailure(null);
		if (!result.value.changed) return;
		const page = result.value.value;
		setMessages((current) => [...page.messages, ...current]);
		setClaims(
			(current) =>
				new Map([...current, ...page.claims.map((claim) => [claim.claimId, claim] as const)]),
		);
		setEvidence(
			(current) =>
				new Map([...current, ...page.evidence.map((item) => [item.evidenceId, item] as const)]),
		);
		const first = page.messages[0];
		if (first !== undefined) setBefore(first.seq);
		setEarlier(page.hasEarlier);
	};
	void load();
	return (
		<article class="min-w-0 break-words space-y-2 border-b border-slate-200 py-3">
			<h3 class="max-w-prose break-words text-xl font-semibold leading-snug text-slate-900">
				{props.task.title}
			</h3>
			<For
				each={messages()
					.filter((message) => message.role === "assistant")
					.slice()
					.reverse()}
			>
				{(message) => (
					<div>
						<time dateTime={message.createdAt} class="text-xs text-slate-600">
							{new Date(message.createdAt).toLocaleString()}
						</time>
						<Show
							when={message.claimIds.length > 0}
							fallback={
								<p class="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
									{message.text}
								</p>
							}
						>
							<AnswerClaims
								variant="news"
								claimIds={message.claimIds}
								claims={claims()}
								evidence={evidence()}
							/>
						</Show>
					</div>
				)}
			</For>
			<Show when={busy()}>
				<Loading label={m().aiNews} />
			</Show>
			<Show
				when={
					!busy() &&
					failure() === null &&
					!messages().some((message) => message.role === "assistant")
				}
			>
				<Empty>{m().noReports}</Empty>
			</Show>
			<Show when={failure()}>
				{(error) => (
					<ErrorNotice failure={error()} title={m().aiNewsFailed} onRetry={() => void load()} />
				)}
			</Show>
			<Show when={earlier()}>
				<button type="button" class={BUTTON} disabled={busy()} onClick={() => void load()}>
					{m().earlierNews}
				</button>
			</Show>
		</article>
	);
}

export function TaskNews(props: { readonly api: ApiClient }): JSX.Element {
	const m = useMessages(newsMessages);
	const tasks = createRemote(async () => {
		const result = await props.api.listScheduledTasks();
		if (!result.ok) return result;
		return {
			ok: true as const,
			value: result.value.changed
				? result.value.value.tasks.filter((task) => task.outputType === "news")
				: [],
		};
	});
	return (
		<Section title={m().aiNews}>
			<Show when={tasks.state().status === "loading"}>
				<Loading label={m().aiNews} />
			</Show>
			<Show when={tasks.value()?.length === 0}>
				<Empty>{m().noNewsTasks}</Empty>
			</Show>
			<Show
				when={(() => {
					const state = tasks.state();
					return state.status === "error" ? state.error : null;
				})()}
			>
				{(error) => (
					<ErrorNotice
						failure={error()}
						title={m().aiNewsFailed}
						onRetry={() => void tasks.reload()}
					/>
				)}
			</Show>
			<For each={tasks.value() ?? []}>
				{(task) => <TaskNewsHistory api={props.api} task={task} />}
			</For>
		</Section>
	);
}
