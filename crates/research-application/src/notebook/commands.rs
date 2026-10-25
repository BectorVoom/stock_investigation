//! Notebook type adapters and the command fold over the shared parser/layout engine.

use research_contracts::json::to_js_value;
use research_contracts::notebook::{Notebook, limits};
use research_contracts::widget_rules::{
	notebook_capacity_problem, reconcile_chart_draft_core, with_earned_chart_provenance,
};
use research_contracts::widgets::{
	TASK_RESULT_AGENT_NOTE, WATCHLIST_PRICES_AGENT_NOTE, WidgetContent, WidgetCore,
	WidgetSize as ContractSize, WidgetType,
};
use research_js::json::{Object, Value};
use research_widget_grid::agent::commands::parse_widget_command;
use research_widget_grid::agent::host::{
	ConfigUnreadable, MemoryLayoutStore, WidgetAgentHost, WidgetAgentType, WidgetDraft,
};
use research_widget_grid::agent::types::WidgetCommand;
use research_widget_grid::core::layout::WidgetLayoutLimits;
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

/// One notebook widget type as the shared agent host sees it. The host's
/// label, description and schema only feed the snapshots the API serves, which
/// this runner never builds, so they are not carried here.
pub(super) struct NotebookType<'a> {
	widget_type: WidgetType,
	sizes: Vec<WidgetSize>,
	known: &'a HashSet<&'a str>,
}
static NO_SCHEMA: Value = Value::Null;

impl<'a> NotebookType<'a> {
	fn new(widget_type: WidgetType, known: &'a HashSet<&'a str>) -> Self {
		Self {
			widget_type,
			sizes: widget_type
				.allowed_sizes()
				.iter()
				.copied()
				.map(grid_size)
				.collect(),
			known,
		}
	}
}

