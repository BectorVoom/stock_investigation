/**
 * Backward-compatible entry: `bun run start` means production on this PC
 * (`bun run prod`, ADR-0011). The implementation lives in `launch.ts`.
 */
import { runMode } from "./launch.ts";

await runMode("production");
