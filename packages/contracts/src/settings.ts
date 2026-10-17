import { z } from "zod";
import { agentIdSchema } from "./agent.ts";
import { effortSchema, researchBudgetSchema, runBudget, webAccessSchema } from "./jobs.ts";
import { isoDateTimeSchema } from "./primitives.ts";

/** Re-exported so existing imports from settings keep working; defined in jobs.ts (ARCH-004). */
export { webAccessSchema };
export type { WebAccess } from "./jobs.ts";

/** At most one model override per backend; the registry bounds agent lists the same way. */
const MAX_MODEL_OVERRIDES = 16;

export const agentSettingsSchema = z
	.strictObject({
		/** Backend used for new questions; null until the owner has chosen one. */
		defaultAgentId: agentIdSchema.nullable(),
		/** Model per backend id, e.g. { opencode: "provider/model" }. A backend without an entry uses its own default. */
		models: z.record(agentIdSchema, z.string().trim().min(1).max(100)),
		effort: effortSchema,
		/**
		 * Kept for stored records; only `maxSpendUsd` is the owner's (null = no
		 * metered spend authorized). Every question runs under RUN_LIMITS.
		 */
		budget: researchBudgetSchema,
		/** Whether the agent may open public web pages (the web.fetch_page tool). */
		webAccess: webAccessSchema,
	})
	.refine((settings) => Object.keys(settings.models).length <= MAX_MODEL_OVERRIDES, {
		message: `at most ${MAX_MODEL_OVERRIDES} model overrides are allowed`,
		path: ["models"],
	});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
	defaultAgentId: null,
	models: {},
	effort: "medium",
	budget: runBudget(null),
	webAccess: "public-web",
};

export const agentSettingsResponseSchema = z.strictObject({
	settings: agentSettingsSchema,
	/** null while the owner has never saved settings (the defaults are being shown). */
	updatedAt: isoDateTimeSchema.nullable(),
	/**
	 * Which settings are shown: saved by the owner, carried over from their
	 * most recent research run, or the defaults. The UI says which it is
	 * showing so the owner knows whether saving is still needed.
	 */
	origin: z.enum(["saved", "carried-over", "defaults"]),
});
export type AgentSettingsResponse = z.infer<typeof agentSettingsResponseSchema>;
