//! The widget rules the notebook path applies after decoding
//! (`widgets.ts` / `notebook.ts`): chart citation reconciliation, earned
//! chart provenance under AI agents (ADR-0026), content bytes and the
//! notebook capacity rule.

use rayon::prelude::*;
use research_js::json::Value;
use serde::Serialize;

use crate::json::to_js_json;
use crate::notebook::{NotebookWidget, limits};
use crate::records::Evidence;
use crate::widgets::{
	ChartPoint, ChartSeries, WidgetContent, WidgetCore, chart_cited_ids, decode_chart_draft,
};
use crate::zod::Cx;

/// A chart's content fields, borrowed.
struct ChartView<'a> {
	unit: &'a str,
	series: &'a [ChartSeries],
	x_label: Option<&'a str>,
	y_label: Option<&'a str>,
	x_kind: Option<&'a str>,
	source_ids: Option<&'a [String]>,
}

fn chart_view(content: &WidgetContent) -> Option<ChartView<'_>> {
	match content {
		WidgetContent::Chart {
			unit,
			series,
			x_label,
			y_label,
			x_kind,
			source_ids,
			..
		} => Some(ChartView {
			unit,
			series,
			x_label: x_label.as_deref(),
			y_label: y_label.as_deref(),
			x_kind: x_kind.map(|kind| kind.as_str()),
			source_ids: source_ids.as_deref(),
		}),
		_ => None,
	}
}

fn json_text<T: Serialize + ?Sized>(value: &T) -> String {
	to_js_json(value).unwrap_or_default()
}

/// `chartMeaningKey`: unit, both axis titles and the x kind.
fn chart_meaning_key(chart: &ChartView<'_>) -> String {
	json_text(&(
		chart.unit,
		chart.y_label,
		chart.x_label,
		chart.x_kind.unwrap_or("text"),
	))
}

/// `chartContentKey`: the meaning, the series and the citations.
fn chart_content_key(chart: &ChartView<'_>) -> String {
	json_text(&(
		chart_meaning_key(chart),
		chart.series,
		chart.source_ids.unwrap_or_default(),
	))
}

/// `pointKey`.
fn point_key(series_name: &str, occurrence: usize, point: &ChartPoint) -> String {
	json_text(&(
		series_name,
		occurrence,
		&point.x,
		point.y,
		point.basis.map(|basis| basis.as_str()),
		point.source_id.as_deref(),
		point.as_of.as_deref(),
	))
}

