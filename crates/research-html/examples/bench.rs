//! Timing for the two `scripts/bench.ts` HTML cases and a `convert_many`
//! batch (ADR-0030). Run with
//! `cargo run --release -p research-html --example bench`.
//!
//! Budgets: the TypeScript budgets (100 ms, 2,000 ms) tightened tenfold; the
//! example exits with status 1 when a case exceeds its budget.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use std::time::{Duration, Instant};

use research_html::{MarkdownPage, Options, convert_many, html_to_markdown};

const BASE_URL: &str = "https://news.example.org/a/1";

/// `articleHtml` in `scripts/bench.ts`, with a page number in the title.
fn article_html(page: usize) -> String {
	let sentence =
		"Grid-scale battery orders doubled year over year to 1,250 units as utilities restocked. ";
	let mut html = format!(
		"<html><head><title>Grid battery orders double &amp; margins hold {page}</title><style>p{{color:red}}</style>"
	);
	html.push_str(
		"<script>window.tracker=\"x\";</script></head><body><nav><a href=\"/home\">home</a></nav><main><article><h1>Grid battery orders double</h1>",
	);
	for section in 0..1_000 {
		html.push_str(&format!(
			"<h2>Section {section}</h2><p>{}<strong>strong {section}</strong> <a href=\"/a/{section}\">link {section}</a></p>",
			sentence.repeat(8)
		));
		html.push_str(&format!(
			"<ul><li>item {section} a</li><li>item {section} b<ul><li>nested {section}</li></ul></li></ul>"
		));
		html.push_str(&format!(
			"<table><tr><th>Metric</th><th>Value</th></tr><tr><td>orders|units</td><td>{section}</td></tr></table>"
		));
		html.push_str(&format!(
			"<blockquote><p>quoted {section}</p></blockquote><pre>code {section}\n  indented</pre>"
		));
	}
	html.push_str("</article></main><aside>sidebar</aside><footer>footer</footer></body></html>");
	html
}

/// `deepNestingHtml` in `scripts/bench.ts`.
fn deep_nesting_html() -> String {
	let long_line = format!("x{}", "y".repeat(1999));
	format!(
		"{}<p>{}</p>{}",
		"<blockquote><ul><li><strong><em>".repeat(4_000),
		format!("{long_line}<br>").repeat(900),
		"</em></strong></li></ul></blockquote>".repeat(4_000)
	)
}

/// Median of `runs` timings after one warm-up run.
fn median(runs: usize, mut work: impl FnMut()) -> Duration {
	work();
	let mut times: Vec<Duration> = (0..runs)
		.map(|_| {
			let started = Instant::now();
			work();
			started.elapsed()
		})
		.collect();
	times.sort();
	times[times.len() / 2]
}

fn report(name: &str, time: Duration, budget: Duration) -> bool {
	let ok = time <= budget;
	println!(
		"{name}: {:.2} ms (budget {} ms){}",
		time.as_secs_f64() * 1e3,
		budget.as_millis(),
		if ok { "" } else { "  OVER BUDGET" }
	);
	ok
}

fn main() {
	let options = Options {
		base_url: BASE_URL,
		max_chars: 20_000,
	};
	let article = article_html(0);
	let deep = deep_nesting_html();
	let mut ok = true;
	let article_time = median(21, || {
		std::hint::black_box(html_to_markdown(&article, &options));
	});
	ok &= report(
		&format!("convert a 1 MB article page ({} KB)", article.len() / 1024),
		article_time,
		Duration::from_millis(10),
	);
	let deep_time = median(11, || {
		std::hint::black_box(html_to_markdown(&deep, &options));
	});
	ok &= report(
		&format!(
			"convert 2 MB of deeply nested formatting ({} KB)",
			deep.len() / 1024
		),
		deep_time,
		Duration::from_millis(200),
	);

	let pages: Vec<String> = (0..32).map(article_html).collect();
	let batch: Vec<(&str, Options<'_>)> =
		pages.iter().map(|page| (page.as_str(), options)).collect();
	let mut sequential: Vec<MarkdownPage> = Vec::new();
	let sequential_time = median(5, || {
		sequential = batch
			.iter()
			.map(|(html, options)| html_to_markdown(html, options))
			.collect();
	});
	let mut parallel: Vec<MarkdownPage> = Vec::new();
	let parallel_time = median(5, || {
		parallel = convert_many(&batch);
	});
	assert_eq!(
		parallel, sequential,
		"convert_many must equal the sequential result"
	);
	println!(
		"32 article pages: sequential {:.1} ms, convert_many {:.1} ms ({:.1}x on {} threads)",
		sequential_time.as_secs_f64() * 1e3,
		parallel_time.as_secs_f64() * 1e3,
		sequential_time.as_secs_f64() / parallel_time.as_secs_f64(),
		rayon::current_num_threads()
	);
	if !ok {
		std::process::exit(1);
	}
}
