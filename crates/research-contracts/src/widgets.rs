//! The one widget specification of Home and the Notebook
//! (`packages/contracts/src/widgets.ts`, ADR-0024): types, content fields,
//! the generic core and the refinements every widget schema applies.

use research_js::json::{Object, Value};
use serde::Serialize;

use crate::market::{
	MarketRange, earnings_calendar_days_ahead, limits as market_limits, market_series_id,
};
use crate::primitives::{ISO_DATE, id};
use crate::records::{Evidence, ValueBasis, date_or_date_time};
use crate::zod::{
	ArrCheck, Cx, StrCheck, UnionOption, array, decode_fields, decode_object, js_enum, nullable,
	number, optional, refine, run_string, run_union, string, unrecognized,
};

/// `WIDGET_LIMITS`.
pub mod limits {
	use crate::market::limits as market;

	/// Shortest title.
	pub const MIN_TITLE_CHARS: usize = market::MIN_WIDGET_TITLE;
	/// Longest title.
	pub const MAX_TITLE_CHARS: usize = market::MAX_WIDGET_TITLE;
	/// Characters of a text widget's Markdown source.
	pub const MAX_TEXT_CHARS: usize = 8_000;
	/// Caption characters.
	pub const MAX_CAPTION_CHARS: usize = 200;
	/// Unit characters.
	pub const MAX_UNIT_CHARS: usize = 24;
	/// Series of one chart widget.
	pub const MAX_CHART_SERIES: usize = 6;
	/// Points of one chart series.
	pub const MAX_CHART_POINTS: usize = 400;
	/// Characters of a point label.
	pub const MAX_POINT_LABEL_CHARS: usize = 40;
	/// Evidence copies one chart widget may carry (ADR-0026).
	pub const MAX_CHART_SOURCES: usize = 60;
	/// Citations of one chart widget.
	pub const MAX_CHART_SOURCE_IDS: usize = 40;
	/// Columns of a table widget.
	pub const MAX_TABLE_COLUMNS: usize = 12;
	/// Rows of a table widget.
	pub const MAX_TABLE_ROWS: usize = 200;
	/// Characters of a table cell.
	pub const MAX_CELL_CHARS: usize = 200;
	/// Distinct market series of one page.
	pub const MAX_MARKET_SERIES: usize = market::MAX_SERIES;
	/// UTF-8 bytes of all widgets' JSON without metadata.
	pub const MAX_CONTENT_BYTES: usize = 850_000;
}

/// `WIDGET_TYPE_META["task-result"].agentNote`: why an agent never places a
/// task-result widget nor changes its task (ADR-0038 §6). The notebook
/// assistant's refusal quotes it.
pub const TASK_RESULT_AGENT_NOTE: &str = "Agents can move, resize or remove it but cannot add one or change its taskId; the owner adds it from the add menu or the Tasks page.";

/// `WIDGET_TYPE_META["watchlist-prices"].agentNote`: why an agent never
/// places a watchlist-prices widget nor changes its list (ADR-0040 §8). The
/// notebook assistant's refusal quotes it.
pub const WATCHLIST_PRICES_AGENT_NOTE: &str = "No series of its own: it shows the stocks of one Watchlist list. Agents can move, resize or remove it but cannot add one or change its listId; the owner adds it from the add menu or the Watchlist page.";

/// `WIDGET_TEXT_MARKDOWN`: the Markdown subset of a text widget, as agents read it.
pub const WIDGET_TEXT_MARKDOWN: &str = "Markdown subset: # / ## / ### headings, **bold**, *italic*, ~~strike~~, `code`, [label](https://…) links, - bullet lists, 1. numbered lists, - [ ] / - [x] to-dos, > quotes, ``` code blocks, --- dividers; blank line between paragraphs. No HTML, images or tables.";

js_enum! {
	/// `widgetSizeSchema`.
	pub enum WidgetSize {
		Small = "small",
		Medium = "medium",
		Large = "large",
	}
}

js_enum! {
	/// `widgetTypeSchema` (`WIDGET_TYPES`, add-menu order). The widget unions
	/// list their options in the same order, so it is also the order of
	/// zod's "Invalid discriminator value" message.
	pub enum WidgetType {
		Text = "text",
		Metric = "metric",
		Chart = "chart",
		Table = "table",
		Research = "research",
		MarketMetric = "market-metric",
		LineChart = "line-chart",
		StockTable = "stock-table",
		IndicatorTable = "indicator-table",
		EarningsCalendar = "earnings-calendar",
		WatchlistPrices = "watchlist-prices",
		ScheduledTasks = "scheduled-tasks",
		TaskResult = "task-result",
	}
}

