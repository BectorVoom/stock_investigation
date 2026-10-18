//! Runner projection of the widget host's buildEdit/error translation.
//! Snapshots and change previews are API-only; the parser and Lean-checked
//! layout transitions remain in research-widget-grid. Arc copies preserve
//! the TypeScript's structural sharing across the ordered command fold.

use super::commands::{GridWidget, NotebookType};
use research_js::{json::Object, utf16, whitespace};
use research_widget_grid::{
	agent::{
		host::WidgetDraft,
		types::{WidgetAgentFailure, WidgetAgentFailureCode as Code, WidgetCommand},
	},
	core::{
		layout::{WidgetLayoutEdit, WidgetLayoutError},
		types::{WidgetBase, WidgetSize},
	},
};

fn type_of<'a>(types: &'a [NotebookType<'a>], name: &str) -> Option<&'a NotebookType<'a>> {
	types.iter().find(|t| t.name == name)
}
fn unreadable_widget(widget_id: &str, widget_type: &str) -> WidgetAgentFailure {
	WidgetAgentFailure::new(
		Code::InvalidWidget,
		format!("widget \"{widget_id}\" could not be read as type \"{widget_type}\"."),
	)
}

fn not_found(widget_id: &str) -> WidgetAgentFailure {
	WidgetAgentFailure::new(
		Code::WidgetNotFound,
		format!("no widget with id \"{widget_id}\"."),
	)
}

fn unknown_type_of(widget_id: &str, widget_type: &str) -> WidgetAgentFailure {
	WidgetAgentFailure::new(
		Code::UnknownWidgetType,
		format!("widget \"{widget_id}\" has unknown type \"{widget_type}\"."),
	)
}

fn size_not_allowed(size: WidgetSize, widget_type: &str) -> WidgetAgentFailure {
	WidgetAgentFailure::new(
		Code::SizeNotAllowed,
		format!("size \"{size}\" is not allowed for widget type \"{widget_type}\"."),
	)
}

fn allocate_id(
	new_widget_id: &mut dyn FnMut() -> Option<String>,
) -> Result<String, WidgetAgentFailure> {
	let widget_id = (new_widget_id)().ok_or_else(|| {
		WidgetAgentFailure::new(
			Code::StoreUnavailable,
			"a new widget id could not be allocated.",
		)
	})?;
	if widget_id.is_empty() {
		return Err(WidgetAgentFailure::new(
			Code::InvalidWidget,
			"the new widget id is empty.",
		));
	}
	Ok(widget_id)
}

fn build_widget(
	agent_type: &NotebookType<'_>,
	draft: &WidgetDraft<'_>,
) -> Result<GridWidget, WidgetAgentFailure> {
	agent_type
		.build(draft)
		.map_err(|message| WidgetAgentFailure::new(Code::InvalidWidget, message))
}

