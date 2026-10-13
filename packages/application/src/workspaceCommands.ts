import {
	type Claim,
	type ComponentCatalog,
	MAX_WORKSPACE_COMPONENTS,
	type ResearchBundle,
} from "@research/contracts";
import {
	applyUiCommand,
	type CommandContext,
	type ComponentReferences,
	type IdLookup,
	type PropsValidator,
	resolveCommandReferences,
	UI_PROTOCOL_VERSION,
	type UiCommand,
	type UiCommandErrorCode,
	type UiOperation,
	type WorkspaceState,
} from "@research/domain";
import type { AppliedCommand, ReferenceLookup, ResolvedReferences } from "./ports.ts";

const ALL_KNOWN: IdLookup = { has: () => true };

/** References held by every component currently in the workspace. */
export function workspaceReferences(
	state: WorkspaceState,
	validateProps: PropsValidator,
): ComponentReferences {
	const all = state.components.map((component) => {
		const validated = validateProps(
			component.componentType,
			component.schemaVersion,
			component.props,
		);
		return validated.ok ? validated.value.references : null;
	});
	const valid = all.filter((refs): refs is ComponentReferences => refs !== null);
	return {
		datasetRefs: valid.flatMap((refs) => refs.datasetRefs),
		sourceIds: valid.flatMap((refs) => refs.sourceIds),
		claims: valid.flatMap((refs) => refs.claims ?? []),
	};
}

export function toLookup(references: ComponentReferences): ReferenceLookup {
	return {
		datasetIds: [...new Set(references.datasetRefs)],
		evidenceIds: [...new Set(references.sourceIds)],
		claimIds: [...new Set((references.claims ?? []).map((claim) => claim.claimId))],
	};
}

export function commandContext(
	catalog: ComponentCatalog,
	known: {
		readonly datasetIds: Iterable<string>;
		readonly evidenceIds: Iterable<string>;
		readonly claims: Iterable<Pick<Claim, "claimId" | "status" | "claimType">>;
	},
): CommandContext {
	return {
		validateProps: catalog.validateProps,
		knownDatasetRefs: new Set(known.datasetIds),
		knownSourceIds: new Set(known.evidenceIds),
		knownClaims: new Map([...known.claims].map((claim) => [claim.claimId, claim])),
		maxComponents: MAX_WORKSPACE_COMPONENTS,
	};
}

export function knownIds(resolved: ResolvedReferences) {
	return {
		datasetIds: resolved.datasets.map((dataset) => dataset.datasetId),
		evidenceIds: resolved.evidence.map((evidence) => evidence.evidenceId),
		claims: resolved.claims,
	};
}

export interface RejectedOperation {
	readonly index: number;
	readonly code: UiCommandErrorCode;
}

export interface AppliedOperations {
	readonly nextState: WorkspaceState;
	readonly commands: readonly AppliedCommand[];
	readonly rejected: readonly RejectedOperation[];
}

function stamp(
	runId: string,
	index: number,
	state: WorkspaceState,
	operation: UiOperation,
): UiCommand {
	return {
		...operation,
		protocolVersion: UI_PROTOCOL_VERSION,
		// Deterministic id: replaying the same completion cannot apply an operation twice.
		commandId: `${runId}_ui${index}`,
		workspaceId: state.workspaceId,
		expectedWorkspaceVersion: state.version,
	};
}

/**
 * Ids the run's UI operations reference beyond what the bundle itself carries,
 * found by a dry run that treats every reference as known. Lets the caller
 * resolve them in ONE storage round trip instead of one per operation.
 */
export function externalReferences(
	state: WorkspaceState,
	runId: string,
	bundle: ResearchBundle,
	catalog: ComponentCatalog,
): ReferenceLookup {
	let current = state;
	// References are gathered from EVERY operation, not just from the final state: an
	// operation in the middle of the list (a navigation target, a dataset bound and later
	// rebound) needs its reference resolved to be judged on its own.
	const touched: ComponentReferences[] = [];
	bundle.uiOperations.forEach((operation, index) => {
		const command = stamp(runId, index, current, operation);
		const references = resolveCommandReferences(current, command, catalog.validateProps);
		if (!references.ok) return;
		touched.push(references.value);
		const claims = references.value.claims ?? [];
		// Dry run: every reference is taken at face value so the state can advance; the
		// real pass afterwards checks each one against storage.
		const applied = applyUiCommand(current, command, {
			validateProps: catalog.validateProps,
			knownDatasetRefs: ALL_KNOWN,
			knownSourceIds: ALL_KNOWN,
			knownClaims: new Map(claims.map((claim) => [claim.claimId, claim])),
			maxComponents: MAX_WORKSPACE_COMPONENTS,
		});
		if (applied.ok) current = applied.value;
	});
	const own = {
		datasets: new Set(bundle.datasets.map((dataset) => dataset.datasetId)),
		evidence: new Set(bundle.evidence.map((evidence) => evidence.evidenceId)),
		claims: new Set(bundle.claims.map((claim) => claim.claimId)),
	};
	const lookup = toLookup({
		datasetRefs: touched.flatMap((refs) => refs.datasetRefs),
		sourceIds: touched.flatMap((refs) => refs.sourceIds),
		claims: touched.flatMap((refs) => refs.claims ?? []),
	});
	return {
		datasetIds: lookup.datasetIds.filter((id) => !own.datasets.has(id)),
		evidenceIds: lookup.evidenceIds.filter((id) => !own.evidence.has(id)),
		claimIds: lookup.claimIds.filter((id) => !own.claims.has(id)),
	};
}

/**
 * Applies a run's UI operations in order. A rejected operation is skipped and
 * reported — it never aborts the run's verified findings and never renders.
 */
export function applyRunOperations(
	state: WorkspaceState,
	runId: string,
	operations: readonly UiOperation[],
	context: CommandContext,
	appliedAt: string,
): AppliedOperations {
	let current = state;
	const commands: AppliedCommand[] = [];
	const rejected: RejectedOperation[] = [];
	operations.forEach((operation, index) => {
		const command = stamp(runId, index, current, operation);
		const applied = applyUiCommand(current, command, context);
		if (!applied.ok) {
			rejected.push({ index, code: applied.error.code });
			return;
		}
		current = applied.value;
		commands.push({ version: current.version, command, appliedAt, origin: "agent" });
	});
	return { nextState: current, commands, rejected };
}
