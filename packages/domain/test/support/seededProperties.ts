/**
 * Importing this module pins fast-check's seed, so property tests explore the
 * same cases on every run and a CI failure is reproducible as-is (tests must be
 * deterministic). To explore new cases, change the seed deliberately.
 */
import fc from "fast-check";

export const PROPERTY_SEED = 20_261_011;

fc.configureGlobal({ seed: PROPERTY_SEED });
