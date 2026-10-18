/** Vitest-only wrappers: capture all inputs while still executing the real code. */
import { vi } from "vitest";
import type * as Assist from "../../../packages/application/src/notebook/assistTurn.ts";
import type * as Agent from "../../../packages/application/src/notebook/notebookAgent.ts";

vi.mock("../../../packages/application/src/notebook/assistTurn.ts", async (importOriginal) => {
	const real = await importOriginal<typeof Assist>();
	const { recordTurn } = await import("./record.ts");
	return {
		...real,
		runNotebookAssistTurn: (
			input: Assist.NotebookAssistTurnInput,
			deps: Assist.NotebookAssistTurnDeps,
		) => recordTurn(input, deps, real.runNotebookAssistTurn),
	};
});
vi.mock("../../../packages/application/src/notebook/notebookAgent.ts", async (importOriginal) => {
	const real = await importOriginal<typeof Agent>();
	const { save } = await import("./record.ts");
	return {
		...real,
		applyNotebookCommands: async (...args: Parameters<typeof Agent.applyNotebookCommands>) => {
			const [notebook, commands, context] = args;
			const ids: string[] = [];
			const output = await real.applyNotebookCommands(notebook, commands, {
				...context,
				newWidgetId: () => {
					const id = context.newWidgetId();
					ids.push(id);
					return id;
				},
			});
			// Build context in production comes from the claimed research widgets.
			// Standalone API tests may explicitly supply additional canvas ids.
			save({
				area: "commands",
				input: { notebook, commands, ids, known: [...context.knownComponentIds] },
				output: output.ok
					? { ok: true, widgets: output.value.widgets }
					: { ok: false, error: output.error },
			});
			return output;
		},
	};
});
