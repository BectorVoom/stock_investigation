import type { CheckedField } from "./evidence.ts";
import { describeProblems } from "./evidence.ts";
import type { StockSources } from "./sources.ts";
import type {
	Evidence,
	Figure,
	FigureMetric,
	ProfileFact,
	SourceId,
	VerifiedDescription,
} from "./template.ts";

/**
 * The 企業の説明 section as the Company tab would show it, as HTML: laid out
 * like a 会社四季報 company entry on SBI証券's 企業概要 tab — labelled rows
 * (【特色】【事業内容】【連結事業】…), a 会社概要 table and a 業績 table — with
 * every source credit in small text: a small source mark after each field,
 * a small 出所 line under each part and the numbered 出典 list at the end.
 * Styled like the Company tab (slate text, 14 px body, 12 px small text).
 */

export type Language = "en" | "ja";

const WORDS = {
	ja: {
		heading: "事業概要",
		feature: "特色",
		businesses: "事業内容",
		segments: "連結事業",
		overseas: "海外",
		themes: "テーマ",
		profile: "会社概要",
		results: "業績",
		references: "出典",
		evidence: "根拠(出典からの引用)",
		sourceLine: "出所",
		notStated: "出典に記載なし",
		market: "市場",
		sector: "業種",
		fiscalYearEnd: "決算期",
		founded: "設立",
		employees: "従業員",
		headquarters: "本社",
		fiscalYear: (periodEnd: string) => `${periodEnd} 終了事業年度`,
		unit: (currency: string) =>
			currency === "JPY" ? "百万円" : currency === "USD" ? "百万ドル" : `百万${currency}`,
		operatingMargin: "営業利益率",
		computed: "営業利益率は上記の営業利益÷売上高で算出。",
		metric: {
			revenue: "売上高",
			"operating-income": "営業利益",
			"ordinary-income": "経常利益",
			"profit-attributable-to-owners": "純利益",
		},
		month: (month: number) => `${month}月`,
		segmentNote: "数値は売上構成比%(カッコ内は利益率%)。出典に数値がない部門は名称のみ。",
		aiNote: (model: string, date: string) =>
			`AI(${model})が ${date} に上記の出典だけから作成。各項目の根拠の引用は出典と一字一句照合済み。会社四季報の項目立てを参考にしたもので、同誌の内容ではありません。誤りを含む可能性があります。`,
	},
	en: {
		heading: "Business overview",
		feature: "Feature",
		businesses: "Businesses",
		segments: "Segments",
		overseas: "Overseas",
		themes: "Themes",
		profile: "Profile",
		results: "Results",
		references: "References",
		evidence: "Evidence (quotes from the sources)",
		sourceLine: "Source",
		notStated: "Not stated in the sources",
		market: "Market",
		sector: "Sector",
		fiscalYearEnd: "Fiscal year end",
		founded: "Founded",
		employees: "Employees",
		headquarters: "Headquarters",
		fiscalYear: (periodEnd: string) => `Fiscal year ended ${periodEnd}`,
		unit: (currency: string) => `${currency} millions`,
		operatingMargin: "Operating margin",
		computed: "Operating margin is operating income ÷ revenue above.",
		metric: {
			revenue: "Revenue",
			"operating-income": "Operating income",
			"ordinary-income": "Ordinary income",
			"profit-attributable-to-owners": "Net income",
		},
		month: (month: number) =>
			new Date(Date.UTC(2000, month - 1, 1)).toLocaleString("en-US", {
				month: "long",
				timeZone: "UTC",
			}),
		segmentNote:
			"Numbers are the share of sales in % (profit margin in parentheses); a segment without a stated number shows its name only.",
		aiNote: (model: string, date: string) =>
			`Written by AI (${model}) on ${date} from the sources above only. Every evidence quote was checked word for word against its source. The layout follows the Japan Company Handbook (会社四季報); none of its content is used. It may contain mistakes.`,
	},
} as const;

const LISTING_NAME: Record<string, { en: string; ja: string }> = {
	nasdaq: { en: "Nasdaq", ja: "ナスダック" },
	nyse: { en: "NYSE", ja: "NYSE" },
	"tse-prime": { en: "TSE Prime", ja: "東証プライム" },
	"tse-standard": { en: "TSE Standard", ja: "東証スタンダード" },
	"tse-growth": { en: "TSE Growth", ja: "東証グロース" },
};

