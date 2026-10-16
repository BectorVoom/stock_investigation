export { BASELINE_REGISTRY_ENTRIES, createBaselineUiRegistry } from "./baseline.ts";
export { ChartFrame, ChartLegend, type LegendItem } from "./charts/ChartFrame.tsx";
export {
	buildXTicks,
	CHART_INK,
	contiguousRuns,
	DEFAULT_PLOT,
	extractSeries,
	FONT_SIZE,
	LABELLED_PLOT,
	linearScale,
	nearestIndex,
	niceTicks,
	type PlotArea,
	planSeries,
	presentedSeriesLabels,
	type Scale,
	SERIES_COLORS,
	seriesColor,
	thinnedIndexes,
	VIEW_HEIGHT,
	VIEW_WIDTH,
	valueExtent,
	type WithheldSeries,
	type XTick,
	xAxisModel,
} from "./charts/chartMath.ts";
export {
	type BuildDetailChartInput,
	buildDetailChartModel,
	buildNavigatorModel,
	type DetailChartModel,
	type DetailLastMarker,
	type DetailMaOverlayInput,
	type DetailMaPath,
	type DetailScale,
	type DetailSeriesInput,
	type DetailSeriesPath,
	type DetailSeriesValues,
	type DetailTickGranularity,
	type DetailValueMode,
	type DetailXTick,
	decimateToWidth,
	ensureTwoBarWindow,
	formatDetailTick,
	type LogGateInput,
	logScaleBlocked,
	type NavigatorInput,
	type NavigatorModel,
	plotWidthForSize,
	tickGranularityForSpan,
	unionOverview,
} from "./charts/detailChartModel.ts";
export {
	buildHomeLineModel,
	type HomeLineModel,
	type HomeLinePath,
	type HomeLineSeriesInput,
	sparklinePath,
} from "./charts/homeLineModel.ts";
export {
	type CitationNumbering,
	type ClaimLinksInput,
	chipLabel,
	numberEvidence,
	numbersForClaim,
	sourceHost,
	titleOrHost,
} from "./citationModel.ts";
export {
	type CellBasis,
	type CellDisplay,
	cellBasis,
	cellDisplay,
	type GuardedDataset,
	guardDataset,
	resolveDataset,
} from "./datasetGuard.ts";
export { formatAxisTick, formatIsoDate, formatNumber, safeHttpsUrl } from "./format.ts";
export { ClaimStatusBadge, ClaimTypeBadge } from "./parts/Badges.tsx";
export {
	CitationChip,
	type CitationInteraction,
	type CitationRelation,
	CitationScope,
	type CitationScopeValue,
	ComponentCitation,
	citationChipEscape,
	citationGroupFocusOut,
	createCitationInteraction,
	SourceCard,
	SourceList,
	useCitationScope,
} from "./parts/citations.tsx";
export { DatasetTable } from "./parts/DatasetTable.tsx";
export {
	DateText,
	SafeLink,
	SourceCitation,
	type SourceMap,
	SourceUnavailable,
} from "./parts/SourceLinks.tsx";
export { CannotRender, DataUnavailable, EmptyState, Unavailable } from "./parts/states.tsx";
export { type PositionLabels, type PositionMetric, positionLabels } from "./positionLabels.ts";
export {
	type ComponentRegistryEntry,
	type ComponentRenderer,
	createUiRegistry,
	defineRegistryEntry,
	type JsonObject,
	type PropsRejection,
	pairDefinitionWithRenderer,
	type RenderContext,
	type RendererProps,
	type ResolvedComponent,
	type UiRegistry,
	type WorkspaceComponent,
	type WorkspaceState,
} from "./registry.tsx";
export { WorkspaceComponentView } from "./WorkspaceComponentView.tsx";
