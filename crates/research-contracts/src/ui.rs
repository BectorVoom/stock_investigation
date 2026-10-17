//! UI operations (`packages/contracts/src/ui.ts`, section 7): what a run may
//! ask the workspace canvas to do; the server stamps the envelope.

use research_js::json::Value;
use serde::Serialize;

use crate::json::JsonObject;
use crate::patterns;
use crate::primitives::id;
use crate::zod::{
	ArrCheck, Cx, NumCheck, StrCheck, array, decode_object, js_enum, nullable, number_literals,
	run_discriminated, string, uint,
};

/// `UI_PROTOCOL_VERSION`.
pub const UI_PROTOCOL_VERSION: u64 = 1;

const COMPONENT_ID: &[StrCheck] = &[StrCheck::Regex(
	&patterns::COMPONENT_ID,
	Some("invalid component id"),
)];
const COMPONENT_TYPE: &[StrCheck] = &[StrCheck::Regex(
	&patterns::COMPONENT_TYPE,
	Some("invalid component type"),
)];
const ITEM_KEY: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(120)];

js_enum! {
	/// Views a navigation can open.
	pub enum NavigationView {
		Workspace = "workspace",
		Sources = "sources",
		Settings = "settings",
	}
}

/// `navigationTargetSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum NavigationTarget {
	/// A view.
	#[serde(rename = "view")]
	View {
		/// The view.
		view: NavigationView,
	},
	/// One evidence record.
	#[serde(rename = "evidence", rename_all = "camelCase")]
	Evidence {
		/// Evidence id.
		evidence_id: String,
	},
}

impl NavigationTarget {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		run_discriminated(cx, input, "kind", &["view", "evidence"], |cx, tag| {
			if tag == 0 {
				decode_object!(cx, input, strict, ["kind"], Self::View {
					view: "view" => NavigationView::decode,
				})
			} else {
				decode_object!(cx, input, strict, ["kind"], Self::Evidence {
					evidence_id: "evidenceId" => id,
				})
			}
		})
	}
}

/// `uiOperationSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "operation")]
pub enum UiOperation {
	/// Create a component.
	#[serde(rename = "component.create", rename_all = "camelCase")]
	ComponentCreate {
		/// Component id.
		component_id: String,
		/// Component type.
		component_type: String,
		/// Props schema version (> 0).
		schema_version: u64,
		/// Props.
		props: JsonObject,
	},
	/// Update a component's props.
	#[serde(rename = "component.update", rename_all = "camelCase")]
	ComponentUpdate {
		/// Component id.
		component_id: String,
		/// Props.
		props: JsonObject,
	},
	/// Remove a component.
	#[serde(rename = "component.remove", rename_all = "camelCase")]
	ComponentRemove {
		/// Component id.
		component_id: String,
	},
	/// Focus a component.
	#[serde(rename = "component.focus", rename_all = "camelCase")]
	ComponentFocus {
		/// Component id.
		component_id: String,
	},
	/// Select an item of a component.
	#[serde(rename = "component.select", rename_all = "camelCase")]
	ComponentSelect {
		/// Component id.
		component_id: String,
		/// Item key (1..120), or null to clear.
		item_key: Option<String>,
	},
	/// Reorder the layout.
	#[serde(rename = "layout.update")]
	LayoutUpdate {
		/// Component ids in order (≤ 60).
		order: Vec<String>,
		/// 1 or 2 columns.
		columns: f64,
	},
	/// Bind a dataset to a component.
	#[serde(rename = "dataset.bind", rename_all = "camelCase")]
	DatasetBind {
		/// Component id.
		component_id: String,
		/// Dataset id.
		dataset_ref: String,
	},
	/// Replace a dataset.
	#[serde(rename = "dataset.refresh", rename_all = "camelCase")]
	DatasetRefresh {
		/// Dataset id.
		dataset_ref: String,
		/// Replacement dataset id.
		replacement_dataset_ref: String,
	},
	/// Navigate.
	#[serde(rename = "navigation.open")]
	NavigationOpen {
		/// Target.
		target: NavigationTarget,
	},
}

/// The `operation` tags, in schema order.
pub const UI_OPERATIONS: &[&str] = &[
	"component.create",
	"component.update",
	"component.remove",
	"component.focus",
	"component.select",
	"layout.update",
	"dataset.bind",
	"dataset.refresh",
	"navigation.open",
];

impl UiOperation {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		run_discriminated(cx, input, "operation", UI_OPERATIONS, |cx, tag| match tag {
			0 => decode_object!(cx, input, strict, ["operation"], Self::ComponentCreate {
				component_id: "componentId" => string(COMPONENT_ID),
				component_type: "componentType" => string(COMPONENT_TYPE),
				schema_version: "schemaVersion" => uint(&[NumCheck::Int, NumCheck::Gt(0.0)]),
				props: "props" => JsonObject::decode,
			}),
			1 => decode_object!(cx, input, strict, ["operation"], Self::ComponentUpdate {
				component_id: "componentId" => string(COMPONENT_ID),
				props: "props" => JsonObject::decode,
			}),
			2 => decode_object!(cx, input, strict, ["operation"], Self::ComponentRemove {
				component_id: "componentId" => string(COMPONENT_ID),
			}),
			3 => decode_object!(cx, input, strict, ["operation"], Self::ComponentFocus {
				component_id: "componentId" => string(COMPONENT_ID),
			}),
			4 => decode_object!(cx, input, strict, ["operation"], Self::ComponentSelect {
				component_id: "componentId" => string(COMPONENT_ID),
				item_key: "itemKey" => nullable(string(ITEM_KEY)),
			}),
			5 => decode_object!(cx, input, strict, ["operation"], Self::LayoutUpdate {
				order: "order" => array(string(COMPONENT_ID), &[ArrCheck::Max(60)]),
				columns: "columns" => number_literals(&[1.0, 2.0]),
			}),
			6 => decode_object!(cx, input, strict, ["operation"], Self::DatasetBind {
				component_id: "componentId" => string(COMPONENT_ID),
				dataset_ref: "datasetRef" => id,
			}),
			7 => decode_object!(cx, input, strict, ["operation"], Self::DatasetRefresh {
				dataset_ref: "datasetRef" => id,
				replacement_dataset_ref: "replacementDatasetRef" => id,
			}),
			_ => decode_object!(cx, input, strict, ["operation"], Self::NavigationOpen {
				target: "target" => NavigationTarget::decode,
			}),
		})
	}
}