export function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** Small source marks after a field: "S2" as a superscript link to the reference. */
function marks(ids: readonly SourceId[]): string {
	return [...new Set(ids)].map((id) => `<a class="mark" href="#ref-${id}">${id}</a>`).join("");
}

function evidenceMarks(evidence: readonly Evidence[]): string {
	return marks(evidence.map((item) => item.source));
}

/** A labelled row, 四季報's 【label】 on the left. */
function row(label: string, body: string): string {
	return `<div class="row"><dt>【${escapeHtml(label)}】</dt><dd>${body}</dd></div>`;
}

function notStated(language: Language): string {
	return `<span class="missing">${WORDS[language].notStated}</span>`;
}

/** Stored value in millions, grouped: 8283000000 → "8,283". */
export function millions(value: string): string {
	const amount = Math.round(Number(value) / 1_000_000);
	return amount.toLocaleString("en-US");
}

/** Operating income ÷ revenue in %, one decimal; null when either is missing or revenue is 0. */
export function operatingMargin(figures: readonly Figure[]): string | null {
	const find = (metric: FigureMetric) => figures.find((figure) => figure.metric === metric);
	const revenue = Number(find("revenue")?.value ?? Number.NaN);
	const income = Number(find("operating-income")?.value ?? Number.NaN);
	if (!Number.isFinite(revenue) || !Number.isFinite(income) || revenue === 0) return null;
	return `${((income / revenue) * 100).toFixed(1)}%`;
}

function segmentText(segment: VerifiedDescription["segments"][number], language: Language): string {
	const share = segment.salesSharePercent === null ? "" : String(segment.salesSharePercent);
	const margin = segment.marginPercent === null ? "" : `(${segment.marginPercent})`;
	const activity =
		segment.activity === null
			? ""
			: `${language === "ja" ? "：" : ": "}${escapeHtml(segment.activity[language])}`;
	return `${escapeHtml(segment.name[language])}${share}${margin}${activity}${evidenceMarks(segment.evidence)}`;
}

function profileValue(
	facts: readonly ProfileFact[],
	field: ProfileFact["field"],
	language: Language,
): string {
	const fact = facts.find((item) => item.field === field);
	return fact === undefined
		? notStated(language)
		: `${escapeHtml(fact.value[language])}${evidenceMarks(fact.evidence)}`;
}

function evidenceList(description: VerifiedDescription, language: Language): string {
	const w = WORDS[language];
	const entries: { label: string; evidence: readonly Evidence[] }[] = [
		...(description.feature === null
			? []
			: [{ label: w.feature, evidence: description.feature.evidence }]),
		...description.businesses.map((item) => ({ label: w.businesses, evidence: item.evidence })),
		...description.segments.map((item) => ({
			label: `${w.segments}: ${item.name[language]}`,
			evidence: item.evidence,
		})),
		...(description.overseasSales === null
			? []
			: [{ label: w.overseas, evidence: description.overseasSales.evidence }]),
		...description.profile.map((item) => ({ label: w[item.field], evidence: item.evidence })),
		...description.themes.map((item) => ({
			label: `${w.themes}: ${item.label[language]}`,
			evidence: item.reason.evidence,
		})),
	];
	const items = entries
		.map(
			(entry) =>
				`<li><span class="ev-label">${escapeHtml(entry.label)}</span> ${entry.evidence
					.map((item) => `${item.source}「${escapeHtml(item.quote.replace(/\s+/g, " "))}」`)
					.join(" ")}</li>`,
		)
		.join("");
	return `<details class="small"><summary>${w.evidence}</summary><ul class="evidence">${items}</ul></details>`;
}

