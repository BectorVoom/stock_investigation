//! Notebook type adapters and the command fold over the shared parser/layout engine.

use super::edits::{build_edit, layout_failure};
use research_contracts::json::to_js_value;
use research_contracts::notebook::Notebook;
use research_contracts::widget_rules::{
	notebook_capacity_problem, reconcile_chart_draft, with_earned_chart_provenance,
};
use research_contracts::widgets::{
	WidgetContent, WidgetCore, WidgetSize as ContractSize, WidgetType,
};
use research_js::json::{Object, Value};
use research_widget_grid::agent::commands::parse_widget_command;
use research_widget_grid::agent::host::{ConfigUnreadable, WidgetDraft};
use research_widget_grid::agent::types::WidgetCommand;
use research_widget_grid::core::layout::{WidgetLayoutLimits, apply_widget_layout_edit};
use research_widget_grid::core::types::{WidgetBase, WidgetSize};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;

/// The index and first rejection of an all-or-nothing notebook command batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("command {index}: {code}: {message}")]
pub struct NotebookCommandFailure {
	/// Zero-based command index (the capacity check belongs to the last command).
	pub index: usize,
	/// Stable command/capacity code.
	pub code: String,
	/// Sentence shown in the repair prompt.
	pub message: String,
}

#[derive(Clone)]
pub(super) struct GridWidget(pub(super) Arc<WidgetCore>);

fn grid_size(size: ContractSize) -> WidgetSize {
	match size {
		ContractSize::Small => WidgetSize::Small,
		ContractSize::Medium => WidgetSize::Medium,
		ContractSize::Large => WidgetSize::Large,
	}
}
fn contract_size(size: WidgetSize) -> ContractSize {
	match size {
		WidgetSize::Small => ContractSize::Small,
		WidgetSize::Medium => ContractSize::Medium,
		WidgetSize::Large => ContractSize::Large,
	}
}
impl WidgetBase for GridWidget {
	fn widget_id(&self) -> &str {
		&self.0.widget_id
	}
	fn widget_type(&self) -> &str {
		self.0.content.widget_type().as_str()
	}
	fn title(&self) -> &str {
		&self.0.title
	}
	fn size(&self) -> WidgetSize {
		grid_size(self.0.size)
	}
	fn with_size(&self, size: WidgetSize) -> Self {
		Self(Arc::new(WidgetCore {
			size: contract_size(size),
			..self.0.as_ref().clone()
		}))
	}
}

pub(super) fn core(widget: &research_contracts::notebook::NotebookWidget) -> WidgetCore {
	WidgetCore {
		widget_id: widget.widget_id.clone(),
		title: widget.title.clone(),
		size: widget.size,
		content: widget.content.clone(),
	}
}

pub(super) struct NotebookType<'a> {
	pub(super) name: &'static str,
	known: &'a HashSet<&'a str>,
}
const ALL_SIZES: [WidgetSize; 3] = [WidgetSize::Small, WidgetSize::Medium, WidgetSize::Large];
const RESEARCH_SIZES: [WidgetSize; 2] = [WidgetSize::Medium, WidgetSize::Large];

