import { config } from "zod/v4";

// Vite aliases bare `zod` imports to this browser-only seam. Importing the
// unaliased subpath avoids a cycle and keeps the normal public API/types.
export * from "zod/v4";
export { default } from "zod/v4";

/**
 * Every browser schema depends on this module, so configuration runs before
 * schema creation even when the bundler merges contracts into a shared chunk.
 * Entry-point import order alone cannot guarantee that. Skip Zod's eval probe
 * and JIT parsers under our strict CSP; Worker and Node builds keep their defaults.
 */
config({ jitless: true });