/** One language's 企業の説明 section. */
export function renderSection(input: {
	readonly stock: StockSources;
	readonly description: VerifiedDescription;
	readonly language: Language;
	readonly model: string;
	readonly generatedOn: string;
}): string {
	const { description, stock, language } = input;
	const w = WORDS[language];
	const textSources = new Set<SourceId>();
	const note = (evidence: readonly Evidence[]) => {
		for (const item of evidence) textSources.add(item.source);
		return evidenceMarks(evidence);
	};

	// 【特色】【事業内容】【連結事業】【海外】【テーマ】: the model's fields.
	const rows = [
		row(
			w.feature,
			description.feature === null
				? notStated(language)
				: `${escapeHtml(description.feature[language])}${note(description.feature.evidence)}`,
		),
		row(
			w.businesses,
			description.businesses.length === 0
				? notStated(language)
				: `<ul class="list">${description.businesses
						.map((item) => `<li>${escapeHtml(item[language])}${note(item.evidence)}</li>`)
						.join("")}</ul>`,
		),
		row(
			w.segments,
			description.segments.length === 0
				? notStated(language)
				: `${description.segments
						.map((segment) => {
							note(segment.evidence);
							return segmentText(segment, language);
						})
						.join(language === "ja" ? "、" : ", ")}<div class="small">${w.segmentNote}</div>`,
		),
		row(
			w.overseas,
			description.overseasSales === null
				? notStated(language)
				: `${description.overseasSales.percent}%${note(description.overseasSales.evidence)}`,
		),
		row(
			w.themes,
			description.themes.length === 0
				? notStated(language)
				: `<ul class="chips">${description.themes
						.map(
							(theme) =>
								`<li title="${escapeHtml(theme.reason[language])}">${escapeHtml(theme.label[language])}${note(theme.reason.evidence)}</li>`,
						)
						.join("")}</ul>`,
		),
	].join("");
	const sourceLine = (ids: readonly SourceId[]) =>
		ids.length === 0
			? ""
			: `<p class="small source">${w.sourceLine}: ${[...new Set(ids)]
					.map((id) => {
						const source = stock.sources.find((item) => item.id === id);
						return source === undefined
							? id
							: `<a href="#ref-${id}">${id}</a> ${escapeHtml(source.title[language])}`;
					})
					.join(" / ")}</p>`;

	// 会社概要: code fills market, sector and fiscal year end from stored records.
	const listing = stock.profile.listing;
	const listingName =
		listing === null
			? notStated(language)
			: `${escapeHtml(LISTING_NAME[listing]?.[language] ?? listing)}${stock.cites.listing === null ? "" : marks([stock.cites.listing])}`;
	const monthText = stock.profile.fiscalYearEnd?.slice(0, 2);
	const fiscalYearEnd =
		monthText === undefined ? notStated(language) : escapeHtml(w.month(Number(monthText)));
	const profileRows = [
		[w.market, listingName],
		...(stock.stock.market === "JP"
			? [
					[
						w.sector,
						stock.profile.sector === null
							? notStated(language)
							: `${escapeHtml(stock.profile.sector)}${stock.cites.sector === null ? "" : marks([stock.cites.sector])}`,
					],
				]
			: []),
		[w.fiscalYearEnd, fiscalYearEnd],
		[w.founded, profileValue(description.profile, "founded", language)],
		[w.employees, profileValue(description.profile, "employees", language)],
		[w.headquarters, profileValue(description.profile, "headquarters", language)],
	];
	const profileTable = `<table class="kv">${profileRows
		.map(([term, value]) => `<tr><th>${term}</th><td>${value}</td></tr>`)
		.join("")}</table>`;

	// 業績: the stored figures in millions and the margin computed from them.
	const [first] = stock.figures;
	const margin = operatingMargin(stock.figures);
	const resultsTable =
		first === undefined
			? `<p>${notStated(language)}</p>`
			: `<table class="kv"><caption>${escapeHtml(w.fiscalYear(first.periodEnd))}<span class="small"> (${escapeHtml(w.unit(first.currency))})</span></caption>${stock.figures
					.map(
						(figure) =>
							`<tr><th>${w.metric[figure.metric]}</th><td class="num">${millions(figure.value)}</td></tr>`,
					)
					.join(
						"",
					)}${margin === null ? "" : `<tr><th>${w.operatingMargin}</th><td class="num">${margin}</td></tr>`}</table>${
					margin === null ? "" : `<p class="small">${w.computed}</p>`
				}`;

	const references = `<ol class="refs small">${stock.sources
		.map((source) => {
			const parts = [
				escapeHtml(source.title[language]),
				escapeHtml(source.publisher),
				...(source.asOf === null ? [] : [escapeHtml(source.asOf)]),
				...(source.note === null ? [] : [escapeHtml(source.note[language])]),
			];
			const link =
				source.url === null
					? ""
					: ` <a href="${escapeHtml(source.url)}" rel="noreferrer noopener" target="_blank">${escapeHtml(source.url)}</a>`;
			return `<li id="ref-${source.id}"><span class="ref-id">[${source.id}]</span> ${parts.join("。")}${link}</li>`;
		})
		.join("")}</ol>`;

	const profileSources = [
		...(stock.cites.listing === null ? [] : [stock.cites.listing]),
		...(stock.cites.sector === null ? [] : [stock.cites.sector]),
		...description.profile.flatMap((fact) => fact.evidence.map((item) => item.source)),
	];
	return `<section lang="${language}" aria-label="${w.heading}">
<h4>${w.heading}<span class="name">${escapeHtml(stock.name[language])} (${escapeHtml(stock.stock.symbol)})</span></h4>
<dl class="entry">${rows}</dl>
${sourceLine([...textSources].sort())}
<div class="tables">
<div><h5>${w.profile}</h5>${profileTable}${sourceLine(profileSources)}</div>
<div><h5>${w.results}</h5>${resultsTable}${sourceLine(stock.cites.figures === null ? [] : [stock.cites.figures])}</div>
</div>
${evidenceList(description, language)}
<h5 class="small-heading">${w.references}</h5>
${references}
<p class="small ai">${escapeHtml(w.aiNote(input.model, input.generatedOn))}</p>
</section>`;
}