impl NotebookType<'_> {
	pub(super) fn default_size(&self) -> WidgetSize {
		match self.name {
			"metric" | "market-metric" => WidgetSize::Small,
			"research" | "indicator-table" | "earnings-calendar" => WidgetSize::Large,
			_ => WidgetSize::Medium,
		}
	}
	pub(super) fn sizes(&self) -> &[WidgetSize] {
		if self.name == "research" {
			&RESEARCH_SIZES
		} else {
			&ALL_SIZES
		}
	}
	pub(super) fn config_of(&self, widget: &GridWidget) -> Result<Object, ConfigUnreadable> {
		if widget.widget_type() != self.name {
			return Err(ConfigUnreadable);
		}
		let mut object = to_js_value(widget.0.as_ref())
			.map_err(|_| ConfigUnreadable)?
			.take_object()
			.ok_or(ConfigUnreadable)?;
		for key in ["widgetId", "type", "title", "size"] {
			object.remove(key);
		}
		Ok(object)
	}
	pub(super) fn build(&self, draft: &WidgetDraft<'_>) -> Result<GridWidget, String> {
		// Generic fields win over config so it cannot smuggle another type or id.
		let mut assembled = draft.config.clone();
		assembled.insert("widgetId", Value::from(draft.widget_id));
		assembled.insert("title", Value::from(draft.title));
		assembled.insert("size", Value::from(draft.size.as_str()));
		assembled.insert("type", Value::from(self.name));
		let value = Value::Object(assembled);
		let value = if self.name == "chart" {
			reconcile_chart_draft(&value)
		} else {
			value
		};
		let widget = research_contracts::validate::<WidgetCore>(&value).map_err(|error| {
			let issues = match &error {
				research_contracts::ContractError::Invalid(issues) => issues.as_slice(),
				research_contracts::ContractError::Json(_) => &[],
			};
			let issue = issues.first();
			let field = issue
				.map(|issue| issue.path_string("."))
				.filter(|s| !s.is_empty())
				.unwrap_or_else(|| "widget".to_owned());
			let message = issue.map_or("is invalid", |issue| issue.message.as_str());
			format!("invalid {} widget: \"{field}\" {message}.", self.name)
		})?;
		if let WidgetContent::Research { component_id } = &widget.content {
			if !self.known.contains(component_id.as_str()) {
				return Err("invalid research widget: \"componentId\" must name a canvas component of this conversation.".to_owned());
			}
		}
		Ok(GridWidget(Arc::new(widget)))
	}
}

/// Pre-applies commands through the shared parser/layout engine, checks exact JSON byte
/// capacity, then earns chart provenance. Changes/snapshots are API-only and
/// intentionally omitted from this runner port (§1.6).
///
/// # Errors
/// Returns the first command failure; the original notebook is never mutated.
pub fn apply_notebook_commands(
	notebook: &Notebook,
	commands: &[Value],
	new_widget_id: &mut dyn FnMut() -> Option<String>,
) -> Result<Vec<WidgetCore>, NotebookCommandFailure> {
	let known: HashSet<&str> = notebook
		.widgets
		.iter()
		.filter_map(|w| match &w.content {
			WidgetContent::Research { component_id } => Some(component_id.as_str()),
			_ => None,
		})
		.collect();
	apply_with_components(notebook, commands, &known, new_widget_id)
}

pub(super) fn apply_with_components(
	notebook: &Notebook,
	commands: &[Value],
	known: &HashSet<&str>,
	new_widget_id: &mut dyn FnMut() -> Option<String>,
) -> Result<Vec<WidgetCore>, NotebookCommandFailure> {
	let failure = |index, code: &str, message: String| NotebookCommandFailure {
		index,
		code: code.to_owned(),
		message,
	};
	if commands.len() > 12 {
		return Err(failure(
			12,
			"INVALID_COMMAND",
			"at most 12 commands are applied per turn.".to_owned(),
		));
	}
	let types: Vec<_> = WidgetType::VALUES
		.iter()
		.map(|name| NotebookType { name, known })
		.collect();
	let previous: Vec<_> = notebook.widgets.iter().map(core).collect();
	let mut widgets: Vec<_> = previous
		.iter()
		.cloned()
		.map(|w| GridWidget(Arc::new(w)))
		.collect();
	for (index, command) in commands.iter().enumerate() {
		let parsed = parse_widget_command(command)
			.map_err(|e| failure(index, e.code.as_str(), e.message))?;
		if matches!(parsed, WidgetCommand::Remove { .. }) {
			return Err(failure(
				index,
				"INVALID_COMMAND",
				"removals are proposed to the owner, never applied by the assistant.".to_owned(),
			));
		}
		let edit = build_edit(&parsed, &widgets, &types, new_widget_id)
			.map_err(|e| failure(index, e.code.as_str(), e.message))?;
		widgets =
			apply_widget_layout_edit(&widgets, &edit, WidgetLayoutLimits { max_widgets: 200 })
				.map_err(|e| {
					let e = layout_failure(e, &parsed, widgets.len());
					failure(index, e.code.as_str(), e.message)
				})?;
	}
	let widgets: Vec<_> = widgets
		.into_iter()
		.map(|w| Arc::try_unwrap(w.0).unwrap_or_else(|shared| shared.as_ref().clone()))
		.collect();
	if let Some(problem) = notebook_capacity_problem(&widgets, &notebook.widgets) {
		return Err(failure(
			commands.len().saturating_sub(1),
			problem.code,
			problem.message,
		));
	}
	Ok(with_earned_chart_provenance(widgets, &previous))
}