/// Counts label occurrences within one series, as the TypeScript `seen` map does.
fn occurrences<'a>(points: &'a [ChartPoint]) -> impl Iterator<Item = (usize, &'a ChartPoint)> {
	let mut seen: Vec<(&'a str, usize)> = Vec::new();
	points.iter().map(move |point| {
		let occurrence = match seen.iter_mut().find(|(label, _)| *label == point.x) {
			Some((_, count)) => {
				let occurrence = *count;
				*count += 1;
				occurrence
			}
			None => {
				seen.push((&point.x, 1));
				0
			}
		};
		(occurrence, point)
	})
}

/// `provenanceKeys`: every provenance-carrying point, keyed.
fn provenance_keys(chart: &ChartView<'_>) -> Vec<String> {
	let mut keys = Vec::new();
	for entry in chart.series {
		for (occurrence, point) in occurrences(&entry.points) {
			if point.has_provenance() {
				keys.push(point_key(&entry.name, occurrence, point));
			}
		}
	}
	keys
}

/// `reconciled(chart)`: a copy no point or `sourceIds` cites is dropped, a
/// citation without a copy loses its source; empty lists are left out.
fn reconciled(content: WidgetContent) -> WidgetContent {
	let WidgetContent::Chart {
		chart_type,
		unit,
		series,
		x_label,
		y_label,
		x_kind,
		source_ids,
		sources,
	} = content
	else {
		return content;
	};
	// `new Map(sources.map(copy => [id, copy]))`: first position, last value.
	let mut copies: Vec<Evidence> = Vec::new();
	for copy in sources.unwrap_or_default() {
		match copies
			.iter_mut()
			.find(|existing| existing.evidence_id == copy.evidence_id)
		{
			Some(existing) => *existing = copy,
			None => copies.push(copy),
		}
	}
	let has_copy = |id: &str| copies.iter().any(|copy| copy.evidence_id == id);
	let series: Vec<ChartSeries> = series
		.into_iter()
		.map(|entry| ChartSeries {
			name: entry.name,
			points: entry
				.points
				.into_iter()
				.map(|point| match &point.source_id {
					Some(id) if !has_copy(id) => ChartPoint {
						source_id: None,
						as_of: None,
						..point
					},
					_ => point,
				})
				.collect(),
		})
		.collect();
	let source_ids: Vec<String> = source_ids
		.unwrap_or_default()
		.into_iter()
		.filter(|id| has_copy(id))
		.collect();
	let cited: Vec<String> = chart_cited_ids(Some(&source_ids), &series)
		.into_iter()
		.map(str::to_owned)
		.collect();
	let sources: Vec<Evidence> = copies
		.into_iter()
		.filter(|copy| cited.contains(&copy.evidence_id))
		.collect();
	WidgetContent::Chart {
		chart_type,
		unit,
		series,
		x_label,
		y_label,
		x_kind,
		source_ids: (!source_ids.is_empty()).then_some(source_ids),
		sources: (!sources.is_empty()).then_some(sources),
	}
}

/// `reconcileChartDraft(input)`: an agent's chart draft (config merged over
/// the stored widget) with its citations reconciled; any other input is
/// returned unchanged for the strict schema to report.
#[must_use]
pub fn reconcile_chart_draft(input: &Value) -> Value {
	let mut cx = Cx::new();
	match decode_chart_draft(&mut cx, Some(input)) {
		Some(draft) if cx.issues().is_empty() => {
			let core = WidgetCore {
				content: reconciled(draft.content),
				..draft
			};
			crate::json::to_js_value(&core).unwrap_or_else(|_| input.clone())
		}
		_ => input.clone(),
	}
}

fn without_provenance(point: ChartPoint) -> ChartPoint {
	ChartPoint {
		basis: None,
		source_id: None,
		as_of: None,
		..point
	}
}

/// `withEarnedChartProvenance(next, previous)` (ADR-0026): what an AI agent
/// writes keeps only the provenance it carried over unchanged — same
/// widget, series, meaning, label occurrence and value — or when the whole
/// chart is an unchanged copy of one on the page.
#[must_use]
pub fn with_earned_chart_provenance(
	next: Vec<WidgetCore>,
	previous: &[WidgetCore],
) -> Vec<WidgetCore> {
	let mut before: Vec<(&str, ChartView<'_>)> = Vec::new();
	let mut contents: Vec<String> = Vec::new();
	for widget in previous {
		if let Some(view) = chart_view(&widget.content) {
			contents.push(chart_content_key(&view));
			// `Map.set`: a later widget with the same id replaces the earlier one.
			match before.iter_mut().find(|(id, _)| *id == widget.widget_id) {
				Some(entry) => entry.1 = view,
				None => before.push((&widget.widget_id, view)),
			}
		}
	}
	next.into_iter()
		.map(|widget| {
			let Some(view) = chart_view(&widget.content) else {
				return widget;
			};
			if contents.contains(&chart_content_key(&view)) {
				return WidgetCore {
					content: reconciled(widget.content),
					..widget
				};
			}
			let old = before
				.iter()
				.find(|(id, _)| *id == widget.widget_id)
				.map(|(_, view)| view);
			let kept: Vec<String> = match old {
				Some(old) if chart_meaning_key(old) == chart_meaning_key(&view) => {
					provenance_keys(old)
				}
				_ => Vec::new(),
			};
			let old_ids: Vec<&str> = old
				.and_then(|old| old.source_ids)
				.unwrap_or_default()
				.iter()
				.map(String::as_str)
				.collect();
			let mut any_kept = false;
			let WidgetCore {
				widget_id,
				title,
				size,
				content,
			} = widget;
			let WidgetContent::Chart {
				chart_type,
				unit,
				series,
				x_label,
				y_label,
				x_kind,
				source_ids,
				sources,
			} = content
			else {
				return WidgetCore {
					widget_id,
					title,
					size,
					content,
				};
			};
			let series: Vec<ChartSeries> = series
				.into_iter()
				.map(|entry| {
					let keys: Vec<(usize, bool)> = occurrences(&entry.points)
						.map(|(occurrence, point)| (occurrence, point.has_provenance()))
						.collect();
					let points = entry
						.points
						.into_iter()
						.zip(keys)
						.map(|(point, (occurrence, provenance))| {
							if !provenance {
								return point;
							}
							if kept.contains(&point_key(&entry.name, occurrence, &point)) {
								any_kept = true;
								return point;
							}
							without_provenance(point)
						})
						.collect();
					ChartSeries {
						name: entry.name,
						points,
					}
				})
				.collect();
			let source_ids: Vec<String> = if any_kept {
				source_ids
					.unwrap_or_default()
					.into_iter()
					.filter(|id| old_ids.contains(&id.as_str()))
					.collect()
			} else {
				Vec::new()
			};
			let content = reconciled(WidgetContent::Chart {
				chart_type,
				unit,
				series,
				x_label,
				y_label,
				x_kind,
				source_ids: (!source_ids.is_empty()).then_some(source_ids),
				sources,
			});
			WidgetCore {
				widget_id,
				title,
				size,
				content,
			}
		})
		.collect()
}

/// A widget whose content bytes `notebookContentBytes` measures.
pub trait ContentSized: Serialize + Sync {
	/// UTF-8 bytes of the widget's JSON without its server-stamped metadata.
	fn content_bytes(&self) -> usize;
}

impl ContentSized for WidgetCore {
	fn content_bytes(&self) -> usize {
		json_text(self).len()
	}
}

impl ContentSized for NotebookWidget {
	fn content_bytes(&self) -> usize {
		// `widgetContentBytes(widgets, META_KEYS)`: the whole JSON minus each
		// metadata member and its comma — the bytes of the core alone.
		let core = WidgetCore {
			widget_id: self.widget_id.clone(),
			title: self.title.clone(),
			size: self.size,
			content: self.content.clone(),
		};
		json_text(&core).len()
	}
}

/// Below this many widgets the sum is computed sequentially.
const PARALLEL_THRESHOLD: usize = 32;

/// `notebookContentBytes`: summed in parallel for large notebooks (an
/// integer sum, so the order of the parts does not matter).
#[must_use]
pub fn notebook_content_bytes<W: ContentSized>(widgets: &[W]) -> usize {
	if widgets.len() < PARALLEL_THRESHOLD {
		widgets.iter().map(ContentSized::content_bytes).sum()
	} else {
		widgets.par_iter().map(ContentSized::content_bytes).sum()
	}
}

/// Why a notebook cannot be stored (`NotebookCapacityProblem`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NotebookCapacityProblem {
	/// `TOO_MANY_WIDGETS`, `NOTEBOOK_TOO_LARGE` or `TOO_MANY_SERIES`.
	pub code: &'static str,
	/// The fixed sentence.
	pub message: String,
}

fn distinct_series_count<'a>(contents: impl Iterator<Item = &'a WidgetContent>) -> usize {
	let mut ids: Vec<&str> = Vec::new();
	for content in contents {
		for id in content.series_ids() {
			if !ids.contains(&id.as_str()) {
				ids.push(id);
			}
		}
	}
	ids.len()
}

