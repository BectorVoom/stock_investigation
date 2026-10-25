//! Port of `agent/host.ts`: `describe` returns the snapshot an agent decides
//! from, `apply` validates and applies one untrusted command, all or nothing.
//! A command is applied only when it parses, names a registered type, builds
//! a widget the host accepts, yields a layout the host accepts, and the
//! store accepts the write at the revision that was read; anything else is a
//! typed failure and the stored layout is untouched.
//!
//! The TypeScript also turns a *throwing* `build` into a failure; a Rust
//! `build` returns its rejection, so that branch has no counterpart.

use research_js::json::{Object, Value};
use research_js::{utf16, whitespace};

use super::commands::parse_widget_command;
use super::types::{
	WIDGET_AGENT_PROTOCOL_VERSION, WidgetAgentFailure, WidgetAgentFailureCode as Code,
	WidgetCommand,
};
use crate::core::layout::{
	DEFAULT_WIDGET_LAYOUT_LIMITS, WidgetLayoutEdit, WidgetLayoutError, WidgetLayoutLimits,
	apply_widget_layout_edit,
};
use crate::core::sizes::{WIDGET_GRID_METRICS, WIDGET_SIZES, widget_size_shape, widget_size_span};
use crate::core::types::{WidgetBase, WidgetSize};

/// The generic fields plus `config`, handed to [`WidgetAgentType::build`].
#[derive(Clone, Copy, Debug)]
pub struct WidgetDraft<'a> {
	/// The id the widget gets.
	pub widget_id: &'a str,
	/// Its title.
	pub title: &'a str,
	/// Its size.
	pub size: WidgetSize,
	/// The type-specific configuration.
	pub config: &'a Object,
}

/// A widget's configuration could not be read (`configOf` threw).
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the widget's configuration could not be read")]
pub struct ConfigUnreadable;

/// One widget type as the agent layer sees it (`WidgetAgentType`).
pub trait WidgetAgentType<W> {
	/// The registry key.
	fn type_name(&self) -> &str;
	/// Short label.
	fn label(&self) -> &str;
	/// What the type shows.
	fn description(&self) -> &str;
	/// Size of a new widget.
	fn default_size(&self) -> WidgetSize;
	/// Sizes this type may take (non-empty).
	fn sizes(&self) -> &[WidgetSize];
	/// JSON Schema of `config`, shown to agents verbatim.
	fn config_schema(&self) -> &Value;
	/// Builds a validated widget; the error text is shown to the agent.
	///
	/// # Errors
	///
	/// A sentence saying what to change.
	fn build(&self, draft: &WidgetDraft<'_>) -> Result<W, String>;
	/// The type-specific part of a widget as JSON (the inverse of `build`).
	///
	/// # Errors
	///
	/// [`ConfigUnreadable`] when the stored widget cannot be read as this type.
	fn config_of(&self, widget: &W) -> Result<Object, ConfigUnreadable>;
	/// `ownerPlaced.reason`: set when only the owner places widgets of this
	/// type. Agents then cannot `add` or `duplicate` one, nor `update` its
	/// config; moving, resizing, renaming and removing stay open.
	fn owner_placed(&self) -> Option<&str> {
		None
	}
}

/// A stored layout plus the revision a write must present.
#[derive(Clone, Debug, PartialEq)]
pub struct WidgetLayoutRecord<W, R> {
	/// The widgets in reading order.
	pub widgets: Vec<W>,
	/// The compare-and-set revision.
	pub revision: R,
}

/// Why a store call failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreError {
	/// The store answered with a failure (e.g. `CONFLICT`); passed through.
	Rejected(WidgetAgentFailure),
	/// The store itself failed (the TypeScript store threw).
	Unavailable,
}

/// Where the widgets live. `write` must reject with `CONFLICT` when
/// `revision` is no longer current.
pub trait WidgetLayoutStore<W> {
	/// The revision type.
	type Revision: Clone;
	/// Reads the layout.
	///
	/// # Errors
	///
	/// [`StoreError`].
	fn read(&mut self) -> Result<WidgetLayoutRecord<W, Self::Revision>, StoreError>;
	/// Writes `widgets` if `revision` is current.
	///
	/// # Errors
	///
	/// [`StoreError`] (a stale revision is `Rejected(CONFLICT)`).
	fn write(
		&mut self,
		widgets: Vec<W>,
		revision: Self::Revision,
	) -> Result<WidgetLayoutRecord<W, Self::Revision>, StoreError>;
}

