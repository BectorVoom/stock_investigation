/**
 * Development on this PC (ADR-0011): the working tree, live, against
 * `data-dev/`. Vite hot module replacement for the SPA on
 * http://localhost:3000, the API with reload on change, and the runner
 * restarted when its sources change. One Ctrl+C stops all of them.
 */
import { runMode } from "./launch.ts";

await runMode("development");
