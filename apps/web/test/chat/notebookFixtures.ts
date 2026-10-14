import {
	type NotebookResponse,
	type NotebookTurn,
	type NotebookWidget,
	notebookResponseSchema,
	notebookTurnSchema,
	notebookWidgetSchema,
	type ResearchRun,
} from "@research/contracts";
import { makeRun, WORKSPACE_ID } from "../fixtures.ts";

/** Fixtures are parsed with the contract schemas, so they are valid API payloads by construction. */

export function makeNotebookWidget(overrides: Partial<NotebookWidget> = {}): NotebookWidget {
	return notebookWidgetSchema.parse({
		widgetId: "nb_1",
		title: "Revenue",
		size: "medium",
		createdAt: "2026-10-07T00:00:00Z",
		updatedAt: "2026-10-07T00:00:00Z",
		revision: 1,
		origin: { kind: "chat", messageId: null, runId: null, componentId: null },
		type: "text",
		text: "Revenue grew year over year.",
		...overrides,
	});
}

export function makeNotebookTurn(overrides: Partial<NotebookTurn> = {}): NotebookTurn {
	return notebookTurnSchema.parse({
		runId: "run_assist_1",
		baseVersion: 1,
		appliedVersion: 2,
		changes: [
			{
				widgetId: "nb_1",
				kind: "resized",
				title: "Revenue",
				before: "medium",
				after: "large",
			},
		],
		proposedRemovals: [],
		failure: null,
		createdAt: "2026-10-07T00:00:00Z",
		...overrides,
	});
}

export function makeNotebookResponse(overrides: Partial<NotebookResponse> = {}): NotebookResponse {
	return notebookResponseSchema.parse({
		workspaceId: WORKSPACE_ID,
		notebook: { widgets: [] },
		version: 0,
		updatedAt: null,
		undoAvailable: false,
		turns: [],
		...overrides,
	});
}

/** A finished notebook-assistant run; override state for queued/running variants. */
export function makeNotebookAssistRun(overrides: Partial<ResearchRun> = {}): ResearchRun {
	return makeRun({
		runId: "run_assist_1",
		kind: "notebook-assist",
		request: null,
		provenance: null,
		verificationStatus: null,
		...overrides,
	});
}
