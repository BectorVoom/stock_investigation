//! The Notebook of one conversation (`packages/contracts/src/notebook.ts`, ADR-0020).

use research_js::json::{Object, Value};
use serde::Serialize;

use crate::primitives::{ISO_DATE_TIME, id};
use crate::widgets::{WidgetContent, WidgetSize, decode_widget_union};
use crate::zod::{
	ArrCheck, Cx, NumCheck, array, decode_fields, decode_object, js_enum, nullable, refine,
	run_string, uint,
};

/// `NOTEBOOK_LIMITS` (beyond `WIDGET_LIMITS`, which it spreads).
pub mod limits {
	pub use crate::widgets::limits::*;

	/// Widgets of one notebook.
	pub const MAX_WIDGETS: usize = 200;
	/// Characters of one owner instruction.
	pub const MAX_INSTRUCTION_CHARS: usize = 2_000;
	/// Selected widgets travelling with one instruction.
	pub const MAX_SELECTED_WIDGETS: usize = 12;
	/// Commands applied from one assistant turn.
	pub const MAX_COMMANDS_PER_TURN: usize = 12;
	/// Characters of the assistant's reply.
	pub const MAX_REPLY_CHARS: usize = 2_000;
	/// Undo depth.
	pub const MAX_REVISIONS: usize = 20;
	/// Assistant turns returned with the notebook.
	pub const MAX_TURNS_RETURNED: usize = 30;
}

js_enum! {
	/// Who made a widget.
	pub enum NotebookWidgetOriginKind {
		Owner = "owner",
		Assistant = "assistant",
		Chat = "chat",
	}
}

/// `notebookWidgetOriginSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookWidgetOrigin {
	/// Who made it.
	pub kind: NotebookWidgetOriginKind,
	/// Chat message it was saved from.
	pub message_id: Option<String>,
	/// Run that produced it.
	pub run_id: Option<String>,
	/// Canvas component it was saved from.
	pub component_id: Option<String>,
}

impl NotebookWidgetOrigin {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			kind: "kind" => NotebookWidgetOriginKind::decode,
			message_id: "messageId" => nullable(id),
			run_id: "runId" => nullable(id),
			component_id: "componentId" => nullable(id),
		})
	}
}

/// The server-stamped metadata of a stored widget.
#[derive(Debug, Clone, PartialEq, Eq)]
struct WidgetMeta {
	created_at: String,
	updated_at: String,
	revision: u64,
	origin: NotebookWidgetOrigin,
}

const META_KEYS: [&str; 4] = ["createdAt", "updatedAt", "revision", "origin"];

fn decode_meta(cx: &mut Cx, object: &Object) -> Option<WidgetMeta> {
	decode_fields!(cx, object, WidgetMeta {
		created_at: "createdAt" => |cx: &mut Cx, input| run_string(cx, input, ISO_DATE_TIME),
		updated_at: "updatedAt" => |cx: &mut Cx, input| run_string(cx, input, ISO_DATE_TIME),
		revision: "revision" => uint(&[NumCheck::Int, NumCheck::Gt(0.0)]),
		origin: "origin" => NotebookWidgetOrigin::decode,
	})
}

/// `notebookWidgetSchema`: a widget core plus the metadata the server stamps.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookWidget {
	/// Widget id.
	pub widget_id: String,
	/// Title (trimmed, 1..120).
	pub title: String,
	/// Size.
	pub size: WidgetSize,
	/// Creation time.
	pub created_at: String,
	/// Last change.
	pub updated_at: String,
	/// 1 on creation, +1 per change.
	pub revision: u64,
	/// Origin.
	pub origin: NotebookWidgetOrigin,
	/// Type and content.
	#[serde(flatten)]
	pub content: WidgetContent,
}

impl NotebookWidget {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_widget_union(cx, input, &META_KEYS, decode_meta).map(
			|(widget_id, title, size, meta, content)| Self {
				widget_id,
				title,
				size,
				created_at: meta.created_at,
				updated_at: meta.updated_at,
				revision: meta.revision,
				origin: meta.origin,
				content,
			},
		)
	}
}

/// `notebookSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Notebook {
	/// Widgets in order (≤ 200, distinct ids).
	pub widgets: Vec<NotebookWidget>,
}

impl Notebook {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let mark = cx.mark();
		let notebook = decode_object!(cx, input, strict, [], Self {
			widgets: "widgets" => array(NotebookWidget::decode, &[ArrCheck::Max(limits::MAX_WIDGETS)]),
		});
		refine(cx, mark, notebook.as_ref(), |cx, notebook| {
			let ids: Vec<&str> = notebook
				.widgets
				.iter()
				.map(|widget| widget.widget_id.as_str())
				.collect();
			let mut sorted = ids.clone();
			sorted.sort_unstable();
			sorted.dedup();
			if sorted.len() != ids.len() {
				cx.refine_failed(Some("widgets"), "widget ids must be distinct");
			}
		});
		notebook
	}
}
