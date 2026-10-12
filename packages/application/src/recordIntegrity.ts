import type { Dataset, ResearchBundle, RunRecords } from "@research/contracts";
import { assessPricingPower, deriveScenarioCagr } from "@research/domain";

/**
 * Referential and derivation integrity of a set of research records
 * (DATA-001, AGT-009). Runs in the Worker on everything a runner or an import
 * submits: the server never assumes the submitter verified its own output.
 */
export interface IntegrityIssue {
	readonly code:
		| "ID_NOT_RUN_SCOPED"
		| "DUPLICATE_ID"
		| "UNKNOWN_EVIDENCE"
		| "UNKNOWN_SECURITY"
		| "UNKNOWN_SCENARIO"
		| "UNKNOWN_CLAIM"
		| "CLAIM_STATUS_INCONSISTENT"
		| "SCENARIO_INVALID"
		| "CAGR_NOT_DERIVED"
		| "BASELINE_WITHOUT_EVIDENCE"
		| "JURISDICTION_MISMATCH"
		| "ASSESSMENT_NOT_DERIVED"
		| "VERIFICATION_STATUS_INCONSISTENT";
	readonly recordId: string;
}

const CAGR_TOLERANCE = 1e-9;

function sameNullableNumber(a: number | null, b: number | null): boolean {
	if (a === null || b === null) return a === b;
	return Math.abs(a - b) <= CAGR_TOLERANCE;
}

function duplicates(ids: readonly string[]): readonly string[] {
	const seen = new Set<string>();
	return ids.filter((id) => {
		if (seen.has(id)) return true;
		seen.add(id);
		return false;
	});
}

export interface RecordSet {
	readonly records: RunRecords;
	readonly datasets: readonly Dataset[];
}

/**
 * @param requiredIdPrefix when set, every record id must start with it, so one
 *   run cannot overwrite or impersonate another run's records.
 */
