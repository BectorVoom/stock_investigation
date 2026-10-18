/**
 * Every vector exporter (ADR-0030). An exporter's `name` selects it on the
 * command line; each returned file lands at `vectors/<path>`. Workers add
 * their exporter here (one line each).
 */
import { arraySortExporter } from "./arraySort.ts";
import { contractsExporter } from "./contracts.ts";
import { dateExporter } from "./date.ts";
import { domainExporter } from "./domain.ts";
import { domainNewsExporter } from "./domainNews.ts";
import { feedExporter } from "./feed.ts";
import { financeExporter } from "./finance.ts";
import { googleExporter } from "./google.ts";
import { htmlExporter } from "./html.ts";
import { jsExporter } from "./js.ts";
import { loggingExporter } from "./logging.ts";
import { mathExporter } from "./math.ts";
import { modelTextExporter } from "./modelText.ts";
import { netExporter } from "./net.ts";
import { notebookExporter } from "./notebook.ts";
import { pipelineExporter } from "./pipeline.ts";
import { providersExporter } from "./providers.ts";
import { runnerExporter } from "./runner.ts";
import type { VectorExporter } from "./shared.ts";
import { toolsExporter } from "./tools.ts";
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
	netExporter,
	arraySortExporter,
	financeExporter,
	googleExporter,
	notebookExporter,
	pipelineExporter,
	toolsExporter,
	providersExporter,
	runnerExporter,
];