/// `notebookCapacityProblem(next, previous)`: one rule for owner saves and
/// the assistant's commands. A notebook already over the byte cap may
/// shrink or be rearranged; it may not grow.
#[must_use]
pub fn notebook_capacity_problem<P: ContentSized + HasContent>(
	next: &[WidgetCore],
	previous: &[P],
) -> Option<NotebookCapacityProblem> {
	if next.len() > limits::MAX_WIDGETS {
		return Some(NotebookCapacityProblem {
			code: "TOO_MANY_WIDGETS",
			message: format!(
				"A notebook holds at most {} widgets. Remove one before adding another.",
				limits::MAX_WIDGETS
			),
		});
	}
	let series = distinct_series_count(next.iter().map(|widget| &widget.content));
	if series > limits::MAX_MARKET_SERIES
		&& series > distinct_series_count(previous.iter().map(HasContent::content))
	{
		return Some(NotebookCapacityProblem {
			code: "TOO_MANY_SERIES",
			message: format!(
				"A notebook's market widgets name at most {} distinct series. Remove a series before adding another.",
				limits::MAX_MARKET_SERIES
			),
		});
	}
	let bytes = notebook_content_bytes(next);
	if bytes > limits::MAX_CONTENT_BYTES && bytes > notebook_content_bytes(previous) {
		return Some(NotebookCapacityProblem {
			code: "NOTEBOOK_TOO_LARGE",
			message: format!(
				"A notebook holds at most {} KB of widget content. Remove a widget or shorten a large table, chart or text first.",
				limits::MAX_CONTENT_BYTES / 1000
			),
		});
	}
	None
}

/// A widget with type-specific content.
pub trait HasContent {
	/// The content.
	fn content(&self) -> &WidgetContent;
}

impl HasContent for WidgetCore {
	fn content(&self) -> &WidgetContent {
		&self.content
	}
}

impl HasContent for NotebookWidget {
	fn content(&self) -> &WidgetContent {
		&self.content
	}
}