export function checkRecordIntegrity(
	set: RecordSet,
	requiredIdPrefix: string | null,
): readonly IntegrityIssue[] {
	const { records, datasets } = set;
	const issues: IntegrityIssue[] = [];
	const evidenceIds = new Set(records.evidence.map((item) => item.evidenceId));
	const securityById = new Map(records.securities.map((item) => [item.securityId, item]));
	const scenarioIds = new Set(records.scenarios.map((item) => item.scenarioId));

	const allIds = [
		...records.evidence.map((item) => item.evidenceId),
		...records.claims.map((item) => item.claimId),
		...records.scenarios.map((item) => item.scenarioId),
		...records.securities.map((item) => item.securityId),
		...records.supplierLinks.map((item) => item.supplierLinkId),
		...records.financialObservations.map((item) => item.observationId),
		...records.positionObservations.map((item) => item.observationId),
		...records.investorFilings.map((item) => item.filingId),
		...records.pricingPower.map((item) => item.pricingPowerId),
		...datasets.map((item) => item.datasetId),
	];
	for (const id of duplicates(allIds)) issues.push({ code: "DUPLICATE_ID", recordId: id });
	if (requiredIdPrefix !== null) {
		for (const id of allIds) {
			if (!id.startsWith(requiredIdPrefix))
				issues.push({ code: "ID_NOT_RUN_SCOPED", recordId: id });
		}
	}

	const requireEvidence = (recordId: string, ids: readonly (string | null)[]) => {
		for (const id of ids) {
			if (id !== null && !evidenceIds.has(id)) issues.push({ code: "UNKNOWN_EVIDENCE", recordId });
		}
	};
	const requireSecurity = (recordId: string, securityId: string | null) => {
		if (securityId !== null && !securityById.has(securityId)) {
			issues.push({ code: "UNKNOWN_SECURITY", recordId });
		}
	};

	for (const claim of records.claims) {
		requireEvidence(
			claim.claimId,
			claim.links.map((link) => link.evidenceId),
		);
		const supports = claim.links.filter((link) => link.relation === "supports").length;
		const contradicts = claim.links.filter((link) => link.relation === "contradicts").length;
		const consistent =
			(claim.status === "supported" && supports > 0 && contradicts === 0) ||
			(claim.status === "conflicting" && supports > 0 && contradicts > 0) ||
			claim.status === "unsupported";
		if (!consistent) issues.push({ code: "CLAIM_STATUS_INCONSISTENT", recordId: claim.claimId });
	}

	for (const scenario of records.scenarios) {
		requireEvidence(scenario.scenarioId, [
			scenario.baselineEvidenceId,
			...scenario.supportingEvidenceIds,
			...scenario.contraryEvidenceIds,
		]);
		if (scenario.baselineValue !== null && scenario.baselineEvidenceId === null) {
			issues.push({ code: "BASELINE_WITHOUT_EVIDENCE", recordId: scenario.scenarioId });
		}
		const derived = deriveScenarioCagr(scenario);
		if (!derived.ok) {
			issues.push({ code: "SCENARIO_INVALID", recordId: scenario.scenarioId });
		} else if (
			!sameNullableNumber(derived.value.bear, scenario.derivedCagr.bear) ||
			!sameNullableNumber(derived.value.base, scenario.derivedCagr.base) ||
			!sameNullableNumber(derived.value.bull, scenario.derivedCagr.bull)
		) {
			// A stored CAGR must be the domain's derivation, never a model-supplied figure.
			issues.push({ code: "CAGR_NOT_DERIVED", recordId: scenario.scenarioId });
		}
	}

	for (const link of records.supplierLinks) {
		requireSecurity(link.supplierLinkId, link.securityId);
		requireEvidence(link.supplierLinkId, link.evidenceIds);
		if (link.scenarioId !== null && !scenarioIds.has(link.scenarioId)) {
			issues.push({ code: "UNKNOWN_SCENARIO", recordId: link.supplierLinkId });
		}
	}

	for (const observation of records.financialObservations) {
		requireSecurity(observation.observationId, observation.securityId);
		requireEvidence(observation.observationId, [observation.sourceEvidenceId]);
	}

	for (const observation of records.positionObservations) {
		requireSecurity(observation.observationId, observation.securityId);
		requireEvidence(observation.observationId, [observation.sourceEvidenceId]);
		const security = securityById.get(observation.securityId);
		if (security !== undefined && security.country !== observation.jurisdiction) {
			issues.push({ code: "JURISDICTION_MISMATCH", recordId: observation.observationId });
		}
	}

	for (const filing of records.investorFilings) {
		requireEvidence(filing.filingId, [filing.sourceEvidenceId]);
		for (const holding of filing.holdings) requireSecurity(filing.filingId, holding.securityId);
	}

	for (const record of records.pricingPower) {
		requireSecurity(record.pricingPowerId, record.securityId);
		requireEvidence(record.pricingPowerId, [
			...record.evidenceIds,
			...record.inputs.managementCommentaryEvidenceIds,
		]);
		const derived = assessPricingPower(record.inputs);
		if (
			derived.classification !== record.assessment.classification ||
			!sameNullableNumber(
				derived.unexplainedRevenueResidualPct,
				record.assessment.unexplainedRevenueResidualPct,
			)
		) {
			issues.push({ code: "ASSESSMENT_NOT_DERIVED", recordId: record.pricingPowerId });
		}
	}

	for (const dataset of datasets) {
		for (const row of dataset.rows) {
			requireEvidence(
				dataset.datasetId,
				Object.values(row).map((cell) => cell.sourceId ?? null),
			);
		}
	}
	return issues;
}

export function bundleRecordSet(bundle: ResearchBundle): RecordSet {
	return {
		records: {
			evidence: bundle.evidence,
			claims: bundle.claims,
			scenarios: bundle.scenarios,
			securities: bundle.securities,
			supplierLinks: bundle.supplierLinks,
			financialObservations: bundle.financialObservations,
			positionObservations: bundle.positionObservations,
			investorFilings: bundle.investorFilings,
			pricingPower: bundle.pricingPower,
		},
		datasets: bundle.datasets,
	};
}

/** Integrity of a runner-submitted bundle for `runId`, including its answer metadata. */
export function checkBundleIntegrity(
	runId: string,
	bundle: ResearchBundle,
): readonly IntegrityIssue[] {
	const issues = [...checkRecordIntegrity(bundleRecordSet(bundle), `${runId}_`)];
	const claimIds = new Set(bundle.claims.map((claim) => claim.claimId));
	for (const claimId of bundle.answerClaimIds) {
		if (!claimIds.has(claimId)) issues.push({ code: "UNKNOWN_CLAIM", recordId: claimId });
	}
	const allSupported = bundle.claims.every((claim) => claim.status === "supported");
	if (bundle.verificationStatus === "verified" && !allSupported) {
		issues.push({ code: "VERIFICATION_STATUS_INCONSISTENT", recordId: runId });
	}
	return issues;
}
