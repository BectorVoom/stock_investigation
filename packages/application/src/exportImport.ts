import {
	type ComponentCatalog,
	EXPORT_FORMAT_VERSION,
	MAX_REQUEST_BODY_BYTES,
	type ResearchExport,
	researchExportSchema,
	type WorkspaceSummary,
} from "@research/contracts";
import {
	describeReportedPositionChange,
	ok,
	positionLabels,
	type WorkspaceState,
} from "@research/domain";
import { z } from "zod";
import { fail, type UseCaseResult } from "./errors.ts";
import type {
	AssetRepository,
	ChatRepository,
	Clock,
	IdGenerator,
	ResearchRecordRepository,
	ResearchUnitOfWork,
	WorkspaceRepository,
} from "./ports.ts";
import { checkRecordIntegrity } from "./recordIntegrity.ts";
import { toLookup, workspaceReferences } from "./workspaceCommands.ts";

const EXPORT_MESSAGE_LIMIT = 2000;

export interface ExportImportServiceDeps {
	readonly workspaces: WorkspaceRepository;
	readonly records: ResearchRecordRepository;
	readonly chat: ChatRepository;
	readonly assets: AssetRepository;
	readonly unitOfWork: ResearchUnitOfWork;
	readonly catalog: ComponentCatalog;
	readonly clock: Clock;
	readonly ids: IdGenerator;
}

function formatDate(iso: string | null): string {
	return iso === null ? "undated" : iso.slice(0, 10);
}

function percent(ratio: number | null): string {
	return ratio === null ? "not derivable" : `${(ratio * 100).toFixed(2)}%`;
}

