//! Planning history: full output once, then compact evidence digests (ADR-0010).
use super::prompts::cut_utf8_bytes;
use research_agent_core::tools::ToolOutput;
use research_domain::text::recent_within_budget::recent_count_within_budget;

#[derive(Debug, Clone)]
pub(super) struct CollectedEntry {
	pub step: u64,
	pub full_text: String,
	pub digest_lines: Vec<String>,
}

pub(super) fn digest_lines_for(id: &str, output: &ToolOutput) -> Vec<String> {
	if output.evidence.is_empty() {
		return vec![format!(
			"{id}: {} record(s), no evidence",
			output.securities.len()
				+ output.financial_observations.len()
				+ output.position_observations.len()
				+ output.investor_filings.len()
				+ output.articles.len()
		)];
	}
	output
		.evidence
		.iter()
		.map(|item| {
			let e = &item.evidence;
			let line = format!(
				"[{}] {} — {}; {}",
				e.evidence_id,
				e.title,
				e.publisher,
				e.published_at.as_deref().unwrap_or("undated")
			);
			let mut result = String::with_capacity(line.len());
			let mut newline = false;
			for ch in line.chars() {
				if ch == '\r' || ch == '\n' {
					if !newline {
						result.push(' ');
					}
					newline = true;
				} else {
					result.push(ch);
					newline = false;
				}
			}
			result
		})
		.collect()
}
pub(super) fn collected_so_far_text(entries: &[CollectedEntry], step: u64) -> String {
	let fresh = entries
		.iter()
		.filter(|e| step.checked_sub(1) == Some(e.step))
		.map(|e| e.full_text.as_str())
		.collect::<Vec<_>>()
		.join("\n\n");
	let fresh = if fresh.len() > 48000 {
		format!(
			"{}\n[older output truncated to the planning budget]",
			cut_utf8_bytes(&fresh, 48000)
		)
	} else {
		fresh
	};
	let older = entries
		.iter()
		.filter(|e| e.step < step)
		.flat_map(|e| e.digest_lines.iter())
		.collect::<Vec<_>>();
	if fresh.is_empty() && older.is_empty() {
		return String::new();
	}
	let sizes = older
		.iter()
		.map(|line| u64::try_from(line.len()).unwrap_or(u64::MAX))
		.collect::<Vec<_>>();
	let count = recent_count_within_budget(&sizes, 8000, 400);
	let omitted = older.len().saturating_sub(count);
	let digest = if count == 0 {
		"(no earlier output)".to_owned()
	} else {
		let mut lines = older
			.iter()
			.skip(omitted)
			.map(|s| s.as_str())
			.collect::<Vec<_>>()
			.join("\n");
		if omitted > 0 {
			lines.push_str(&format!("\n({omitted} older entries omitted)"));
		}
		lines
	};
	format!(
		"New tool output since the previous step (full text, shown once):\n{}\n\nEarlier tool output (one line per evidence item; do not re-request it):\n{digest}",
		if fresh.is_empty() { "(none)" } else { &fresh }
	)
}
