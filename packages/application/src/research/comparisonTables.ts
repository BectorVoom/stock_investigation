import type { Claim, Dataset, DatasetCell, Evidence } from "@research/contracts";
import {
	extractNumberTokens,
	isPassageOf,
	resolveClaimEvidenceId,
	selectVerifiedComparisonRowIndices,
} from "@research/domain";
import { draftComparisonTableSchema } from "./draft.ts";

export interface ComparisonTable {
	readonly title: string;
	readonly caption: string | null;
	readonly columns: Dataset["columns"];
	readonly rows: Dataset["rows"];
	readonly sourceIds: readonly string[];
}

const MAX_COMPARISON_ROWS = 30;
const EMPTY_TEXT_PLACEHOLDERS: ReadonlySet<string> = new Set(["", "—", "-", "N/A", "n/a"]);

/**
 * Parses a canonical decimal string (optional `-`, digits with optional `,`
 * thousands separators in the integer part, optional `.digits`, optional
 * trailing `%`) identically in TypeScript and Rust.
 */
export function parseComparisonNumberString(raw: string): number | null {
	const trimmed = raw.trim();
	const body = trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed;
	if (body === "") return null;
	const unsigned = body.startsWith("-") ? body.slice(1) : body;
	if (unsigned === "") return null;
	const dotIndex = unsigned.indexOf(".");
	const intPart = dotIndex >= 0 ? unsigned.slice(0, dotIndex) : unsigned;
	const fracPart = dotIndex >= 0 ? unsigned.slice(dotIndex + 1) : null;
	if (intPart === "" || !/^[0-9][0-9,]*$/.test(intPart)) return null;
	if (fracPart !== null && (fracPart === "" || !/^[0-9]+$/.test(fracPart))) return null;
	const clean = body.replace(/,/g, "");
	const parsed = Number(clean);
	if (!Number.isFinite(parsed)) return null;
	return parsed === 0 ? 0 : parsed;
}

function asOfForEvidence(evidence: Evidence): string {
	return evidence.effectiveAt ?? evidence.publishedAt ?? evidence.retrievedAt;
}

