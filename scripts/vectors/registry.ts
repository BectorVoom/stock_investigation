/**
 * Every vector exporter (ADR-0030). An exporter's `name` selects it on the
 * command line; each returned file lands at `vectors/<path>`. Workers add
 * their exporter here (one line each).
 */
import { domainExporter } from "./domain.ts";
import { jsExporter } from "./js.ts";
import { loggingExporter } from "./logging.ts";
import type { VectorExporter } from "./shared.ts";

export const exporters: readonly VectorExporter[] = [jsExporter, domainExporter, loggingExporter];