/// An in-memory store with compare-and-set revisions (the runner's).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MemoryLayoutStore<W> {
	/// The current widgets.
	pub widgets: Vec<W>,
	/// The current revision.
	pub revision: u64,
}

impl<W: Clone> WidgetLayoutStore<W> for MemoryLayoutStore<W> {
	type Revision = u64;

	fn read(&mut self) -> Result<WidgetLayoutRecord<W, u64>, StoreError> {
		Ok(WidgetLayoutRecord {
			widgets: self.widgets.clone(),
			revision: self.revision,
		})
	}

	fn write(
		&mut self,
		widgets: Vec<W>,
		revision: u64,
	) -> Result<WidgetLayoutRecord<W, u64>, StoreError> {
		if revision != self.revision {
			return Err(StoreError::Rejected(WidgetAgentFailure::new(
				Code::Conflict,
				"the layout changed elsewhere; describe again and retry.",
			)));
		}
		self.revision += 1;
		self.widgets = widgets;
		Ok(WidgetLayoutRecord {
			widgets: self.widgets.clone(),
			revision: self.revision,
		})
	}
}

/// One widget in a snapshot.
#[derive(Clone, Debug, PartialEq)]
pub struct WidgetSnapshotWidget {
	/// Its id.
	pub widget_id: String,
	/// Its type.
	pub widget_type: String,
	/// Its title.
	pub title: String,
	/// Its size.
	pub size: WidgetSize,
	/// 0-based position in reading order.
	pub position: usize,
	/// Its configuration (empty for an unregistered type).
	pub config: Object,
}

/// Everything an agent needs to decide its next command.
#[derive(Clone, Debug, PartialEq)]
pub struct WidgetSnapshot {
	/// The grid's widget limit.
	pub max_widgets: usize,
	/// The widgets in reading order.
	pub widgets: Vec<WidgetSnapshotWidget>,
	/// The registered types: name, label, description, default size, sizes, schema.
	pub widget_types: Vec<(String, String, String, WidgetSize, Vec<WidgetSize>, Value)>,
}

fn number(value: usize) -> Value {
	// Grid numbers are small counts: exact as doubles.
	Value::Number(f64::from(u32::try_from(value).unwrap_or(u32::MAX)))
}

fn object(members: Vec<(&str, Value)>) -> Value {
	Value::Object(Object::from_members(
		members
			.into_iter()
			.map(|(key, value)| (key.to_owned(), value))
			.collect(),
	))
}

fn sizes_value(sizes: &[WidgetSize]) -> Value {
	Value::Array(
		sizes
			.iter()
			.map(|size| Value::from(size.as_str()))
			.collect(),
	)
}

impl WidgetSnapshot {
	/// The snapshot as the TypeScript's plain JSON (same key order).
	#[must_use]
	pub fn to_value(&self) -> Value {
		let span = |columns: u32, rows: u32| {
			object(vec![
				("columns", Value::Number(f64::from(columns))),
				("rows", Value::Number(f64::from(rows))),
			])
		};
		let sizes = WIDGET_SIZES
			.iter()
			.map(|size| {
				let spans = widget_size_span(*size);
				object(vec![
					("size", Value::from(size.as_str())),
					("shape", Value::from(widget_size_shape(*size))),
					("narrow", span(spans.narrow.columns, spans.narrow.rows)),
					("wide", span(spans.wide.columns, spans.wide.rows)),
				])
			})
			.collect();
		object(vec![
			(
				"protocolVersion",
				Value::Number(f64::from(WIDGET_AGENT_PROTOCOL_VERSION)),
			),
			(
				"grid",
				object(vec![
					(
						"narrowColumns",
						Value::Number(f64::from(WIDGET_GRID_METRICS.narrow_columns)),
					),
					(
						"wideColumns",
						Value::Number(f64::from(WIDGET_GRID_METRICS.wide_columns)),
					),
					("maxWidgets", number(self.max_widgets)),
					("sizes", Value::Array(sizes)),
				]),
			),
			(
				"widgetTypes",
				Value::Array(
					self.widget_types
						.iter()
						.map(|(name, label, description, default_size, sizes, schema)| {
							object(vec![
								("type", Value::from(name.as_str())),
								("label", Value::from(label.as_str())),
								("description", Value::from(description.as_str())),
								("defaultSize", Value::from(default_size.as_str())),
								("sizes", sizes_value(sizes)),
								("configSchema", schema.clone()),
							])
						})
						.collect(),
				),
			),
			(
				"widgets",
				Value::Array(
					self.widgets
						.iter()
						.map(|widget| {
							object(vec![
								("widgetId", Value::from(widget.widget_id.as_str())),
								("type", Value::from(widget.widget_type.as_str())),
								("title", Value::from(widget.title.as_str())),
								("size", Value::from(widget.size.as_str())),
								("position", number(widget.position)),
								("config", Value::Object(widget.config.clone())),
							])
						})
						.collect(),
				),
			),
		])
	}
}