export function buildComparisonTables(input: {
	readonly runId: string;
	readonly rawTables: readonly unknown[];
	readonly claims: readonly Claim[];
	readonly shownEvidenceById: ReadonlyMap<
		string,
		{ readonly evidence: Evidence; readonly shownText: string }
	>;
	readonly notes: string[];
}): readonly ComparisonTable[] {
	const shownIds = new Set(input.shownEvidenceById.keys());
	const evidenceTokenCache = new Map<string, ReadonlySet<string>>();
	const tokensOfEvidence = (evidenceId: string): ReadonlySet<string> => {
		const cached = evidenceTokenCache.get(evidenceId);
		if (cached !== undefined) return cached;
		const text = input.shownEvidenceById.get(evidenceId)?.shownText ?? "";
		const computed = new Set(extractNumberTokens(text));
		evidenceTokenCache.set(evidenceId, computed);
		return computed;
	};

	const result: ComparisonTable[] = [];
	for (const [tableIndex, raw] of input.rawTables.entries()) {
		const parsed = draftComparisonTableSchema.safeParse(raw);
		if (!parsed.success) {
			input.notes.push(`Comparison table ${tableIndex + 1} was dropped: malformed.`);
			continue;
		}
		const draft = parsed.data;
		if (
			draft.columns.length < 2 ||
			draft.rows.length === 0 ||
			draft.columns.some((col) => col.kind === "number" && (col.unit === null || col.unit === ""))
		) {
			input.notes.push(`Comparison table ${tableIndex + 1} was dropped: malformed.`);
			continue;
		}

		const columns: Dataset["columns"] = draft.columns.map((col, colIndex) => {
			const key = `col${colIndex}`;
			return col.kind === "number" && col.unit !== null
				? { key, label: col.label, kind: "number" as const, unit: col.unit }
				: { key, label: col.label, kind: "text" as const };
		});
		const firstTextColIndex = columns.findIndex((col) => col.kind === "text");

		const evaluatedRows: {
			readonly hasVerifiedSupport: boolean;
			readonly hasStrayNumber: boolean;
			readonly rowCells: Record<string, DatasetCell>;
			readonly rowEvidenceIds: readonly string[];
		}[] = [];

		for (const draftRow of draft.rows) {
			const seenClaimIndices = new Set<number>();
			const supportedClaims: Claim[] = [];
			const rawEvidenceIds: string[] = [];

			for (const claimIndex of draftRow.claimIndices) {
				if (seenClaimIndices.has(claimIndex)) continue;
				seenClaimIndices.add(claimIndex);
				const claim = input.claims[claimIndex];
				if (claim === undefined || claim.status !== "supported") continue;
				supportedClaims.push(claim);
				for (const link of claim.links) {
					if (link.relation === "supports" && input.shownEvidenceById.has(link.evidenceId)) {
						rawEvidenceIds.push(link.evidenceId);
					}
				}
			}

			for (const link of draftRow.evidence) {
				const resolvedId = resolveClaimEvidenceId(input.runId, link.evidenceId, shownIds);
				const shown = input.shownEvidenceById.get(resolvedId);
				if (
					shown !== undefined &&
					link.quote !== null &&
					link.quote !== "" &&
					isPassageOf(link.quote, shown.shownText)
				) {
					rawEvidenceIds.push(resolvedId);
				}
			}

			const rowEvidenceIds = [...new Set(rawEvidenceIds)].slice(0, 12);
			const hasVerifiedSupport = rowEvidenceIds.length > 0;
			const allowedNumbers = new Set<string>();
			for (const evId of rowEvidenceIds) {
				for (const token of tokensOfEvidence(evId)) allowedNumbers.add(token);
			}
			for (const claim of supportedClaims) {
				for (const token of extractNumberTokens(claim.text)) allowedNumbers.add(token);
			}

			let hasStrayNumber = false;
			const rowCells: Record<string, DatasetCell> = {};
			const primaryId = rowEvidenceIds[0];
			const primaryEvidence =
				primaryId === undefined ? undefined : input.shownEvidenceById.get(primaryId)?.evidence;

			for (const [colIndex, column] of columns.entries()) {
				const rawVal = colIndex < draftRow.values.length ? draftRow.values[colIndex] : null;
				if (column.kind === "text") {
					if (rawVal === null || rawVal === undefined) {
						rowCells[column.key] = { v: null, reason: "not reported" };
						continue;
					}
					if (typeof rawVal === "string") {
						const trimmed = rawVal.trim();
						if (EMPTY_TEXT_PLACEHOLDERS.has(trimmed)) {
							rowCells[column.key] = { v: null, reason: "not reported" };
							continue;
						}
						const textVal = trimmed.slice(0, 600);
						if (extractNumberTokens(textVal).some((token) => !allowedNumbers.has(token))) {
							hasStrayNumber = true;
						}
						rowCells[column.key] =
							colIndex === firstTextColIndex && primaryId !== undefined
								? { v: textVal, sourceId: primaryId }
								: { v: textVal };
						continue;
					}
					if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
						const normalizedNum = rawVal === 0 ? 0 : rawVal;
						const textVal = String(normalizedNum);
						if (extractNumberTokens(textVal).some((token) => !allowedNumbers.has(token))) {
							hasStrayNumber = true;
						}
						rowCells[column.key] =
							colIndex === firstTextColIndex && primaryId !== undefined
								? { v: textVal, sourceId: primaryId }
								: { v: textVal };
						continue;
					}
					hasStrayNumber = true;
					rowCells[column.key] = { v: null, reason: "not reported" };
					continue;
				}

				// column.kind === "number"
				if (rawVal === null || rawVal === undefined) {
					rowCells[column.key] = { v: null, reason: "unavailable" };
					continue;
				}
				let numVal: number | null = null;
				if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
					numVal = rawVal === 0 ? 0 : rawVal;
				} else if (typeof rawVal === "string") {
					const trimmed = rawVal.trim();
					if (EMPTY_TEXT_PLACEHOLDERS.has(trimmed)) {
						rowCells[column.key] = { v: null, reason: "unavailable" };
						continue;
					}
					numVal = parseComparisonNumberString(trimmed);
				}
				if (numVal === null) {
					hasStrayNumber = true;
					rowCells[column.key] = { v: null, reason: "unavailable" };
					continue;
				}
				const tokens = extractNumberTokens(String(Math.abs(numVal)));
				if (tokens.length === 0 || tokens.some((token) => !allowedNumbers.has(token))) {
					hasStrayNumber = true;
					rowCells[column.key] = { v: null, reason: "unavailable" };
					continue;
				}
				if (primaryId === undefined || primaryEvidence === undefined) {
					rowCells[column.key] = { v: null, reason: "unavailable" };
					continue;
				}
				const directSourceId = rowEvidenceIds.find((evId) => {
					const evTokens = tokensOfEvidence(evId);
					return tokens.every((token) => evTokens.has(token));
				});
				const directEvidence =
					directSourceId === undefined
						? undefined
						: input.shownEvidenceById.get(directSourceId)?.evidence;
				if (directSourceId !== undefined && directEvidence !== undefined) {
					rowCells[column.key] = {
						v: numVal,
						sourceId: directSourceId,
						asOf: asOfForEvidence(directEvidence),
					};
				} else {
					rowCells[column.key] = {
						v: numVal,
						sourceId: primaryId,
						asOf: asOfForEvidence(primaryEvidence),
						basis: "derived",
					};
				}
			}

			evaluatedRows.push({
				hasVerifiedSupport,
				hasStrayNumber,
				rowCells,
				rowEvidenceIds,
			});
		}

		const keptIndices = selectVerifiedComparisonRowIndices(evaluatedRows, MAX_COMPARISON_ROWS);
		if (keptIndices.length === 0) {
			input.notes.push(
				`Comparison table ${tableIndex + 1} was dropped: no rows had verified backing.`,
			);
			continue;
		}
		if (keptIndices.length < evaluatedRows.length) {
			input.notes.push(
				`Comparison table ${tableIndex + 1}: ${evaluatedRows.length - keptIndices.length} row(s) without verified backing were omitted.`,
			);
		}
		const keptRows = keptIndices.flatMap((idx) => {
			const entry = evaluatedRows[idx];
			return entry === undefined ? [] : [entry];
		});
		const sourceIds = [...new Set(keptRows.flatMap((row) => row.rowEvidenceIds))].slice(0, 40);
		result.push({
			title: draft.title,
			caption: draft.caption !== null && draft.caption !== "" ? draft.caption : null,
			columns,
			rows: keptRows.map((row) => row.rowCells),
			sourceIds,
		});
	}

	return result;
}
