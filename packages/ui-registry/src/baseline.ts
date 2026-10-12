import {
	BASELINE_COMPONENT_DEFINITIONS,
	barChartPropsSchema,
	type ComponentDefinition,
	candlestickChartPropsSchema,
	companyProfilePropsSchema,
	dataTablePropsSchema,
	financialTablePropsSchema,
	imageGalleryPropsSchema,
	lineChartPropsSchema,
	newsCardPropsSchema,
	researchReportPropsSchema,
	sourceListPropsSchema,
} from "@research/contracts";
import {
	type ComponentRegistryEntry,
	type ComponentRenderer,
	createUiRegistry,
	type JsonObject,
	pairDefinitionWithRenderer,
	type UiRegistry,
} from "./registry.tsx";
import { BarChart } from "./renderers/BarChart.tsx";
import { CandlestickChart } from "./renderers/CandlestickChart.tsx";
import { CompanyProfile, ImageGallery, NewsCard, SourceListComponent } from "./renderers/cards.tsx";
import { LineChart } from "./renderers/LineChart.tsx";
import { ResearchReport } from "./renderers/ResearchReport.tsx";
import { DataTable, FinancialTable } from "./renderers/tables.tsx";

function baselineEntry<Props extends JsonObject>(
	componentType: string,
	propsSchema: ComponentDefinition<Props>["propsSchema"],
	renderer: ComponentRenderer<Props>,
): ComponentRegistryEntry {
	const definition = BASELINE_COMPONENT_DEFINITIONS.find(
		(candidate) => candidate.componentType === componentType,
	);
	if (definition === undefined) {
		throw new Error(`"${componentType}" is not a baseline component definition`);
	}
	return pairDefinitionWithRenderer(definition, propsSchema, renderer);
}

/**
 * The ten V1 component types, each contracts definition paired with its
 * renderer. Extensions append their own entries at the composition root:
 * `createUiRegistry([...BASELINE_REGISTRY_ENTRIES, myEntry])`.
 */
export const BASELINE_REGISTRY_ENTRIES: readonly ComponentRegistryEntry[] = [
	baselineEntry("data-table", dataTablePropsSchema, DataTable),
	baselineEntry("financial-table", financialTablePropsSchema, FinancialTable),
	baselineEntry("line-chart", lineChartPropsSchema, LineChart),
	baselineEntry("bar-chart", barChartPropsSchema, BarChart),
	baselineEntry("candlestick-chart", candlestickChartPropsSchema, CandlestickChart),
	baselineEntry("news-card", newsCardPropsSchema, NewsCard),
	baselineEntry("source-list", sourceListPropsSchema, SourceListComponent),
	baselineEntry("company-profile", companyProfilePropsSchema, CompanyProfile),
	baselineEntry("image-gallery", imageGalleryPropsSchema, ImageGallery),
	baselineEntry("research-report", researchReportPropsSchema, ResearchReport),
];

export function createBaselineUiRegistry(): UiRegistry {
	return createUiRegistry(BASELINE_REGISTRY_ENTRIES);
}
