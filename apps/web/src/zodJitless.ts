import { config } from "zod";

/**
 * The very first module the SPA entry evaluates (imported first in
 * `main.tsx`, before any schema is created). Zod probes `new Function` once
 * to decide whether JIT-compiled parsers are available — at schema-creation
 * time, so a later call would be too late. The probe is caught, but strict
 * engines (Firefox) report the blocked eval as a Content-Security-Policy
 * console error on every page load. The SPA validates small payloads and
 * never needs JIT parsing, so it opts out up front: no eval is ever
 * attempted. Scoped to this entry point — the Worker and Node paths keep
 * their own configuration (and their bench numbers).
 */
config({ jitless: true });
