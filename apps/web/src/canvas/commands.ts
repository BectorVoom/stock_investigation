import type { uiOperationSchema } from "@research/contracts";
import { UI_PROTOCOL_VERSION } from "@research/domain";
import type { UiCommand } from "../api/client.ts";
import type { Parsed } from "../api/http.ts";

export type UiOperation = Parsed<typeof uiOperationSchema>;

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