/// Every size, for the types that take any.
const ALL_WIDGET_SIZES: [WidgetSize; 3] =
	[WidgetSize::Small, WidgetSize::Medium, WidgetSize::Large];
/// A research widget is never small.
const RESEARCH_WIDGET_SIZES: [WidgetSize; 2] = [WidgetSize::Medium, WidgetSize::Large];

impl WidgetType {
	/// `WIDGET_TYPE_META[type].defaultSize`: the size a new widget of this type gets.
	#[must_use]
	pub const fn default_size(self) -> WidgetSize {
		match self {
			Self::Metric | Self::MarketMetric => WidgetSize::Small,
			Self::Research | Self::IndicatorTable | Self::EarningsCalendar => WidgetSize::Large,
			Self::Text
			| Self::Chart
			| Self::Table
			| Self::LineChart
			| Self::StockTable
			| Self::ScheduledTasks
			| Self::TaskResult
			| Self::WatchlistPrices => WidgetSize::Medium,
		}
	}

	/// `WIDGET_TYPE_META[type].sizes`: the sizes this type may take.
	#[must_use]
	pub fn allowed_sizes(self) -> &'static [WidgetSize] {
		match self {
			Self::Research => &RESEARCH_WIDGET_SIZES,
			_ => &ALL_WIDGET_SIZES,
		}
	}

	/// One of the live market types (`MARKET_WIDGET_TYPES`).
	#[must_use]
	pub const fn is_market(self) -> bool {
		matches!(
			self,
			Self::MarketMetric
				| Self::LineChart
				| Self::StockTable
				| Self::IndicatorTable
				| Self::EarningsCalendar
				| Self::WatchlistPrices
		)
	}
}

/// `widgetTitleSchema`.
pub(crate) const WIDGET_TITLE: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(limits::MIN_TITLE_CHARS),
	StrCheck::Max(limits::MAX_TITLE_CHARS),
];
const UNIT: &[StrCheck] = &[StrCheck::Trim, StrCheck::Max(limits::MAX_UNIT_CHARS)];
const AXIS_LABEL: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_TITLE_CHARS),
];
const TEXT: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_TEXT_CHARS),
];
const CAPTION: &[StrCheck] = &[StrCheck::Trim, StrCheck::Max(limits::MAX_CAPTION_CHARS)];
const POINT_LABEL: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_POINT_LABEL_CHARS),
];
const COLUMN_LABEL: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_CELL_CHARS),
];
const CELL_TEXT: &[StrCheck] = &[StrCheck::Max(limits::MAX_CELL_CHARS)];

/// `widgetChartPointSchema`: one plotted value with its provenance.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartPoint {
	/// Category or date label (trimmed, 1..40).
	pub x: String,
	/// The value.
	pub y: f64,
	/// Basis of an unsourced value.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub basis: Option<ValueBasis>,
	/// Evidence id the widget carries a copy of.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub source_id: Option<String>,
	/// As-of date or time.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub as_of: Option<String>,
}

impl ChartPoint {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let mark = cx.mark();
		let point = decode_object!(cx, input, strict, [], Self {
			x: "x" => string(POINT_LABEL),
			y: "y" => number(&[]),
			basis: "basis" => optional(ValueBasis::decode),
			source_id: "sourceId" => optional(id),
			as_of: "asOf" => optional(date_or_date_time),
		});
		refine(cx, mark, point.as_ref(), |cx, point| {
			if point.source_id.is_some() && point.as_of.is_none() {
				cx.refine_failed(Some("asOf"), "a sourced value must carry an as-of date");
			}
		});
		point
	}

	/// Whether the point carries a basis, a source or an as-of date.
	#[must_use]
	pub const fn has_provenance(&self) -> bool {
		self.basis.is_some() || self.source_id.is_some() || self.as_of.is_some()
	}
}

/// `widgetChartSeriesSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChartSeries {
	/// Series name (trimmed, 1..120).
	pub name: String,
	/// Points (1..400).
	pub points: Vec<ChartPoint>,
}

impl ChartSeries {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			name: "name" => string(AXIS_LABEL),
			points: "points" => array(ChartPoint::decode, &[ArrCheck::Min(1), ArrCheck::Max(limits::MAX_CHART_POINTS)]),
		})
	}
}

