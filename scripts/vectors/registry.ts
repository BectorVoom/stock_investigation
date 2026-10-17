/**
 * Every vector exporter (ADR-0030). An exporter's `name` selects it on the
 * command line; each returned file lands at `vectors/<path>`. Workers add
 * their exporter here (one line each).
 */
import { contractsExporter } from "./contracts.ts";
import { dateExporter } from "./date.ts";
import { domainExporter } from "./domain.ts";
import { domainNewsExporter } from "./domainNews.ts";
import { feedExporter } from "./feed.ts";
import { htmlExporter } from "./html.ts";
import { jsExporter } from "./js.ts";
import { loggingExporter } from "./logging.ts";
import { mathExporter } from "./math.ts";
import { modelTextExporter } from "./modelText.ts";
import type { VectorExporter } from "./shared.ts";
import { widgetGridExporter } from "./widgetGrid.ts";

export const exporters: readonly VectorExporter[] = [
	jsExporter,
	domainNewsExporter,
	dateExporter,
	feedExporter,
	htmlExporter,
	contractsExporter,
	domainExporter,
	loggingExporter,
	widgetGridExporter,
	modelTextExporter,
	mathExporter,
];