impl WidgetAgentType<GridWidget> for NotebookType<'_> {
	fn type_name(&self) -> &str {
		self.widget_type.as_str()
	}
	fn label(&self) -> &str {
		self.widget_type.as_str()
	}
	fn description(&self) -> &str {
		""
	}
	fn default_size(&self) -> WidgetSize {
		grid_size(self.widget_type.default_size())
	}
	fn sizes(&self) -> &[WidgetSize] {
		&self.sizes
	}
	fn config_schema(&self) -> &Value {
		&NO_SCHEMA
	}
	fn config_of(&self, widget: &GridWidget) -> Result<Object, ConfigUnreadable> {
		if widget.widget_type() != self.type_name() {
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
	fn owner_placed(&self) -> Option<&str> {
		// ADR-0038 §6, ADR-0040 §8: the assistant cannot look tasks or lists up,
		// so it only arranges these (`WIDGET_TYPE_META[type].ownerPlacedOnly`).
		match self.widget_type {
			WidgetType::TaskResult => Some(TASK_RESULT_AGENT_NOTE),
			WidgetType::WatchlistPrices => Some(WATCHLIST_PRICES_AGENT_NOTE),
			_ => None,
		}
	}
	fn build(&self, draft: &WidgetDraft<'_>) -> Result<GridWidget, String> {
		// Generic fields win over config so it cannot smuggle another type or id.
		let mut assembled = draft.config.clone();
		assembled.insert("widgetId", Value::from(draft.widget_id));
		assembled.insert("title", Value::from(draft.title));
		assembled.insert("size", Value::from(draft.size.as_str()));
		assembled.insert("type", Value::from(self.type_name()));
		let value = Value::Object(assembled);
		// A clean chart draft is reconciled straight into the widget; anything else is
		// validated as given so the strict schema reports its first issue.
		let reconciled = if self.type_name() == "chart" {
			reconcile_chart_draft_core(&value)
		} else {
			None
		};
		let widget = match reconciled {
			Some(widget) => widget,
			None => research_contracts::validate::<WidgetCore>(&value).map_err(|error| {
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
				format!(
					"invalid {} widget: \"{field}\" {message}.",
					self.type_name()
				)
			})?,
		};
		if let WidgetContent::Research { component_id } = &widget.content {
			if !self.known.contains(component_id.as_str()) {
				return Err("invalid research widget: \"componentId\" must name a canvas component of this conversation.".to_owned());
			}
		}
		Ok(GridWidget(Arc::new(widget)))
	}
}

/// The research widgets' component ids: the only ones a `research` command may name.
fn known_component_ids(notebook: &Notebook) -> HashSet<&str> {
	notebook
		.widgets
		.iter()
		.filter_map(|w| match &w.content {
			WidgetContent::Research { component_id } => Some(component_id.as_str()),
			_ => None,
		})
		.collect()
}

fn failure(index: usize, code: &str, message: String) -> NotebookCommandFailure {
	NotebookCommandFailure {
		index,
		code: code.to_owned(),
		message,
	}
}

/// Folds the commands over the notebook through the shared agent host and
/// checks the exact JSON byte capacity; returns the resulting widgets.
fn fold_and_check(
	notebook: &Notebook,
	commands: &[Value],
	known: &HashSet<&str>,
	new_widget_id: &mut dyn FnMut() -> Option<String>,
) -> Result<Vec<WidgetCore>, NotebookCommandFailure> {
	if commands.len() > limits::MAX_COMMANDS_PER_TURN {
		return Err(failure(
			limits::MAX_COMMANDS_PER_TURN,
			"INVALID_COMMAND",
			format!(
				"at most {} commands are applied per turn.",
				limits::MAX_COMMANDS_PER_TURN
			),
		));
	}
	let types: Vec<NotebookType<'_>> = WidgetType::VALUES
		.iter()
		.filter_map(|name| WidgetType::from_str_value(name))
		.map(|widget_type| NotebookType::new(widget_type, known))
		.collect();
	let registered: Vec<&dyn WidgetAgentType<GridWidget>> =
		types.iter().map(|t| t as &dyn WidgetAgentType<_>).collect();
	let store = MemoryLayoutStore {
		widgets: notebook
			.widgets
			.iter()
			.map(|w| GridWidget(Arc::new(core(w))))
			.collect(),
		revision: 0,
	};
	// `host.describe()` is skipped: it only fails when a stored widget's config
	// cannot be read as its own type, which a decoded notebook cannot trigger.
	let mut host = WidgetAgentHost::new(store, &registered, Box::new(new_widget_id)).with_limits(
		WidgetLayoutLimits {
			max_widgets: limits::MAX_WIDGETS,
		},
	);
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
		host.apply_command_unsnapshotted(&parsed)
			.map_err(|e| failure(index, e.code.as_str(), e.message))?;
	}
	let widgets: Vec<WidgetCore> = host
		.into_store()
		.widgets
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
	Ok(widgets)
}

/// Applies commands through the shared parser/layout engine, checks exact JSON byte
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
	apply_with_components(
		notebook,
		commands,
		&known_component_ids(notebook),
		new_widget_id,
	)
}

/// [`apply_notebook_commands`] with an explicit set of canvas component ids
/// (the API passes the conversation's, not only the notebook's).
pub(super) fn apply_with_components(
	notebook: &Notebook,
	commands: &[Value],
	known: &HashSet<&str>,
	new_widget_id: &mut dyn FnMut() -> Option<String>,
) -> Result<Vec<WidgetCore>, NotebookCommandFailure> {
	let widgets = fold_and_check(notebook, commands, known, new_widget_id)?;
	let previous: Vec<_> = notebook.widgets.iter().map(core).collect();
	Ok(with_earned_chart_provenance(widgets, &previous))
}

/// The runner's check-only form of [`apply_notebook_commands`]: the same
/// failures, but it stops after the capacity check. The turn discards the
/// resulting widgets (the API recomputes them), so earning chart provenance
/// there would be pure cost.
///
/// # Errors
/// Returns the first command failure; the original notebook is never mutated.
pub fn check_notebook_commands(
	notebook: &Notebook,
	commands: &[Value],
	new_widget_id: &mut dyn FnMut() -> Option<String>,
) -> Result<(), NotebookCommandFailure> {
	let known = known_component_ids(notebook);
	fold_and_check(notebook, commands, &known, new_widget_id).map(drop)
}