/// `widgetTableCellSchema`: text (≤ 200), a finite number or null.
#[derive(Debug, Clone, PartialEq)]
pub enum TableCell {
	/// Text.
	Text(String),
	/// A number.
	Number(f64),
	/// Empty.
	Null,
}

impl Serialize for TableCell {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		match self {
			Self::Text(text) => serializer.serialize_str(text),
			Self::Number(number) => serializer.serialize_f64(*number),
			Self::Null => serializer.serialize_unit(),
		}
	}
}

fn null_cell(cx: &mut Cx, input: Option<&Value>) -> Option<TableCell> {
	match input {
		Some(Value::Null) => Some(TableCell::Null),
		_ => {
			cx.invalid_type("null", input);
			None
		}
	}
}

impl TableCell {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let text =
			|cx: &mut Cx, input: Option<&Value>| run_string(cx, input, CELL_TEXT).map(Self::Text);
		let numeric = |cx: &mut Cx, input: Option<&Value>| number(&[])(cx, input).map(Self::Number);
		let options: [UnionOption<'_, Self>; 3] = [&text, &numeric, &null_cell];
		run_union(cx, input, &options)
	}
}

js_enum! {
	/// Chart type of a `chart` widget.
	pub enum ChartType {
		Line = "line",
		Bar = "bar",
	}
}

js_enum! {
	/// x column kind of a `chart` widget (absent = text).
	pub enum ChartXKind {
		Text = "text",
		Number = "number",
		Date = "date",
	}
}

/// The type-specific fields of a widget (`WIDGET_CONTENT_SHAPES`), tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum WidgetContent {
	/// Rich text (Markdown subset).
	#[serde(rename = "text")]
	Text {
		/// Markdown source (trimmed, 1..8000).
		text: String,
	},
	/// One headline number.
	#[serde(rename = "metric", rename_all = "camelCase")]
	Metric {
		/// Value, null = unavailable.
		value: Option<f64>,
		/// Unit (trimmed, ≤ 24).
		unit: String,
		/// Change in `unit`.
		change: Option<f64>,
		/// Caption (trimmed, ≤ 200).
		caption: String,
		/// As-of date.
		as_of: Option<String>,
	},
	/// A chart that carries its own data.
	#[serde(rename = "chart", rename_all = "camelCase")]
	Chart {
		/// Line or bar.
		chart_type: ChartType,
		/// Unit (trimmed, ≤ 24).
		unit: String,
		/// Series (1..6).
		series: Vec<ChartSeries>,
		/// x axis title.
		#[serde(skip_serializing_if = "Option::is_none")]
		x_label: Option<String>,
		/// y axis title.
		#[serde(skip_serializing_if = "Option::is_none")]
		y_label: Option<String>,
		/// x column kind.
		#[serde(skip_serializing_if = "Option::is_none")]
		x_kind: Option<ChartXKind>,
		/// The chart's own citations (≤ 40).
		#[serde(skip_serializing_if = "Option::is_none")]
		source_ids: Option<Vec<String>>,
		/// A copy of every cited evidence record (≤ 60, ADR-0026).
		#[serde(skip_serializing_if = "Option::is_none")]
		sources: Option<Vec<Evidence>>,
	},
	/// Structured rows under named columns.
	#[serde(rename = "table")]
	Table {
		/// Column labels (1..12, trimmed 1..200).
		columns: Vec<String>,
		/// Rows (≤ 200, each ≤ 12 cells).
		rows: Vec<Vec<TableCell>>,
	},
	/// A research component of the conversation's canvas.
	#[serde(rename = "research", rename_all = "camelCase")]
	Research {
		/// Component id.
		component_id: String,
	},
	/// One live series.
	#[serde(rename = "market-metric", rename_all = "camelCase")]
	MarketMetric {
		/// Series id.
		series_id: String,
	},
	/// One to four live series over a range.
	#[serde(rename = "line-chart", rename_all = "camelCase")]
	LineChart {
		/// Series ids (1..4).
		series_ids: Vec<String>,
		/// Range.
		range: MarketRange,
	},
	/// One row per series.
	#[serde(rename = "stock-table", rename_all = "camelCase")]
	StockTable {
		/// Series ids (1..12).
		series_ids: Vec<String>,
	},
	/// One row per indicator series.
	#[serde(rename = "indicator-table", rename_all = "camelCase")]
	IndicatorTable {
		/// Series ids (1..12).
		series_ids: Vec<String>,
	},
	/// The watchlist's upcoming earnings dates.
	#[serde(rename = "earnings-calendar", rename_all = "camelCase")]
	EarningsCalendar {
		/// 30, 60, 90 or 180.
		days_ahead: f64,
	},
	/// One Watchlist list's stocks with their last close and change from the
	/// previous close (ADR-0040): the owner picks the list when adding it. It
	/// names no series itself; the API resolves the list to its stocks'
	/// series (`pageSeriesIds`) and puts them in the claim.
	#[serde(rename = "watchlist-prices", rename_all = "camelCase")]
	WatchlistPrices {
		/// The list's id.
		list_id: String,
	},
	/// The owner's scheduled tasks (ADR-0033): no content fields and no series.
	#[serde(rename = "scheduled-tasks")]
	ScheduledTasks,
	/// One scheduled task's latest answer (ADR-0038): the owner picks the
	/// task when adding it; no series.
	#[serde(rename = "task-result", rename_all = "camelCase")]
	TaskResult {
		/// The task's id.
		task_id: String,
	},
}