/** Collapses whitespace and escapes Markdown control characters in untrusted text. */
function md(text: string): string {
	return text.replace(/\s+/g, " ").replace(/([\\`*_[\]<>|])/g, "\\$1");
}

/**
 * Renders the export as Markdown with numbered citations. Pure: the same
 * export always yields the same document.
 */
export function renderExportMarkdown(document: ResearchExport): string {
	const { records } = document;
	const citation = new Map(records.evidence.map((item, index) => [item.evidenceId, index + 1]));
	const cite = (ids: readonly string[]): string => {
		const numbers = ids.map((id) => citation.get(id)).filter((n): n is number => n !== undefined);
		return numbers.length === 0 ? "" : ` [${[...new Set(numbers)].join(", ")}]`;
	};
	const securityName = new Map(
		records.securities.map((s) => [s.securityId, `${s.issuerName} (${s.exchange}: ${s.ticker})`]),
	);
	const lines: string[] = [
		`# ${md(document.workspace.title)}`,
		"",
		`Exported ${document.exportedAt}. Research record, not investment advice.`,
		"",
	];

	if (document.messages.length > 0) {
		lines.push("## Conversation", "");
		for (const message of document.messages) {
			lines.push(
				`**${message.role === "owner" ? "Owner" : "Assistant"}** (${formatDate(message.createdAt)}): ${md(message.text)}`,
				"",
			);
		}
	}

	if (records.claims.length > 0) {
		lines.push("## Claims", "");
		for (const claim of records.claims) {
			const supports = claim.links
				.filter((l) => l.relation === "supports")
				.map((l) => l.evidenceId);
			const contradicts = claim.links
				.filter((l) => l.relation === "contradicts")
				.map((l) => l.evidenceId);
			lines.push(`- _${claim.claimType}_, **${claim.status}**: ${md(claim.text)}${cite(supports)}`);
			if (contradicts.length > 0) lines.push(`  - Contradicting evidence:${cite(contradicts)}`);
		}
		lines.push("");
	}

	if (records.scenarios.length > 0) {
		lines.push("## Demand scenarios", "");
		for (const scenario of records.scenarios) {
			lines.push(
				`### ${md(scenario.productOrService)} (${scenario.quantityKind}, ${md(scenario.unit)})`,
				"",
				`Base year ${scenario.baseYear}, target year ${scenario.targetYear}. Baseline: ${scenario.baselineValue ?? "no sourced baseline"}.`,
				"",
				"| Case | Target | CAGR | Assumptions |",
				"|---|---|---|---|",
				`| Bear | ${scenario.bear.targetValue} | ${percent(scenario.derivedCagr.bear)} | ${md(scenario.bear.assumptions.join("; "))} |`,
				`| Base | ${scenario.base.targetValue} | ${percent(scenario.derivedCagr.base)} | ${md(scenario.base.assumptions.join("; "))} |`,
				`| Bull | ${scenario.bull.targetValue} | ${percent(scenario.derivedCagr.bull)} | ${md(scenario.bull.assumptions.join("; "))} |`,
				"",
				`Drivers: ${md(scenario.drivers.join("; "))}${cite(scenario.supportingEvidenceIds)}`,
				"",
				`Barriers: ${md(scenario.barriers.join("; ")) || "none recorded"}`,
				"",
				`Falsifying observations: ${md(scenario.falsifiers.join("; "))}`,
				"",
				`Contrary evidence:${cite(scenario.contraryEvidenceIds) || " none recorded"}`,
				"",
				`Methodology: ${md(scenario.methodology)}`,
				"",
			);
		}
	}

	if (records.supplierLinks.length > 0) {
		lines.push("## Suppliers", "");
		for (const link of records.supplierLinks) {
			lines.push(
				`- ${md(securityName.get(link.securityId) ?? link.securityId)} — ${md(link.productsOrServices.join(", "))}: ${md(link.businessExposure)}${cite(link.evidenceIds)}`,
			);
		}
		lines.push("");
	}

	if (records.financialObservations.length > 0) {
		lines.push(
			"## Financial observations",
			"",
			"| Security | Metric | Value | Period | Basis | As of | Source |",
			"|---|---|---|---|---|---|---|",
		);
		for (const o of records.financialObservations) {
			const value =
				o.value === null
					? `N/A — ${md(o.unavailableReason ?? "unavailable")}`
					: `${o.value}${o.currency === null ? "" : ` ${o.currency}`} (${o.unit})`;
			const period =
				o.period === null
					? "—"
					: `FY${o.period.fiscalYear} ${o.period.fiscalPeriod} (${o.period.periodStart} to ${o.period.periodEnd})`;
			lines.push(
				`| ${md(securityName.get(o.securityId) ?? o.securityId)} | ${o.metricCode} | ${value} | ${period} | ${o.accountingStandard ?? "—"}, ${o.actualOrEstimate} | ${o.marketDataAsOf ?? "—"} |${cite(o.sourceEvidenceId === null ? [] : [o.sourceEvidenceId]) || " —"} |`,
			);
		}
		lines.push("");
	}

	for (const metric of ["jp-margin-balance", "us-short-interest"] as const) {
		const observations = records.positionObservations.filter((o) => o.metric === metric);
		if (observations.length === 0) continue;
		const labels = positionLabels(metric);
		lines.push(`## ${labels.heading}`, "", labels.caveat, "");
		for (const o of observations) {
			const name = md(securityName.get(o.securityId) ?? o.securityId);
			if (o.figures === null) {
				lines.push(`- ${name}: N/A — ${md(o.unavailableReason ?? "unavailable")}`);
			} else if (o.figures.metric === "jp-margin-balance") {
				lines.push(
					`- ${name}: margin buy ${o.figures.marginBuyBalanceShares} shares, margin sell ${o.figures.marginSellBalanceShares} shares, as of ${o.asOfDate ?? "unknown"}${cite(o.sourceEvidenceId === null ? [] : [o.sourceEvidenceId])}`,
				);
			} else {
				lines.push(
					`- ${name}: reported short interest ${o.figures.reportedShortInterestShares} shares, as of ${o.asOfDate ?? "unknown"}${cite(o.sourceEvidenceId === null ? [] : [o.sourceEvidenceId])}`,
				);
			}
		}
		lines.push("");
	}

	if (records.investorFilings.length > 0) {
		lines.push("## Investor filings (reported holdings, not dated transactions)", "");
		for (const filing of records.investorFilings) {
			lines.push(
				`### ${md(filing.investorName)} — ${md(filing.form)}, period ending ${filing.reportPeriodEnd}, filed ${filing.filedAt}${cite([filing.sourceEvidenceId])}`,
				"",
			);
			for (const holding of filing.holdings) {
				const change =
					holding.changeFromPriorFiling === null
						? `${md(holding.issuerName)}: ${holding.reportedShares} shares reported`
						: md(
								describeReportedPositionChange(holding.changeFromPriorFiling, {
									investorName: filing.investorName,
									issuerName: holding.issuerName,
									reportPeriodEnd: filing.reportPeriodEnd,
									filedAt: filing.filedAt,
									form: filing.form,
								}),
							);
				lines.push(`- ${change}`);
			}
			lines.push("");
		}
	}

	if (records.pricingPower.length > 0) {
		lines.push("## Pricing power", "");
		for (const record of records.pricingPower) {
			lines.push(
				`- ${md(securityName.get(record.securityId) ?? record.securityId)}, FY${record.period.fiscalYear} ${record.period.fiscalPeriod}: **${record.assessment.classification}** (price ${record.inputs.priceRealizationPct ?? "n/d"}%, volume ${record.inputs.volumeGrowthPct ?? "n/d"}%, mix ${record.inputs.mixEffectPct ?? "n/d"}%, FX ${record.inputs.fxEffectPct ?? "n/d"}%, input costs ${record.inputs.inputCostChangePct ?? "n/d"}%, gross margin ${record.inputs.grossMarginChangeBps ?? "n/d"} bps)${cite(record.evidenceIds)}`,
			);
		}
		lines.push("");
	}

	if (records.evidence.length > 0) {
		lines.push("## Sources", "");
		records.evidence.forEach((item, index) => {
			lines.push(
				`${index + 1}. ${md(item.title)} — ${md(item.publisher)}. Published ${formatDate(item.publishedAt)}; retrieved ${formatDate(item.retrievedAt)}${item.effectiveAt === null ? "" : `; data as of ${formatDate(item.effectiveAt)}`}. <${item.sourceUrl}>`,
			);
		});
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * Rewrites every string that exactly equals a known id; other values are
 * untouched. Works on `unknown` so the result must be re-validated by a schema.
 */
function remapIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
	if (typeof value === "string") return ids.get(value) ?? value;
	if (Array.isArray(value)) return value.map((item: unknown) => remapIds(item, ids));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, remapIds(item, ids)]),
		);
	}
	return value;
}

