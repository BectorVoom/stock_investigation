/**
 * Production on this PC (ADR-0011): serves ONLY the built release in
 * `release/` (see `bun run prod:build`) on http://localhost:8787, with the
 * owner's data in `data/`. No reload on change: promoting a change means
 * `bun run verify`, then `bun run prod:build`, then a restart.
 */
import { runMode } from "./launch.ts";

await runMode("production");