impl WidgetType {
	/// The content keys of this type, in shape order (after the discriminator).
	const fn content_keys(self) -> &'static [&'static str] {
		match self {
			Self::Text => &["text"],
			Self::Metric => &["value", "unit", "change", "caption", "asOf"],
			Self::Chart => &[
				"chartType",
				"unit",
				"series",
				"xLabel",
				"yLabel",
				"xKind",
				"sourceIds",
				"sources",
			],
			Self::Table => &["columns", "rows"],
			Self::Research => &["componentId"],
			Self::MarketMetric => &["seriesId"],
			Self::LineChart => &["seriesIds", "range"],
			Self::StockTable | Self::IndicatorTable => &["seriesIds"],
			Self::EarningsCalendar => &["daysAhead"],
			Self::WatchlistPrices => &["listId"],
			Self::ScheduledTasks => &[],
			Self::TaskResult => &["taskId"],
		}
	}
}

const TABLE_SERIES: &[ArrCheck] = &[
	ArrCheck::Min(1),
	ArrCheck::Max(market_limits::MAX_TABLE_SERIES),
];

impl WidgetContent {
	/// The widget type of this content.
	#[must_use]
	pub const fn widget_type(&self) -> WidgetType {
		match self {
			Self::Text { .. } => WidgetType::Text,
			Self::Metric { .. } => WidgetType::Metric,
			Self::Chart { .. } => WidgetType::Chart,
			Self::Table { .. } => WidgetType::Table,
			Self::Research { .. } => WidgetType::Research,
			Self::MarketMetric { .. } => WidgetType::MarketMetric,
			Self::LineChart { .. } => WidgetType::LineChart,
			Self::StockTable { .. } => WidgetType::StockTable,
			Self::IndicatorTable { .. } => WidgetType::IndicatorTable,
			Self::EarningsCalendar { .. } => WidgetType::EarningsCalendar,
			Self::WatchlistPrices { .. } => WidgetType::WatchlistPrices,
			Self::ScheduledTasks => WidgetType::ScheduledTasks,
			Self::TaskResult { .. } => WidgetType::TaskResult,
		}
	}