const versionProbeSchema = z.looseObject({ formatVersion: z.unknown() });

export function createExportImportService(deps: ExportImportServiceDeps) {
	return {
		async export(ownerId: string, workspaceId: string): Promise<UseCaseResult<ResearchExport>> {
			const record = await deps.workspaces.get(ownerId, workspaceId);
			if (record === null) return fail("NOT_FOUND", "Workspace not found.");
			const [messages, runIds, workspaceDatasets] = await Promise.all([
				deps.chat.list(ownerId, workspaceId, { beforeSeq: null, limit: EXPORT_MESSAGE_LIMIT }),
				deps.records.runIdsForWorkspace(ownerId, workspaceId),
				deps.records.datasetsForWorkspace(ownerId, workspaceId),
			]);
			const references = {
				...toLookup(workspaceReferences(record.state, deps.catalog.validateProps)),
				claimIds: [],
			};
			const [records, referenced] = await Promise.all([
				deps.records.recordsForRuns(ownerId, runIds),
				deps.records.resolve(ownerId, references),
			]);
			const datasets = new Map(
				[...workspaceDatasets, ...referenced.datasets].map((d) => [d.datasetId, d]),
			);
			const evidence = new Map(
				[...records.evidence, ...referenced.evidence].map((e) => [e.evidenceId, e]),
			);
			// A dataset shown here may cite evidence gathered by another run. Follow those
			// citations so the file is self-contained and passes its own import check.
			const cited = new Set([
				...[...datasets.values()].flatMap((dataset) =>
					dataset.rows.flatMap((row) =>
						Object.values(row).flatMap((cell) =>
							cell.sourceId === undefined ? [] : [cell.sourceId],
						),
					),
				),
				...records.claims.flatMap((claim) => claim.links.map((link) => link.evidenceId)),
			]);
			const missing = [...cited].filter((id) => !evidence.has(id));
			if (missing.length > 0) {
				const more = await deps.records.resolve(ownerId, {
					datasetIds: [],
					evidenceIds: missing,
					assetIds: [],
					claimIds: [],
				});
				for (const item of more.evidence) evidence.set(item.evidenceId, item);
			}
			const document: ResearchExport = {
				format: "research-workspace-export",
				formatVersion: EXPORT_FORMAT_VERSION,
				exportedAt: deps.clock.nowIso(),
				workspace: { title: record.summary.title, state: record.state },
				messages: [...messages],
				datasets: [...datasets.values()],
				assets: [...referenced.assets],
				records: { ...records, evidence: [...evidence.values()] },
			};
			// An export is only useful if it can be imported: it must satisfy the import
			// schema's limits and fit in one request. Otherwise say so now, explicitly.
			const importable =
				researchExportSchema.safeParse(document).success &&
				new TextEncoder().encode(JSON.stringify(document)).length <= MAX_REQUEST_BODY_BYTES;
			if (!importable) {
				return fail(
					"PAYLOAD_TOO_LARGE",
					"This workspace is too large to export as a single importable file.",
				);
			}
			return ok(document);
		},

		/**
		 * Imports a portable export as a new workspace. The file is untrusted:
		 * it is schema-validated, integrity-checked, and every id is re-minted so
		 * it cannot collide with or overwrite existing records.
		 */
		async import(ownerId: string, payload: unknown): Promise<UseCaseResult<WorkspaceSummary>> {
			const probe = versionProbeSchema.safeParse(payload);
			if (probe.success && probe.data.formatVersion !== EXPORT_FORMAT_VERSION) {
				return fail(
					"UNSUPPORTED_EXPORT_VERSION",
					`Only export format version ${EXPORT_FORMAT_VERSION} can be imported.`,
				);
			}
			const parsed = researchExportSchema.safeParse(payload);
			if (!parsed.success) {
				return fail("VALIDATION_FAILED", "The file is not a valid research export.");
			}
			const document = parsed.data;
			const issues = checkRecordIntegrity(
				{ records: document.records, datasets: document.datasets },
				null,
			);
			if (issues.length > 0) {
				return fail(
					"INTEGRITY_VIOLATION",
					"The export references records it does not contain.",
					issues
						.slice(0, 5)
						.map((issue) => `${issue.code}:${issue.recordId}`)
						.join(","),
				);
			}

			// The file must be closed over its own records: everything a component or a message
			// points at has to be in the file. Otherwise an id could silently bind to one of the
			// owner's existing records after import.
			const fileDatasets = new Set(document.datasets.map((dataset) => dataset.datasetId));
			const fileEvidence = new Set(document.records.evidence.map((item) => item.evidenceId));
			const fileClaims = new Set(document.records.claims.map((claim) => claim.claimId));
			const assetRefs = new Set<string>();
			let dangling: string | null = null;
			for (const component of document.workspace.state.components) {
				const validated = deps.catalog.validateProps(
					component.componentType,
					component.schemaVersion,
					component.props,
				);
				if (!validated.ok) {
					return fail(
						"UI_COMMAND_REJECTED",
						"The export contains a component this installation cannot validate.",
						component.componentType,
					);
				}
				const refs = validated.value.references;
				dangling ??=
					refs.datasetRefs.find((id) => !fileDatasets.has(id)) ??
					refs.sourceIds.find((id) => !fileEvidence.has(id)) ??
					null;
				for (const assetRef of refs.assetRefs) assetRefs.add(assetRef);
			}
			dangling ??=
				document.messages
					.flatMap((message) => message.claimIds)
					.find((id) => !fileClaims.has(id)) ?? null;
			if (dangling !== null) {
				return fail(
					"INTEGRITY_VIOLATION",
					"The export references a record it does not contain.",
					`DANGLING_REFERENCE:${dangling}`.slice(0, 200),
				);
			}

			const importRunId = deps.ids.newId("imp");
			const workspaceId = deps.ids.newId("ws");
			const { records } = document;
			const oldIds = [
				...records.evidence.map((r) => r.evidenceId),
				...records.claims.map((r) => r.claimId),
				...records.scenarios.map((r) => r.scenarioId),
				...records.securities.map((r) => r.securityId),
				...records.supplierLinks.map((r) => r.supplierLinkId),
				...records.financialObservations.map((r) => r.observationId),
				...records.positionObservations.map((r) => r.observationId),
				...records.investorFilings.map((r) => r.filingId),
				...records.pricingPower.map((r) => r.pricingPowerId),
				...document.datasets.map((r) => r.datasetId),
				...document.messages.map((r) => r.messageId),
				// Image approvals are not imported; re-keying their ids guarantees a gallery cannot
				// end up bound to an unrelated asset the owner already approved.
				...assetRefs,
			];
			const ids = new Map(oldIds.map((id, index) => [id, `${importRunId}_${index}`]));
			// Imported records all hang off one synthetic run. The workspace id is mapped last
			// so that a run id which happens to equal it cannot redirect the workspace.
			for (const message of document.messages) {
				if (message.runId !== null) ids.set(message.runId, importRunId);
			}
			ids.set(document.workspace.state.workspaceId, workspaceId);

			// Round-tripping through the schema after the rewrite proves the remapped
			// document is still a valid export, without trusting the rewrite itself.
			const remapped = researchExportSchema.safeParse(remapIds(document, ids));
			if (!remapped.success) {
				return fail("VALIDATION_FAILED", "The export could not be re-keyed for import.");
			}
			const imported = remapped.data;
			// The new workspace id is assigned explicitly rather than trusted to the re-keying.
			const state: WorkspaceState = { ...imported.workspace.state, workspaceId };
			const importedClaims = new Map(
				imported.records.claims.map((claim) => [claim.claimId, claim]),
			);
			// A component must validate against the registry AND present each claim exactly as the
			// file's own records state it: a report cannot show "supported" for an unsupported claim.
			const unrenderable = state.components.find((component) => {
				const validated = deps.catalog.validateProps(
					component.componentType,
					component.schemaVersion,
					component.props,
				);
				if (!validated.ok) return true;
				return (validated.value.references.claims ?? []).some((presented) => {
					const stored = importedClaims.get(presented.claimId);
					return (
						stored === undefined ||
						stored.status !== presented.status ||
						stored.claimType !== presented.claimType
					);
				});
			});
			if (unrenderable !== undefined) {
				return fail(
					"UI_COMMAND_REJECTED",
					"The export contains a component this installation cannot validate.",
					unrenderable.componentType,
				);
			}

			const now = deps.clock.nowIso();
			const summary: WorkspaceSummary = {
				workspaceId,
				title: `${imported.workspace.title} (imported)`.slice(0, 300),
				version: state.version,
				createdAt: now,
				updatedAt: now,
			};
			await deps.unitOfWork.importWorkspace({
				ownerId,
				record: { summary, state },
				importRunId,
				records: imported.records,
				datasets: imported.datasets,
				// Image approval is an explicit owner decision (FR-011) and a file cannot make it:
				// imported galleries show "not approved" placeholders until the owner re-approves.
				assets: [],
				messages: imported.messages,
				at: now,
			});
			return ok(summary);
		},
	};
}

export type ExportImportService = ReturnType<typeof createExportImportService>;