pub(super) fn build_edit(
	command: &WidgetCommand,
	widgets: &[GridWidget],
	types: &[NotebookType<'_>],
	new_widget_id: &mut dyn FnMut() -> Option<String>,
) -> Result<WidgetLayoutEdit<GridWidget>, WidgetAgentFailure> {
	let find = |widget_id: &str| {
		widgets
			.iter()
			.position(|widget| widget.widget_id() == widget_id)
	};
	match command {
		WidgetCommand::Add {
			widget_type,
			title,
			size,
			config,
			to_index,
		} => {
			let agent_type = type_of(types, widget_type).ok_or_else(|| {
				WidgetAgentFailure::new(
					Code::UnknownWidgetType,
					format!("unknown widget type \"{widget_type}\"."),
				)
			})?;
			let size = size.unwrap_or_else(|| agent_type.default_size());
			if !agent_type.sizes().contains(&size) {
				return Err(size_not_allowed(size, widget_type));
			}
			let widget_id = allocate_id(new_widget_id)?;
			let empty = Object::new();
			let config = config.as_ref().unwrap_or(&empty);
			let widget = build_widget(
				agent_type,
				&WidgetDraft {
					widget_id: &widget_id,
					title,
					size,
					config,
				},
			)?;
			Ok(WidgetLayoutEdit::Add {
				widget,
				to_index: *to_index,
			})
		}
		WidgetCommand::Remove { widget_id } => Ok(WidgetLayoutEdit::Remove {
			widget_id: widget_id.clone(),
		}),
		WidgetCommand::Move {
			widget_id,
			direction,
		} => Ok(WidgetLayoutEdit::Move {
			widget_id: widget_id.clone(),
			direction: *direction,
		}),
		WidgetCommand::Reorder {
			widget_id,
			to_index,
		} => Ok(WidgetLayoutEdit::Reorder {
			widget_id: widget_id.clone(),
			to_index: *to_index,
		}),
		WidgetCommand::Resize { widget_id, size } => {
			let current = find(widget_id)
				.and_then(|index| widgets.get(index))
				.ok_or_else(|| not_found(widget_id))?;
			let agent_type = type_of(types, current.widget_type())
				.ok_or_else(|| unknown_type_of(widget_id, current.widget_type()))?;
			if !agent_type.sizes().contains(size) {
				return Err(size_not_allowed(*size, current.widget_type()));
			}
			Ok(WidgetLayoutEdit::Resize {
				widget_id: widget_id.clone(),
				size: *size,
			})
		}
		WidgetCommand::Update {
			widget_id,
			title,
			config,
		} => {
			let current = find(widget_id)
				.and_then(|index| widgets.get(index))
				.ok_or_else(|| not_found(widget_id))?;
			let agent_type = type_of(types, current.widget_type())
				.ok_or_else(|| unknown_type_of(widget_id, current.widget_type()))?;
			// `{ ...configOf(current), ...config }`: a shallow merge.
			let mut merged = agent_type
				.config_of(current)
				.map_err(|_| unreadable_widget(current.widget_id(), current.widget_type()))?;
			if let Some(config) = config {
				for (key, value) in config.iter() {
					merged.insert(key, value.clone());
				}
			}
			let widget = build_widget(
				agent_type,
				&WidgetDraft {
					widget_id: current.widget_id(),
					title: title.as_deref().unwrap_or_else(|| current.title()),
					size: current.size(),
					config: &merged,
				},
			)?;
			Ok(WidgetLayoutEdit::Replace { widget })
		}
		WidgetCommand::Duplicate {
			widget_id,
			title,
			to_index,
		} => {
			let index = find(widget_id).ok_or_else(|| not_found(widget_id))?;
			let current = widgets.get(index).ok_or_else(|| not_found(widget_id))?;
			let agent_type = type_of(types, current.widget_type())
				.ok_or_else(|| unknown_type_of(widget_id, current.widget_type()))?;
			if !agent_type.sizes().contains(&current.size()) {
				return Err(size_not_allowed(current.size(), current.widget_type()));
			}
			// The default copy title can exceed the 200-character title
			// limit when the original is already long; trim it the same
			// way the command schema trims titles.
			let default_title;
			let raw_title = match title {
				Some(title) => title.as_str(),
				None => {
					default_title = format!("{} (copy)", current.title());
					default_title.as_str()
				}
			};
			let copy_title = utf16::truncate(whitespace::trim(raw_title), 200).into_owned();
			if copy_title.is_empty() {
				return Err(WidgetAgentFailure::new(
					Code::InvalidWidget,
					"the duplicate title is empty.",
				));
			}
			let config = agent_type
				.config_of(current)
				.map_err(|_| unreadable_widget(current.widget_id(), current.widget_type()))?;
			let new_id = allocate_id(new_widget_id)?;
			let widget = build_widget(
				agent_type,
				&WidgetDraft {
					widget_id: &new_id,
					title: &copy_title,
					size: current.size(),
					config: &config,
				},
			)?;
			// A duplicate is an `add` of a copy right after the original —
			// no new layout edit kind, so the proved Lean dashboard model
			// still covers it.
			Ok(WidgetLayoutEdit::Add {
				widget,
				to_index: Some(to_index.unwrap_or(index + 1)),
			})
		}
	}
}

pub(super) fn layout_failure(
	error: WidgetLayoutError,
	command: &WidgetCommand,
	count: usize,
) -> WidgetAgentFailure {
	let code = match error {
		WidgetLayoutError::DuplicateWidgetId => Code::DuplicateWidgetId,
		WidgetLayoutError::WidgetNotFound => Code::WidgetNotFound,
		WidgetLayoutError::MoveAtEnd => Code::MoveAtEnd,
		WidgetLayoutError::PositionOutOfRange => Code::PositionOutOfRange,
		WidgetLayoutError::TooManyWidgets => Code::TooManyWidgets,
		WidgetLayoutError::InvalidWidget => Code::InvalidWidget,
	};
	let message = match error {
		WidgetLayoutError::DuplicateWidgetId => "a widget with that id already exists.".to_owned(),
		WidgetLayoutError::WidgetNotFound => {
			let id = match command {
				WidgetCommand::Add { widget_type, .. } => widget_type,
				WidgetCommand::Remove { widget_id }
				| WidgetCommand::Move { widget_id, .. }
				| WidgetCommand::Reorder { widget_id, .. }
				| WidgetCommand::Resize { widget_id, .. }
				| WidgetCommand::Update { widget_id, .. }
				| WidgetCommand::Duplicate { widget_id, .. } => widget_id,
			};
			format!("no widget with id \"{id}\".")
		}
		WidgetLayoutError::MoveAtEnd => match command {
			WidgetCommand::Move {
				widget_id,
				direction,
			} => {
				format!(
					"widget \"{widget_id}\" cannot move \"{}\" from here.",
					direction.as_str()
				)
			}
			_ => "the widget is already at that end.".to_owned(),
		},
		WidgetLayoutError::PositionOutOfRange => {
			let to_index = match command {
				WidgetCommand::Add { to_index, .. } | WidgetCommand::Duplicate { to_index, .. } => {
					to_index.unwrap_or(count)
				}
				WidgetCommand::Reorder { to_index, .. } => *to_index,
				_ => count,
			};
			format!("position {to_index} is out of range for {count} widgets.")
		}
		WidgetLayoutError::TooManyWidgets => {
			format!("the grid already holds the maximum of {} widgets.", 200)
		}
		WidgetLayoutError::InvalidWidget => "the widget is invalid.".to_owned(),
	};
	WidgetAgentFailure::new(code, message)
}
