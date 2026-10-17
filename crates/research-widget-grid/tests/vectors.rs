//! Replays `vectors/widget-grid/*.json` (written by Node from the real
//! TypeScript: `node scripts/vectors/index.ts widget-grid`) and the Lean
//! dashboard family of `formal/vectors.json` against the layout edits.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use research_js::json::{self, Object, Value};
use research_widget_grid::agent::commands::parse_widget_command;
use research_widget_grid::agent::host::{
	ConfigUnreadable, MemoryLayoutStore, WidgetAgentHost, WidgetAgentType, WidgetDraft,
};
use research_widget_grid::agent::types::WidgetCommand;
use research_widget_grid::core::layout::{
	DEFAULT_WIDGET_LAYOUT_LIMITS, MoveDirection, WidgetLayoutEdit, WidgetLayoutLimits,
	apply_widget_layout_edit,
};
use research_widget_grid::core::types::{WidgetBase, WidgetSize};
use serde_json::Value as Wire;

fn load(path: &str) -> Wire {
	let path = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
	serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

#[derive(Clone, Debug, PartialEq)]
struct Toy {
	widget_id: String,
	widget_type: String,
	title: String,
	size: WidgetSize,
	text: String,
}

impl WidgetBase for Toy {
	fn widget_id(&self) -> &str {
		&self.widget_id
	}
	fn widget_type(&self) -> &str {
		&self.widget_type
	}
	fn title(&self) -> &str {
		&self.title
	}
	fn size(&self) -> WidgetSize {
		self.size
	}
	fn with_size(&self, size: WidgetSize) -> Self {
		Self {
			size,
			..self.clone()
		}
	}
}

fn toy(widget_id: &str, size: WidgetSize) -> Toy {
	Toy {
		widget_id: widget_id.to_owned(),
		widget_type: "note".to_owned(),
		title: format!("Title {widget_id}"),
		size,
		text: format!("Text {widget_id}"),
	}
}

fn size(value: &Wire) -> WidgetSize {
	WidgetSize::parse(value.as_str().unwrap()).unwrap()
}

fn index(value: &Wire) -> usize {
	usize::try_from(value.as_u64().unwrap()).unwrap()
}

#[test]
fn lean_dashboard_vectors_hold_for_the_layout_edits() {
	let vectors = load("formal/vectors.json");
	let cases = vectors["dashboard"].as_array().unwrap();
	assert_eq!(cases.len(), 612);
	let id = |value: &Wire| format!("w{}", value.as_u64().unwrap());
	for case in cases {
		let widgets: Vec<Toy> = case["dashboard"]
			.as_array()
			.unwrap()
			.iter()
			.map(|item| toy(&id(item), WidgetSize::Small))
			.collect();
		let edit = &case["edit"];
		let widget_id = id(&edit["id"]);
		let edit = match edit["kind"].as_str().unwrap() {
			"add" => WidgetLayoutEdit::Add {
				widget: toy(&widget_id, WidgetSize::Small),
				to_index: None,
			},
			"remove" => WidgetLayoutEdit::Remove { widget_id },
			"moveEarlier" => WidgetLayoutEdit::Move {
				widget_id,
				direction: MoveDirection::Earlier,
			},
			"moveLater" => WidgetLayoutEdit::Move {
				widget_id,
				direction: MoveDirection::Later,
			},
			"reorder" => WidgetLayoutEdit::Reorder {
				widget_id,
				to_index: index(&edit["toIndex"]),
			},
			other => panic!("unknown dashboard edit {other}"),
		};
		let result = apply_widget_layout_edit(&widgets, &edit, DEFAULT_WIDGET_LAYOUT_LIMITS);
		assert_eq!(
			result.is_ok(),
			case["accepted"].as_bool().unwrap(),
			"{case}"
		);
		let ids: Vec<String> = result
			.as_ref()
			.unwrap_or(&widgets)
			.iter()
			.map(|widget| widget.widget_id.clone())
			.collect();
		let expected: Vec<String> = case["ids"].as_array().unwrap().iter().map(id).collect();
		assert_eq!(ids, expected, "{case}");
	}
}

#[test]
fn layout_edits_match_typescript() {
	let cases = load("vectors/widget-grid/layout.json");
	for case in cases.as_array().unwrap() {
		let widgets: Vec<Toy> = case["widgets"]
			.as_array()
			.unwrap()
			.iter()
			.map(|pair| toy(pair[0].as_str().unwrap(), size(&pair[1])))
			.collect();
		let wire = &case["edit"];
		let widget_id = wire["widgetId"].as_str().unwrap().to_owned();
		let edit = match wire["kind"].as_str().unwrap() {
			"add" => WidgetLayoutEdit::Add {
				widget: toy(&widget_id, size(&wire["size"])),
				to_index: wire["toIndex"]
					.as_u64()
					.map(|to| usize::try_from(to).unwrap()),
			},
			"remove" => WidgetLayoutEdit::Remove { widget_id },
			"move" => WidgetLayoutEdit::Move {
				widget_id,
				direction: if wire["direction"] == "earlier" {
					MoveDirection::Earlier
				} else {
					MoveDirection::Later
				},
			},
			"reorder" => WidgetLayoutEdit::Reorder {
				widget_id,
				to_index: index(&wire["toIndex"]),
			},
			"resize" => WidgetLayoutEdit::Resize {
				widget_id,
				size: size(&wire["size"]),
			},
			_ => WidgetLayoutEdit::Replace {
				widget: Toy {
					text: "replaced".to_owned(),
					..toy(&widget_id, size(&wire["size"]))
				},
			},
		};
		let limits = WidgetLayoutLimits {
			max_widgets: index(&case["maxWidgets"]),
		};
		match apply_widget_layout_edit(&widgets, &edit, limits) {
			Ok(next) => {
				let actual: Vec<Wire> = next
					.iter()
					.map(|widget| {
						serde_json::json!([widget.widget_id, widget.size.as_str(), widget.text])
					})
					.collect();
				assert_eq!(Wire::Array(actual), case["output"], "{case}");
			}
			Err(error) => assert_eq!(error.as_str(), case["error"].as_str().unwrap(), "{case}"),
		}
	}
}

/// The parsed command as zod outputs it (shape order, absent options omitted).
fn command_value(command: &WidgetCommand) -> Value {
	let mut members: Vec<(String, Value)> = Vec::new();
	let mut push = |key: &str, value: Value| members.push((key.to_owned(), value));
	let number = |value: usize| Value::Number(f64::from(u32::try_from(value).unwrap()));
	match command {
		WidgetCommand::Add {
			widget_type,
			title,
			size,
			config,
			to_index,
		} => {
			push("kind", "add".into());
			push("type", widget_type.as_str().into());
			push("title", title.as_str().into());
			if let Some(size) = size {
				push("size", size.as_str().into());
			}
			if let Some(config) = config {
				push("config", Value::Object(config.clone()));
			}
			if let Some(to_index) = to_index {
				push("toIndex", number(*to_index));
			}
		}
		WidgetCommand::Remove { widget_id } => {
			push("kind", "remove".into());
			push("widgetId", widget_id.as_str().into());
		}
		WidgetCommand::Move {
			widget_id,
			direction,
		} => {
			push("kind", "move".into());
			push("widgetId", widget_id.as_str().into());
			push("direction", direction.as_str().into());
		}
		WidgetCommand::Reorder {
			widget_id,
			to_index,
		} => {
			push("kind", "reorder".into());
			push("widgetId", widget_id.as_str().into());
			push("toIndex", number(*to_index));
		}
		WidgetCommand::Resize { widget_id, size } => {
			push("kind", "resize".into());
			push("widgetId", widget_id.as_str().into());
			push("size", size.as_str().into());
		}
		WidgetCommand::Update {
			widget_id,
			title,
			config,
		} => {
			push("kind", "update".into());
			push("widgetId", widget_id.as_str().into());
			if let Some(title) = title {
				push("title", title.as_str().into());
			}
			if let Some(config) = config {
				push("config", Value::Object(config.clone()));
			}
		}
		WidgetCommand::Duplicate {
			widget_id,
			title,
			to_index,
		} => {
			push("kind", "duplicate".into());
			push("widgetId", widget_id.as_str().into());
			if let Some(title) = title {
				push("title", title.as_str().into());
			}
			if let Some(to_index) = to_index {
				push("toIndex", number(*to_index));
			}
		}
	}
	Value::Object(Object::from_members(members))
}

#[test]
fn command_parsing_matches_zod() {
	let cases = load("vectors/widget-grid/commands.json");
	let cases = cases.as_array().unwrap();
	assert!(cases.len() > 1000);
	for case in cases {
		let input = json::parse(case["input"].as_str().unwrap()).unwrap();
		match parse_widget_command(&input) {
			Ok(command) => {
				assert_eq!(
					Some(json::stringify(&command_value(&command)).as_str()),
					case["ok"].as_str(),
					"{case}"
				);
			}
			Err(failure) => {
				assert_eq!(failure.code.as_str(), case["error"]["code"], "{case}");
				assert_eq!(
					failure.message,
					case["error"]["message"].as_str().unwrap(),
					"{case}"
				);
			}
		}
	}
}

struct ToyType {
	name: &'static str,
	default_size: WidgetSize,
	sizes: &'static [WidgetSize],
	schema: Value,
}

impl ToyType {
	fn new(name: &'static str, default_size: WidgetSize, sizes: &'static [WidgetSize]) -> Self {
		let schema = json::parse(
			r#"{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}"#,
		)
		.unwrap();
		Self {
			name,
			default_size,
			sizes,
			schema,
		}
	}
}

impl WidgetAgentType<Toy> for ToyType {
	fn type_name(&self) -> &str {
		self.name
	}
	fn label(&self) -> &str {
		self.name
	}
	fn description(&self) -> &str {
		if self.name == "note" {
			"A note."
		} else {
			"A banner."
		}
	}
	fn default_size(&self) -> WidgetSize {
		self.default_size
	}
	fn sizes(&self) -> &[WidgetSize] {
		self.sizes
	}
	fn config_schema(&self) -> &Value {
		&self.schema
	}
	fn build(&self, draft: &WidgetDraft<'_>) -> Result<Toy, String> {
		match draft.config.get("text").and_then(Value::as_str) {
			Some(text) if !research_js::whitespace::trim(text).is_empty() => Ok(Toy {
				widget_id: draft.widget_id.to_owned(),
				widget_type: self.name.to_owned(),
				title: draft.title.to_owned(),
				size: draft.size,
				text: text.to_owned(),
			}),
			_ => Err("config needs a non-empty \"text\" string.".to_owned()),
		}
	}
	fn config_of(&self, widget: &Toy) -> Result<Object, ConfigUnreadable> {
		Ok(Object::from_members(vec![(
			"text".to_owned(),
			widget.text.as_str().into(),
		)]))
	}
}

#[test]
fn host_sequences_match_typescript() {
	let note = ToyType::new(
		"note",
		WidgetSize::Small,
		&[WidgetSize::Small, WidgetSize::Medium],
	);
	let banner = ToyType::new("banner", WidgetSize::Large, &[WidgetSize::Large]);
	let types: [&dyn WidgetAgentType<Toy>; 2] = [&note, &banner];
	let cases = load("vectors/widget-grid/host.json");
	for case in cases.as_array().unwrap() {
		let initial: Vec<Toy> = case["initial"]
			.as_array()
			.unwrap()
			.iter()
			.map(|widget| Toy {
				widget_id: widget["widgetId"].as_str().unwrap().to_owned(),
				widget_type: widget["type"].as_str().unwrap().to_owned(),
				title: widget["title"].as_str().unwrap().to_owned(),
				size: size(&widget["size"]),
				text: widget["text"].as_str().unwrap().to_owned(),
			})
			.collect();
		let mut next_id = 0;
		let mut host = WidgetAgentHost::new(
			MemoryLayoutStore {
				widgets: initial,
				revision: 0,
			},
			&types,
			Box::new(move || {
				next_id += 1;
				Some(format!("new-{next_id}"))
			}),
		)
		.with_limits(WidgetLayoutLimits {
			max_widgets: index(&case["maxWidgets"]),
		});
		let results = case["results"].as_array().unwrap();
		let commands = case["commands"].as_array().unwrap();
		for (command, expected) in commands.iter().zip(results) {
			let input = json::parse(command.as_str().unwrap()).unwrap();
			match host.apply(&input) {
				Ok(snapshot) => {
					let widgets = snapshot.to_value();
					let widgets = widgets.as_object().unwrap().get("widgets").unwrap();
					assert_eq!(
						Some(json::stringify(widgets).as_str()),
						expected["widgets"].as_str(),
						"{command} {case}"
					);
				}
				Err(failure) => {
					assert_eq!(
						failure.code.as_str(),
						expected["error"]["code"],
						"{command}"
					);
					assert_eq!(
						failure.message,
						expected["error"]["message"].as_str().unwrap(),
						"{command}"
					);
				}
			}
		}
		let described = host.describe().unwrap();
		let last = results.last().unwrap();
		assert_eq!(
			Some(json::stringify(&described.to_value()).as_str()),
			last["snapshot"].as_str(),
			"{case}"
		);
	}
}