	/// Decodes the content fields of type `widget_type` from `object`.
	pub(crate) fn decode_fields(
		cx: &mut Cx,
		object: &Object,
		widget_type: WidgetType,
	) -> Option<Self> {
		match widget_type {
			WidgetType::Text => decode_fields!(cx, object, Self::Text {
				text: "text" => string(TEXT),
			}),
			WidgetType::Metric => decode_fields!(cx, object, Self::Metric {
				value: "value" => nullable(number(&[])),
				unit: "unit" => string(UNIT),
				change: "change" => nullable(number(&[])),
				caption: "caption" => string(CAPTION),
				as_of: "asOf" => nullable(string(ISO_DATE)),
			}),
			WidgetType::Chart => decode_fields!(cx, object, Self::Chart {
				chart_type: "chartType" => ChartType::decode,
				unit: "unit" => string(UNIT),
				series: "series" => array(ChartSeries::decode, &[ArrCheck::Min(1), ArrCheck::Max(limits::MAX_CHART_SERIES)]),
				x_label: "xLabel" => optional(string(AXIS_LABEL)),
				y_label: "yLabel" => optional(string(AXIS_LABEL)),
				x_kind: "xKind" => optional(ChartXKind::decode),
				source_ids: "sourceIds" => optional(array(id, &[ArrCheck::Max(limits::MAX_CHART_SOURCE_IDS)])),
				sources: "sources" => optional(array(Evidence::decode, &[ArrCheck::Max(limits::MAX_CHART_SOURCES)])),
			}),
			WidgetType::Table => decode_fields!(cx, object, Self::Table {
				columns: "columns" => array(string(COLUMN_LABEL), &[ArrCheck::Min(1), ArrCheck::Max(limits::MAX_TABLE_COLUMNS)]),
				rows: "rows" => array(array(TableCell::decode, &[ArrCheck::Max(limits::MAX_TABLE_COLUMNS)]), &[ArrCheck::Max(limits::MAX_TABLE_ROWS)]),
			}),
			WidgetType::Research => decode_fields!(cx, object, Self::Research {
				component_id: "componentId" => id,
			}),
			WidgetType::MarketMetric => decode_fields!(cx, object, Self::MarketMetric {
				series_id: "seriesId" => market_series_id,
			}),
			WidgetType::LineChart => decode_fields!(cx, object, Self::LineChart {
				series_ids: "seriesIds" => array(market_series_id, &[ArrCheck::Min(1), ArrCheck::Max(market_limits::MAX_LINE_CHART_SERIES)]),
				range: "range" => MarketRange::decode,
			}),
			WidgetType::StockTable => decode_fields!(cx, object, Self::StockTable {
				series_ids: "seriesIds" => array(market_series_id, TABLE_SERIES),
			}),
			WidgetType::IndicatorTable => decode_fields!(cx, object, Self::IndicatorTable {
				series_ids: "seriesIds" => array(market_series_id, TABLE_SERIES),
			}),
			WidgetType::EarningsCalendar => decode_fields!(cx, object, Self::EarningsCalendar {
				days_ahead: "daysAhead" => earnings_calendar_days_ahead,
			}),
			WidgetType::WatchlistPrices => decode_fields!(cx, object, Self::WatchlistPrices {
				list_id: "listId" => id,
			}),
			WidgetType::ScheduledTasks => Some(Self::ScheduledTasks),
			WidgetType::TaskResult => decode_fields!(cx, object, Self::TaskResult {
				task_id: "taskId" => id,
			}),
		}
	}

	/// Market series this widget names, in its own order (`dashboardWidgetSeriesIds`).
	/// A watchlist-prices widget names none: its list's series are the page's
	/// (`pageSeriesIds`, ADR-0040 §4), which the API resolves and claims.
	#[must_use]
	pub fn series_ids(&self) -> &[String] {
		match self {
			Self::MarketMetric { series_id } => std::slice::from_ref(series_id),
			Self::LineChart { series_ids, .. }
			| Self::StockTable { series_ids }
			| Self::IndicatorTable { series_ids } => series_ids,
			Self::Text { .. }
			| Self::Metric { .. }
			| Self::Chart { .. }
			| Self::Table { .. }
			| Self::Research { .. }
			| Self::EarningsCalendar { .. }
			| Self::WatchlistPrices { .. }
			| Self::ScheduledTasks
			| Self::TaskResult { .. } => &[],
		}
	}
}

/// `chartWidgetCitedIds`: `sourceIds`, then the points' sources, first appearance first.
#[must_use]
pub fn chart_cited_ids<'a>(
	source_ids: Option<&'a [String]>,
	series: &'a [ChartSeries],
) -> Vec<&'a str> {
	let mut ids: Vec<&str> = Vec::new();
	let mut push = |id: &'a str| {
		if !ids.contains(&id) {
			ids.push(id);
		}
	};
	for id in source_ids.unwrap_or_default() {
		push(id);
	}
	for entry in series {
		for point in &entry.points {
			if let Some(id) = &point.source_id {
				push(id);
			}
		}
	}
	ids
}