/// Whole-layout rules beyond the per-widget checks; a rejection names why.
pub type LayoutValidator<'a, W> = Box<dyn Fn(&[W]) -> Result<(), String> + 'a>;

/// Allocates a fresh widget id; `None` = allocation failed.
pub type WidgetIdAllocator<'a> = Box<dyn FnMut() -> Option<String> + 'a>;

/// `createWidgetAgentHost`.
pub struct WidgetAgentHost<'a, W, S> {
	store: S,
	types: &'a [&'a dyn WidgetAgentType<W>],
	new_widget_id: WidgetIdAllocator<'a>,
	limits: WidgetLayoutLimits,
	validate_layout: Option<LayoutValidator<'a, W>>,
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

fn owner_placed_widget(widget_type: &str, reason: &str) -> WidgetAgentFailure {
	WidgetAgentFailure::new(
		Code::InvalidWidget,
		format!("agents cannot add \"{widget_type}\" widgets: {reason}"),
	)
}

/// `sameJson`: structural equality with object keys in any order (the
/// TypeScript compares parsed JSON, where key order carries no meaning).
fn same_json(left: &Value, right: &Value) -> bool {
	match (left, right) {
		(Value::Array(x), Value::Array(y)) => {
			x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same_json(a, b))
		}
		(Value::Object(x), Value::Object(y)) => {
			x.len() == y.len()
				&& x.iter()
					.all(|(key, value)| y.get(key).is_some_and(|other| same_json(value, other)))
		}
		_ => left == right,
	}
}

fn size_not_allowed(size: WidgetSize, widget_type: &str) -> WidgetAgentFailure {
	WidgetAgentFailure::new(
		Code::SizeNotAllowed,
		format!("size \"{size}\" is not allowed for widget type \"{widget_type}\"."),
	)
}

