import { isOpenRouterFreeModelId } from "@research/contracts";
import { z } from "zod";
import type { ProviderEnvironment } from "./environment.ts";
import { isValidModelId } from "./turn.ts";

/** Public OpenRouter model catalog: no key is ever sent here. */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** How long a fetched free-model list is reused before it is refreshed. */
export const FREE_MODEL_LIST_TTL_MS = 10 * 60 * 1_000;
/** How long a failed refresh suppresses the next attempt. */
export const FREE_MODEL_RETRY_INTERVAL_MS = 60 * 1_000;
/** How long one catalog fetch may take before it is aborted. */
export const FREE_MODEL_FETCH_TIMEOUT_MS = 10_000;
/** Largest catalog body accepted; more than this aborts the refresh. */
export const FREE_MODEL_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Contract cap on `capabilities.models`: the list never carries more ids. */
export const FREE_MODEL_MAX_IDS = 300;

const priceSchema = z.looseObject({
	prompt: z.union([z.string(), z.number()]).optional(),
	completion: z.union([z.string(), z.number()]).optional(),
});

const modelEntrySchema = z.looseObject({
	id: z.string(),
	pricing: priceSchema.optional(),
	architecture: z.looseObject({ output_modalities: z.array(z.string()).optional() }).optional(),
});

const envelopeSchema = z.looseObject({ data: z.array(z.unknown()) });

/** True only for a price that is present and numerically zero. */
function isZeroPrice(value: string | number | undefined): boolean {
	if (typeof value === "number") return Number.isFinite(value) && value === 0;
	if (typeof value === "string") {
		if (value.trim() === "") return false;
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed === 0;
	}
	return false;
}

/**
 * Free ids from an OpenRouter models-list payload. Pure: each entry is
 * validated on its own so one odd entry does not hide the rest; a wrong
 * envelope returns []. An id is kept only when it is a free id, a valid
 * model id, zero-priced for prompt and completion, and text-output (or the
 * modalities are absent). A zero price without a `:free` id is excluded on
 * purpose: its price can change without its id changing.
 */
export function parseFreeModelIds(json: unknown): readonly string[] {
	const envelope = envelopeSchema.safeParse(json);
	if (!envelope.success) return [];
	const ids = new Set<string>();
	for (const entry of envelope.data.data) {
		const parsed = modelEntrySchema.safeParse(entry);
		if (!parsed.success) continue;
		const candidate = parsed.data;
		if (!isOpenRouterFreeModelId(candidate.id)) continue;
		if (!isValidModelId(candidate.id)) continue;
		if (!isZeroPrice(candidate.pricing?.prompt)) continue;
		if (!isZeroPrice(candidate.pricing?.completion)) continue;
		const modalities = candidate.architecture?.output_modalities;
		if (modalities !== undefined && !modalities.includes("text")) continue;
		ids.add(candidate.id);
		if (ids.size >= FREE_MODEL_MAX_IDS) break;
	}
	return [...ids].sort();
}

/** Free-model ids, or null when none has ever been fetched successfully. */
export interface FreeModelCatalog {
	list(): Promise<readonly string[] | null>;
}

async function readBoundedBody(response: Response): Promise<string | null> {
	if (response.body === null) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let receivedBytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			receivedBytes += next.value.byteLength;
			if (receivedBytes > FREE_MODEL_MAX_BODY_BYTES) {
				await reader.cancel().catch(() => undefined);
				return null;
			}
			chunks.push(next.value);
		}
	} catch {
		return null;
	} finally {
		reader.releaseLock();
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8").decode(merged);
}

/**
 * Catalog of free model ids from the public OpenRouter endpoint. The fetch
 * carries no Authorization header; a successful list is reused for 10
 * minutes, a failed refresh returns the last good list (stale is better than
 * none) and suppresses retries for 60 s, concurrent calls share one
 * in-flight request, and `list()` never throws.
 */
export function createFreeModelCatalog(
	environment: ProviderEnvironment,
	options: { readonly nowMs?: () => number } = {},
): FreeModelCatalog {
	const nowMs = options.nowMs ?? Date.now;
	let cached: readonly string[] | null = null;
	let cachedAtMs = 0;
	let failedAtMs: number | null = null;
	let inFlight: Promise<readonly string[] | null> | null = null;

	async function refresh(): Promise<readonly string[] | null> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FREE_MODEL_FETCH_TIMEOUT_MS);
		try {
			const response = await environment.fetch(OPENROUTER_MODELS_URL, {
				method: "GET",
				headers: { Accept: "application/json" },
				redirect: "error",
				signal: controller.signal,
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				return onFailure();
			}
			const text = await readBoundedBody(response);
			if (text === null) return onFailure();
			let json: unknown;
			try {
				const parsed: unknown = JSON.parse(text);
				json = parsed;
			} catch {
				return onFailure();
			}
			const ids = parseFreeModelIds(json);
			if (ids.length === 0) return onFailure();
			cached = ids;
			cachedAtMs = nowMs();
			failedAtMs = null;
			return cached;
		} catch {
			return onFailure();
		} finally {
			clearTimeout(timer);
		}
	}

	function onFailure(): readonly string[] | null {
		failedAtMs = nowMs();
		return cached;
	}

	function list(): Promise<readonly string[] | null> {
		if (inFlight !== null) return inFlight;
		const now = nowMs();
		if (cached !== null && now - cachedAtMs < FREE_MODEL_LIST_TTL_MS)
			return Promise.resolve(cached);
		if (failedAtMs !== null && now - failedAtMs < FREE_MODEL_RETRY_INTERVAL_MS) {
			return Promise.resolve(cached);
		}
		// `refresh` settles every failure itself, so this promise never rejects. Only the
		// request that is still the current one clears the slot.
		const started: Promise<readonly string[] | null> = refresh().finally(() => {
			if (inFlight === started) inFlight = null;
		});
		inFlight = started;
		return started;
	}

	return { list };
}
