import type { uiOperationSchema, WorkspaceView } from "@research/contracts";
import { UI_PROTOCOL_VERSION } from "@research/domain";
import type { UiCommand } from "../api/client.ts";
import type { Parsed } from "../api/http.ts";

export type UiOperation = Parsed<typeof uiOperationSchema>;
export type WorkspaceLayout = WorkspaceView["state"]["layout"];

/**
 * Stamps an owner operation with the command envelope. The expected version is
 * always the version of the state currently rendered, so the server can detect
 * a stale client (UI-006).
 */
export function buildCommand(
	operation: UiOperation,
	envelope: {
		readonly commandId: string;
		readonly workspaceId: string;
		readonly expectedWorkspaceVersion: number;
	},
): UiCommand {
	return { protocolVersion: UI_PROTOCOL_VERSION, ...envelope, ...operation };
}

/** Swaps a component with its neighbour; null when it is already at that edge. */
export function moveOperation(
	layout: WorkspaceLayout,
	componentId: string,
	direction: "up" | "down",
): UiOperation | null {
	const index = layout.order.indexOf(componentId);
	const target = direction === "up" ? index - 1 : index + 1;
	const neighbour = layout.order[target];
	if (index < 0 || target < 0 || neighbour === undefined) return null;
	const order = [...layout.order];
	order[index] = neighbour;
	order[target] = componentId;
	return { operation: "layout.update", order, columns: layout.columns };
}