impl<'a, W: WidgetBase, S: WidgetLayoutStore<W>> WidgetAgentHost<'a, W, S> {
	/// A host over `store` with the registered `types`.
	pub fn new(
		store: S,
		types: &'a [&'a dyn WidgetAgentType<W>],
		new_widget_id: WidgetIdAllocator<'a>,
	) -> Self {
		Self {
			store,
			types,
			new_widget_id,
			limits: DEFAULT_WIDGET_LAYOUT_LIMITS,
			validate_layout: None,
		}
	}

	/// With a widget limit other than the default 24.
	#[must_use]
	pub const fn with_limits(mut self, limits: WidgetLayoutLimits) -> Self {
		self.limits = limits;
		self
	}

	/// With whole-layout rules.
	#[must_use]
	pub fn with_layout_validator(mut self, validate: LayoutValidator<'a, W>) -> Self {
		self.validate_layout = Some(validate);
		self
	}

	/// The store (to read the final layout back).
	pub const fn store(&self) -> &S {
		&self.store
	}

	/// Consumes the host, returning the store.
	pub fn into_store(self) -> S {
		self.store
	}

	fn type_of(&self, widget_type: &str) -> Option<&'a dyn WidgetAgentType<W>> {
		self.types
			.iter()
			.copied()
			.find(|entry| entry.type_name() == widget_type)
	}

	fn snapshot_of(&self, widgets: &[W]) -> Result<WidgetSnapshot, WidgetAgentFailure> {
		let mut snapshot_widgets = Vec::with_capacity(widgets.len());
		for (position, widget) in widgets.iter().enumerate() {
			// A widget whose stored type is not registered is still listed,
			// with an empty config; it can be moved, reordered and removed.
			let config = match self.type_of(widget.widget_type()) {
				Some(agent_type) => agent_type
					.config_of(widget)
					.map_err(|_| unreadable_widget(widget.widget_id(), widget.widget_type()))?,
				None => Object::new(),
			};
			snapshot_widgets.push(WidgetSnapshotWidget {
				widget_id: widget.widget_id().to_owned(),
				widget_type: widget.widget_type().to_owned(),
				title: widget.title().to_owned(),
				size: widget.size(),
				position,
				config,
			});
		}
		Ok(WidgetSnapshot {
			max_widgets: self.limits.max_widgets,
			widgets: snapshot_widgets,
			widget_types: self
				.types
				.iter()
				.map(|entry| {
					(
						entry.type_name().to_owned(),
						entry.label().to_owned(),
						entry.description().to_owned(),
						entry.default_size(),
						entry.sizes().to_vec(),
						entry.config_schema().clone(),
					)
				})
				.collect(),
		})
	}

	fn allocate_id(&mut self) -> Result<String, WidgetAgentFailure> {
		let widget_id = (self.new_widget_id)().ok_or_else(|| {
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

	fn build(
		agent_type: &dyn WidgetAgentType<W>,
		draft: &WidgetDraft<'_>,
	) -> Result<W, WidgetAgentFailure> {
		agent_type
			.build(draft)
			.map_err(|message| WidgetAgentFailure::new(Code::InvalidWidget, message))
	}

	#[allow(clippy::too_many_lines)]
	fn build_edit(
		&mut self,
		command: &WidgetCommand,
		widgets: &[W],
	) -> Result<WidgetLayoutEdit<W>, WidgetAgentFailure> {
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
				let agent_type = self.type_of(widget_type).ok_or_else(|| {
					WidgetAgentFailure::new(
						Code::UnknownWidgetType,
						format!("unknown widget type \"{widget_type}\"."),
					)
				})?;
				if let Some(reason) = agent_type.owner_placed() {
					return Err(owner_placed_widget(agent_type.type_name(), reason));
				}
				let size = size.unwrap_or_else(|| agent_type.default_size());
				if !agent_type.sizes().contains(&size) {
					return Err(size_not_allowed(size, widget_type));
				}
				let widget_id = self.allocate_id()?;
				let empty = Object::new();
				let config = config.as_ref().unwrap_or(&empty);
				let widget = Self::build(
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
				let agent_type = self
					.type_of(current.widget_type())
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
				let agent_type = self
					.type_of(current.widget_type())
					.ok_or_else(|| unknown_type_of(widget_id, current.widget_type()))?;
				// `{ ...configOf(current), ...config }`: a shallow merge.
				let mut merged = agent_type
					.config_of(current)
					.map_err(|_| unreadable_widget(current.widget_id(), current.widget_type()))?;
				if let (Some(reason), Some(config)) = (agent_type.owner_placed(), config)
					&& config.iter().any(|(key, value)| {
						merged
							.get(key)
							.is_none_or(|current| !same_json(value, current))
					}) {
					return Err(WidgetAgentFailure::new(
						Code::InvalidWidget,
						format!(
							"agents cannot change the config of \"{}\" widgets: {reason}",
							current.widget_type()
						),
					));
				}
				if let Some(config) = config {
					for (key, value) in config.iter() {
						merged.insert(key, value.clone());
					}
				}
				let widget = Self::build(
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
				let agent_type = self
					.type_of(current.widget_type())
					.ok_or_else(|| unknown_type_of(widget_id, current.widget_type()))?;
				// A copy is a new widget of the type, so the add rule holds.
				if let Some(reason) = agent_type.owner_placed() {
					return Err(owner_placed_widget(agent_type.type_name(), reason));
				}
				if !agent_type.sizes().contains(&current.size()) {
					return Err(size_not_allowed(current.size(), current.widget_type()));
				}
				// The default copy title can exceed the 200-character title
				// limit when the original is already long; trim it the same
				// way the command schema trims titles.
				// ADR-0030 divergence: JavaScript `slice(0, 200)` can leave a lone surrogate
				// when the cut falls inside an emoji; a Rust string cannot hold one, so
				// `utf16::truncate` ends the title with U+FFFD instead. Only a title cut exactly
				// there differs, and only in the byte count the capacity check measures.
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
				let new_id = self.allocate_id()?;
				let widget = Self::build(
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

	fn layout_failure(
		&self,
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
			WidgetLayoutError::DuplicateWidgetId => {
				"a widget with that id already exists.".to_owned()
			}
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
					WidgetCommand::Add { to_index, .. }
					| WidgetCommand::Duplicate { to_index, .. } => to_index.unwrap_or(count),
					WidgetCommand::Reorder { to_index, .. } => *to_index,
					_ => count,
				};
				format!("position {to_index} is out of range for {count} widgets.")
			}
			WidgetLayoutError::TooManyWidgets => {
				format!(
					"the grid already holds the maximum of {} widgets.",
					self.limits.max_widgets
				)
			}
			WidgetLayoutError::InvalidWidget => "the widget is invalid.".to_owned(),
		};
		WidgetAgentFailure::new(code, message)
	}

	fn read_failure(error: StoreError) -> WidgetAgentFailure {
		match error {
			StoreError::Rejected(failure) => failure,
			StoreError::Unavailable => WidgetAgentFailure::new(
				Code::StoreUnavailable,
				"the widget store could not be read.",
			),
		}
	}

	/// `describe`: the snapshot of the stored layout.
	///
	/// # Errors
	///
	/// A store failure, or `INVALID_WIDGET` for an unreadable widget.
	pub fn describe(&mut self) -> Result<WidgetSnapshot, WidgetAgentFailure> {
		let record = self.store.read().map_err(Self::read_failure)?;
		self.snapshot_of(&record.widgets)
	}

	/// `apply`: validates and applies one untrusted command, all or nothing.
	///
	/// # Errors
	///
	/// The first failing step's typed failure; the store is then untouched.
	pub fn apply(&mut self, command: &Value) -> Result<WidgetSnapshot, WidgetAgentFailure> {
		let parsed = parse_widget_command(command)?;
		self.apply_command(&parsed)
	}

	/// [`Self::apply`] for an already parsed command.
	///
	/// # Errors
	///
	/// As [`Self::apply`].
	pub fn apply_command(
		&mut self,
		command: &WidgetCommand,
	) -> Result<WidgetSnapshot, WidgetAgentFailure> {
		let written = self.apply_command_unsnapshotted(command)?;
		self.snapshot_of(&written)
	}

	/// [`Self::apply_command`] without building the snapshot: callers that
	/// only need the stored layout (read it back with [`Self::store`]) skip
	/// serialising every widget's configuration after each command.
	///
	/// # Errors
	///
	/// As [`Self::apply`].
	pub fn apply_command_unsnapshotted(
		&mut self,
		command: &WidgetCommand,
	) -> Result<Vec<W>, WidgetAgentFailure> {
		let record = self.store.read().map_err(Self::read_failure)?;
		let edit = self.build_edit(command, &record.widgets)?;
		let applied = apply_widget_layout_edit(&record.widgets, &edit, self.limits)
			.map_err(|error| self.layout_failure(error, command, record.widgets.len()))?;
		if let Some(validate) = &self.validate_layout {
			validate(&applied)
				.map_err(|message| WidgetAgentFailure::new(Code::InvalidWidget, message))?;
		}
		let written = self
			.store
			.write(applied, record.revision)
			.map_err(|error| match error {
				StoreError::Rejected(failure) => failure,
				StoreError::Unavailable => WidgetAgentFailure::new(
					Code::StoreUnavailable,
					"the widget store could not be written.",
				),
			})?;
		Ok(written.widgets)
	}
}
