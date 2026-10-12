import { createApp } from "./app.ts";

/** Cloudflare Worker entry point. Static assets are served by the platform; only /api/* reaches here. */
const app = createApp();

export default { fetch: app.fetch };
