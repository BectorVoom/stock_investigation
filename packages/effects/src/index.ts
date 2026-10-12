/**
 * The Effect module itself, reached through the one Effect gateway
 * (ADR-0007). Shell code outside `packages/effects` that needs full Effect
 * programs (sequencing, finalisers, error mapping) imports `Effect` from here
 * rather than depending on `effect` directly, so the workspace keeps a single
 * Effect dependency owner (ARCH-004).
 */
export { Effect } from "effect";
export * from "./errors.ts";
export * from "./logging.ts";
