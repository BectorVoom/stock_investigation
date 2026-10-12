import type { Evidence } from "@research/contracts";
import { createMemo, type JSX, Show } from "solid-js";
import { formatIsoDate, safeHttpsUrl } from "../format.ts";

export type SourceMap = ReadonlyMap<string, Evidence>;

/**
 * The only way a URL from data becomes an anchor. Non-https or malformed URLs
 * are shown as text with an explicit note, never as an href.
 */
export function SafeLink(props: {
	readonly url: string;
	readonly label?: string;
	readonly children: JSX.Element;
}): JSX.Element {
	const href = createMemo(() => safeHttpsUrl(props.url));
	return (
		<Show
			when={href()}
			fallback={
				<span data-link-unavailable="true">
					{props.children} <span class="italic text-slate-600">(link unavailable)</span>
				</span>
			}
		>
			{(safeHref) => (
				<a
					href={safeHref()}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={props.label}
					class="text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
				>
					{props.children}
				</a>
			)}
		</Show>
	);
}

export function DateText(props: {
	readonly iso: string | null;
	readonly missing: string;
}): JSX.Element {
	const formatted = createMemo(() => (props.iso === null ? null : formatIsoDate(props.iso)));
	return (
		<Show when={formatted()} fallback={<span class="italic">{props.missing}</span>}>
			{(text) => <time datetime={props.iso ?? undefined}>{text()}</time>}
		</Show>
	);
}

export function SourceUnavailable(props: { readonly sourceId: string }): JSX.Element {
	return (
		<span data-source-unavailable={props.sourceId} class="italic text-amber-900">
			Source unavailable (id {props.sourceId})
		</span>
	);
}

/**
 * One full citation line: linked title, publisher, and the three dates kept
 * distinct (DATA-002). A records view, not the canvas: the evidence records
 * drawer keeps these lines while canvas components use numbered chips.
 */
export function SourceCitation(props: {
	readonly sourceId: string;
	readonly sources: SourceMap;
}): JSX.Element {
	const source = createMemo(() => props.sources.get(props.sourceId));
	return (
		<Show when={source()} fallback={<SourceUnavailable sourceId={props.sourceId} />}>
			{(evidence) => (
				<span data-source-id={props.sourceId}>
					<SafeLink url={evidence().sourceUrl}>{evidence().title}</SafeLink>
					<span class="text-slate-700">
						{" — "}
						{evidence().publisher}; published{" "}
						<DateText iso={evidence().publishedAt} missing="date not stated" />; retrieved{" "}
						<DateText iso={evidence().retrievedAt} missing="date not stated" />
						<Show when={evidence().effectiveAt}>
							{(effectiveAt) => (
								<>
									; data as of <DateText iso={effectiveAt()} missing="date not stated" />
								</>
							)}
						</Show>
					</span>
				</span>
			)}
		</Show>
	);
}
