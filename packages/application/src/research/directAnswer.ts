import { extractJsonObject } from "@research/agent-core";
import { FLOW_DIAGRAM_LIMITS, type FlowDiagramProps } from "@research/contracts";
import { directAnswerSchema, directDiagramSchema } from "./draft.ts";

/** Japanese kana and CJK ideographs: a question containing any is answered with the Japanese note. */
const JAPANESE_SCRIPT = /[぀-ヿ㐀-鿿]/;

/**
 * The line the pipeline — never the model — appends to every direct answer
 * (ADR-0079), in the question's language: what follows was not researched,
 * not checked against any source, and is not investment advice.
 */
export function directAnswerNote(question: string): string {
	return JAPANESE_SCRIPT.test(question)
		? "この回答は調査を行わず、AI モデルの一般知識から書かれています。出典との照合は行っていません。投資助言ではありません。"
		: "Answered from the AI model's general knowledge without research; nothing here was checked against sources. Not investment advice.";
}

export interface DirectAnswerParts {
	readonly answer: string;
	readonly diagram: FlowDiagramProps | null;
	/** Why a proposed diagram was left out, for the progress log. */
	readonly notes: readonly string[];
}

/**
 * Reads the direct answer's reply. A reply that is not JSON at all is taken as
 * the answer itself (a model that answered in prose still answered); JSON
 * without a usable `answer` is refused (null). A diagram that is not a flow of
 * 2 to 10 labelled stages is left out with a note, never repaired by guessing.
 */
export function readDirectAnswer(replyText: string): DirectAnswerParts | null {
	const json = extractJsonObject(replyText);
	if (!json.ok) {
		const prose = replyText.trim().slice(0, 4000);
		return prose === "" ? null : { answer: prose, diagram: null, notes: [] };
	}
	const parsed = directAnswerSchema.safeParse(json.value);
	if (!parsed.success) return null;
	if (parsed.data.diagram === null) return { answer: parsed.data.answer, diagram: null, notes: [] };
	const diagram = directDiagramSchema.safeParse(parsed.data.diagram);
	if (!diagram.success || diagram.data.steps.length < FLOW_DIAGRAM_LIMITS.minSteps) {
		return {
			answer: parsed.data.answer,
			diagram: null,
			notes: ["The proposed diagram was left out: it was not a flow of 2 to 10 labelled stages."],
		};
	}
	return {
		answer: parsed.data.answer,
		diagram: {
			title: diagram.data.title,
			steps: diagram.data.steps.map((step) => ({
				label: step.label,
				detail: step.detail === null || step.detail === "" ? null : step.detail,
			})),
			basis: "model-knowledge",
		},
		notes: [],
	};
}