const STYLE = `
body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;color:#0f172a;margin:24px;max-width:960px}
section{border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:24px}
h4{font-size:15px;font-weight:600;margin:0 0 8px}
h4 .name{font-weight:400;color:#475569;margin-left:8px;font-size:13px}
h5{font-size:12px;font-weight:600;color:#334155;margin:12px 0 4px}
.entry{margin:0}
.row{display:grid;grid-template-columns:7.5rem 1fr;gap:0 8px;border-bottom:1px solid #f1f5f9;padding:6px 0}
dt{font-size:13px;font-weight:600;color:#334155}
dd{margin:0;font-size:14px;line-height:1.6;max-width:70ch}
.list{margin:0;padding-left:1.1em}
.chips{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0;padding:0}
.chips li{border:1px solid #cbd5e1;background:#f8fafc;border-radius:999px;padding:1px 10px;font-size:12px}
.mark{font-size:10px;vertical-align:super;color:#64748b;text-decoration:none;margin-left:2px}
.mark:hover{text-decoration:underline}
.small{font-size:11px;line-height:1.5;color:#475569}
.source{margin:4px 0 0}
.source a,.refs a{color:#475569}
.missing{font-size:12px;font-style:italic;color:#64748b}
.tables{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.kv{border-collapse:collapse;width:100%;font-size:13px}
.kv caption{text-align:left;font-size:12px;color:#334155;padding-bottom:2px}
.kv th{text-align:left;font-weight:500;color:#334155;padding:3px 8px 3px 0;border-bottom:1px solid #f1f5f9;width:9rem}
.kv td{padding:3px 0;border-bottom:1px solid #f1f5f9}
.num{text-align:right;font-variant-numeric:tabular-nums}
details{margin-top:12px}
summary{cursor:pointer}
.evidence{margin:4px 0;padding-left:1.1em}
.ev-label{font-weight:600}
.small-heading{font-size:11px;color:#475569;margin-bottom:2px}
.refs{margin:0;padding-left:0;list-style:none}
.refs li{margin:1px 0;word-break:break-all}
.ref-id{color:#334155}
.ai{margin-top:8px}
.check{font-size:12px;color:#334155;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;padding:8px 12px}
`;

/** A standalone page with the section in Japanese and English, and the PoC's check record. */
export function renderPage(input: {
	readonly title: string;
	readonly sections: readonly string[];
	readonly check: string;
}): string {
	return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title><style>${STYLE}</style></head>
<body>
${input.sections.join("\n")}
<div class="check">${input.check}</div>
</body></html>
`;
}

/** The PoC's own check record (not part of the template): which fields were rejected and why. */
export function renderCheck(checked: readonly CheckedField[]): string {
	const failed = checked.filter((field) => field.problems.length > 0);
	const lines = describeProblems(checked).map((line) => `<li>${escapeHtml(line)}</li>`);
	return `PoC evidence check: ${checked.length - failed.length} of ${checked.length} fields verified.${
		lines.length === 0 ? "" : `<ul>${lines.join("")}</ul>`
	}`;
}
