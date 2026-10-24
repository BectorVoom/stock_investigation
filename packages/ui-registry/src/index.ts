export { BASELINE_REGISTRY_ENTRIES, createBaselineUiRegistry } from "./baseline.ts";
/** The registry's catalogs that hosts reuse for the same words (ADR-0031). */
export { cellReasonMessages } from "./cellReasons.messages.ts";
export { BarPlot } from "./charts/BarPlot.tsx";
export {
	type Bar,
	type BarChartSpec,
	type BarModel,
	buildBarModel,
} from "./charts/barModel.ts";
export {
	ChartFrame,
	ChartLegend,
	ChartNotices,
	ChartShell,
	type LegendItem,
} from "./charts/ChartFrame.tsx";
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
	chartWidgetSeries,
	chartWidgetSources,
	chartWidgetToGuardedDataset,
	chartWidgetXAxisTitle,
} from "./charts/chartWidgetDataset.ts";
export {
	type BuildDetailChartInput,
	buildDetailChartModel,
	buildNavigatorModel,
	buildNavigatorOverview,
	type DateAxisStep,
	type DetailChartModel,
	type DetailLastMarker,
	type DetailMaOverlayInput,
	type DetailMaPath,
	type DetailScale,
	type DetailSeriesInput,
	type DetailSeriesPath,
	type DetailSeriesValues,
	type DetailValueMode,
	type DetailValueTag,
	type DetailXTick,
	decimateToWidth,
	ensureTwoBarWindow,
	isValueLabelHidden,
	type LogGateInput,
	layoutTagCenters,
	logScaleBlocked,
	type NavigatorInput,
	type NavigatorModel,
	type NavigatorOverview,
	type NavigatorOverviewInput,
	navigatorWindowRect,
	plotWidthForSize,
	unionBarDays,
	unionOverview,
	VALUE_LABEL_HEIGHT,
} from "./charts/detailChartModel.ts";
export {
	buildHomeLineModel,
	type HomeLineModel,
	type HomeLinePath,
	type HomeLineSeriesInput,
	sparklinePath,
} from "./charts/homeLineModel.ts";
export { LinePlot } from "./charts/LinePlot.tsx";
export {
	buildLineModel,
	type LineChartSpec,
	type LineModel,
	type LineSeriesModel,
	type Marker,
} from "./charts/lineModel.ts";
export {
	type CitationNumbering,
	type ClaimLinksInput,
	chipLabel,
	numberEvidence,
	numbersForClaim,
	sourceHost,
	titleOrHost,
} from "./citationModel.ts";
export { citationMessages } from "./citations.messages.ts";
export {
	type CellBasis,
	type CellDisplay,
	cellBasis,
	cellDisplay,
	type GuardedDataset,
	guardDataset,
	type PresentedLabels,
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
export { positionLabelMessages } from "./positionLabels.messages.ts";
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