/// The three refinements every widget schema applies (rows match columns,
/// no repeated series, one copy per cited source).
fn widget_refinements(cx: &mut Cx, content: &WidgetContent) {
	if let WidgetContent::Table { columns, rows } = content
		&& !rows.iter().all(|row| row.len() == columns.len())
	{
		cx.refine_failed(
			Some("rows"),
			"every table row needs exactly one cell per column",
		);
	}
	let ids = content.series_ids();
	let distinct = ids
		.iter()
		.enumerate()
		.all(|(index, id)| !ids.get(..index).unwrap_or_default().contains(id));
	if !distinct {
		cx.refine_failed(Some("seriesIds"), "a widget must not repeat a series");
	}
	if let WidgetContent::Chart {
		series,
		source_ids,
		sources,
		..
	} = content
	{
		let cited = chart_cited_ids(source_ids.as_deref(), series);
		let copies: Vec<&str> = sources
			.iter()
			.flatten()
			.map(|source| source.evidence_id.as_str())
			.collect();
		let unique_copies = copies
			.iter()
			.enumerate()
			.all(|(index, id)| !copies.get(..index).unwrap_or_default().contains(id));
		let matches = unique_copies
			&& copies.len() == cited.len()
			&& cited.iter().all(|id| copies.contains(id));
		if !matches {
			cx.refine_failed(
				Some("sources"),
				"a chart must carry exactly one copy of each source it cites, and no other",
			);
		}
	}
}

const CORE_KEYS: [&str; 3] = ["widgetId", "title", "size"];

/// Decodes a widget-shaped union member: the core, then `meta` (decoded by
/// `decode_meta` under `meta_keys`), the discriminator and the content, then
/// unknown keys and the three refinements.
pub(crate) fn decode_widget_union<M>(
	cx: &mut Cx,
	input: Option<&Value>,
	meta_keys: &[&str],
	decode_meta: impl FnOnce(&mut Cx, &Object) -> Option<M>,
) -> Option<(String, String, WidgetSize, M, WidgetContent)> {
	let mark = cx.mark();
	let decoded =
		crate::zod::run_discriminated(cx, input, "type", WidgetType::VALUES, |cx, tag| {
			let widget_type = WidgetType::ALL.get(tag).copied()?;
			let object = input.and_then(Value::as_object)?;
			let widget_id = cx.at_key("widgetId", |cx| id(cx, object.get("widgetId")));
			let title = cx.at_key("title", |cx| {
				run_string(cx, object.get("title"), WIDGET_TITLE)
			});
			let size = cx.at_key("size", |cx| WidgetSize::decode(cx, object.get("size")));
			let meta = decode_meta(cx, object);
			let content = WidgetContent::decode_fields(cx, object, widget_type);
			let mut known: Vec<&str> = CORE_KEYS.to_vec();
			known.extend_from_slice(meta_keys);
			known.push("type");
			known.extend_from_slice(widget_type.content_keys());
			unrecognized(cx, object, &known);
			Some((widget_id?, title?, size?, meta?, content?))
		});
	refine(cx, mark, decoded.as_ref(), |cx, (_, _, _, _, content)| {
		widget_refinements(cx, content)
	});
	decoded
}

/// `widgetCoreSchema`: a widget without server-stamped metadata.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetCore {
	/// Widget id.
	pub widget_id: String,
	/// Title (trimmed, 1..120).
	pub title: String,
	/// Size.
	pub size: WidgetSize,
	/// Type and content.
	#[serde(flatten)]
	pub content: WidgetContent,
}

impl WidgetCore {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_widget_union(cx, input, &[], |_, _| Some(())).map(
			|(widget_id, title, size, (), content)| Self {
				widget_id,
				title,
				size,
				content,
			},
		)
	}
}

/// `chartDraftSchema`: the chart shape without the citation rule (an agent's
/// draft before reconciling it).
pub(crate) fn decode_chart_draft(cx: &mut Cx, input: Option<&Value>) -> Option<WidgetCore> {
	let object = crate::zod::object_input(cx, input)?;
	let widget_id = cx.at_key("widgetId", |cx| id(cx, object.get("widgetId")));
	let title = cx.at_key("title", |cx| {
		run_string(cx, object.get("title"), WIDGET_TITLE)
	});
	let size = cx.at_key("size", |cx| WidgetSize::decode(cx, object.get("size")));
	let tag = cx.at_key("type", |cx| {
		crate::zod::literal("chart")(cx, object.get("type"))
	});
	let content = WidgetContent::decode_fields(cx, object, WidgetType::Chart);
	let mut known: Vec<&str> = CORE_KEYS.to_vec();
	known.push("type");
	known.extend_from_slice(WidgetType::Chart.content_keys());
	unrecognized(cx, object, &known);
	tag?;
	Some(WidgetCore {
		widget_id: widget_id?,
		title: title?,
		size: size?,
		content: content?,
	})
}
