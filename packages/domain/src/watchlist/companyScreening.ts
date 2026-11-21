import type { ThemeName } from "./themeSearch.ts";

/**
 * Fuzzy matching and theme/sector membership classification for company retrieval.
 *
 * Mirrors the Lean 4 model in `formal/ResearchFormal/CompanyScreening.lean`:
 * - Bounded Optimal String Alignment (OSA) edit distance (`boundedOsaDistance`) with
 *   sound pigeonhole 2-gram SQL prefilters (`prefilterSlices`).
 * - Orthographic normalization (`foldCompanySearchText`, `canonicalKana`), safe English
 *   noun/builder stemming (`stemEnglishToken`), and bilingual domain synset expansion.
 * - Theme/sector membership filtering (`classifyCompanyMembership`, `evaluateCompanyCandidate`)
 *   excluding customer-only themes (`<Target>向け<Head>`, `<Target>用<Head>`), ancillary
 *   financing/leasing/component themes, blank-check SPACs, and divested/historical mentions.
 */

export type CompanyTokenKind = "numericOrTicker" | "cjk" | "katakana" | "ascii" | "mixed";

export type CompanyMembershipTier =
	| "identity"
	| "directTheme"
	| "relatedTheme"
	| "sectorSegment"
	| "activeFiling";

export const COMPANY_MEMBERSHIP_TIER_RANK: Record<CompanyMembershipTier, number> = {
	identity: 0,
	directTheme: 1,
	relatedTheme: 2,
	sectorSegment: 3,
	activeFiling: 4,
};

export interface ThemeMatchFlags {
	readonly matchesTargetOnly: boolean;
	readonly isAncillary: boolean;
	readonly matchesDirect: boolean;
	readonly matchesRelated: boolean;
}

export interface CompanyTermMatch {
	readonly identity: boolean;
	readonly directTheme: boolean;
	readonly relatedTheme: boolean;
	readonly sectorOrSegment: boolean;
	readonly activeBody: boolean;
}

export interface ParsedCompanyTerm {
	readonly raw: string;
	readonly folded: string;
	readonly kind: CompanyTokenKind;
	readonly stem: string;
	readonly kanaKey: string;
	readonly allowedEdits: number;
	readonly directVariants: readonly string[];
	readonly relatedVariants: readonly string[];
	readonly sqlNeedles: readonly string[];
	readonly fuzzySqlSlices: readonly string[];
}

export interface ParsedCompanyQuery {
	readonly marketFilter: "JP" | "US" | null;
	readonly queriesBlankCheck: boolean;
	readonly terms: readonly ParsedCompanyTerm[];
	readonly rawTerms: readonly string[];
}

export interface CompanyCandidateInput {
	readonly market: "JP" | "US";
	readonly symbol: string;
	readonly name: string | null;
	readonly localName: string | null;
	readonly hasSummary: boolean;
	readonly themes: readonly ThemeName[];
	readonly sector17Name: string | null;
	readonly sector33Name: string | null;
	readonly segmentNames: readonly ThemeName[];
	readonly bodyText: string;
	/** For multi-paragraph filings (`!aiGenerated`), the specific document title + paragraph text. */
	readonly documentText?: string;
}

export interface CompanyCandidateEvaluation {
	readonly tier: CompanyMembershipTier;
	readonly rank: number;
	readonly hasIdentityTerm: boolean;
}

const HIRAGANA_START = 0x3041;
const HIRAGANA_END = 0x3096;
const KATAKANA_OFFSET = 0x60;

const SMALL_KANA_MAP: Readonly<Record<string, string>> = {
	ァ: "ア",
	ィ: "イ",
	ゥ: "ウ",
	ェ: "エ",
	ォ: "オ",
	ッ: "ツ",
	ャ: "ヤ",
	ュ: "ユ",
	ョ: "ヨ",
	ヮ: "ワ",
	ヵ: "カ",
	ヶ: "ケ",
};

const CJK_SCRIPT_RE = /\p{Script=Han}/u;
const KATAKANA_ONLY_RE = /^[\u30a0-\u30ff]+$/u;
const ASCII_ALPHA_ONLY_RE = /^[a-z]+$/;
const NUMERIC_OR_TICKER_RE = /^(?:(?=.*[0-9])[0-9a-z:.-]+|(?:jp|us):[0-9a-z.-]+)$/;
const WORD_SPLIT_RE = /[^0-9a-z\u30a0-\u30ff\p{Script=Han}]+/u;
const SENTENCE_SPLIT_RE = /[。\r\n]+|(?<=\.)\s+/u;

const MARKET_QUALIFIERS_JP = new Set(["jp", "japan", "japanese", "日本", "日本の", "国内"]);
const MARKET_QUALIFIERS_US = new Set(["us", "usa", "american", "米国", "米国の", "アメリカ"]);

const DEFENSE_EXEMPT_TERMS = new Set(["防衛", "国防", "防衛装備", "defense", "military"]);

const NON_TARGET_YO_PREFIXES = new Set([
	"汎",
	"商",
	"乗",
	"信",
	"運",
	"採",
	"日",
	"実",
	"専",
	"公",
	"民",
	"家",
	"医",
	"産",
	"農",
	"工",
]);

const ANCILLARY_JA_SUFFIXES = [
	"融資",
	"ファイナンス",
	"リース",
	"貸渡業",
	"貸渡",
	"保険",
	"代理店業務",
	"代理店",
	"仲介",
	"人材サービス",
	"人材派遣",
	"人材紹介",
	"コンサルティング",
	"防汚塗料",
	"塗料",
	"部品",
	"部材",
] as const;

const ANCILLARY_EN_HEADS = [
	"financing",
	"leasing",
	"insurance",
	"agency",
	"brokerage",
	"staffing",
	"consulting",
	"coatings",
	"components",
	"alloys",
] as const;

const BLANK_CHECK_PATTERNS = [
	"blank check company",
	"blank-check company",
	"special purpose acquisition company",
	"特別買収目的会社",
	"ケイマン諸島設立のspac",
	"目立った事業を持たない",
	"特定事業を持たず",
] as const;

const DIVESTED_OR_CUSTOMER_MARKERS = [
	"事業を譲渡",
	"事業から撤退",
	"から撤退",
	"事業を売却",
	"事業を廃止",
	"会社分割により",
	"現物出資により",
	"祖業とする",
	"源流とする",
	"前身は",
	"主要顧客は",
	"主な顧客は",
	"納入先は",
	"販売先は",
	"向け部材にも供給",
	"向けに販売",
	"からの受注による",
	"former ",
	"divested",
	"spun off",
	"spin-off of",
	"discontinued",
	"sold its ",
	"exited the ",
	"customers include",
	"serving end markets",
	"sold to shipyards",
	"orders received from shipyards",
] as const;

interface ConceptSynset {
	readonly triggers: readonly string[];
	readonly direct: readonly string[];
	readonly related: readonly string[];
	/** Minimal sound substring roots covering `direct` and `related` in SQL prefiltering. */
	readonly sqlRoots: readonly string[];
}

const CONCEPT_SYNSETS: readonly ConceptSynset[] = [
	{
		triggers: [
			"造船",
			"新造船",
			"船舶建造",
			"造船所",
			"shipbuild",
			"shipbuilding",
			"shipbuilder",
			"shipbuilders",
			"newbuild",
			"newbuilding",
			"shipyard",
			"zosen",
		],
		direct: [
			"造船",
			"新造船",
			"船舶事業",
			"船舶建造",
			"shipbuilding",
			"shipbuilder",
			"newbuilding",
			"zosen",
		],
		related: [
			"船舶修繕",
			"修繕船",
			"潜水艦建造",
			"通常動力型潜水艦",
			"原子力潜水艦",
			"原子力空母",
			"強襲揚陸艦",
			"ミサイル駆逐艦",
			"護衛艦建造",
			"ship repair",
			"submarine construction",
			"nuclear submarines",
			"nuclear-powered submarines",
			"conventional submarines",
			"nuclear aircraft carriers",
			"amphibious assault ships",
			"guided-missile destroyers",
		],
		sqlRoots: [
			"造船",
			"船舶",
			"修繕",
			"潜水艦",
			"空母",
			"shipbuild",
			"newbuild",
			"submarin",
			"zosen",
		],
	},
	{
		triggers: ["海運", "海運業", "外航海運", "内航海運", "shipping"],
		direct: ["海運", "海運業", "外航海運", "内航海運", "maritime shipping", "ocean shipping"],
		related: ["ドライバルク", "ばら積み船", "コンテナ船", "dry bulk", "container shipping"],
		sqlRoots: ["海運", "shipping", "ドライバルク", "dry bulk"],
	},
	{
		triggers: ["ドローン", "無人航空機", "マルチコプター", "drone", "drones", "uav"],
		direct: ["ドローン", "無人航空機", "マルチコプター", "drone", "uav", "unmanned aerial"],
		related: [],
		sqlRoots: ["ドローン", "無人航空機", "マルチコプター", "drone", "uav"],
	},
	{
		triggers: ["太陽光", "太陽光発電", "太陽電池", "solar", "photovoltaic"],
		direct: ["太陽光", "太陽光発電", "太陽電池", "solar", "photovoltaic"],
		related: [],
		sqlRoots: ["太陽", "solar", "photovoltaic"],
	},
	{
		triggers: ["蓄電池", "二次電池", "リチウムイオン電池", "全固体電池", "battery", "batteries"],
		direct: [
			"蓄電池",
			"二次電池",
			"リチウムイオン電池",
			"全固体電池",
			"battery",
			"energy storage",
			"lithium-ion",
		],
		related: [],
		sqlRoots: ["電池", "battery", "batteries", "energy storage"],
	},
	{
		triggers: ["半導体", "semiconductor", "semiconductors"],
		direct: ["半導体", "semiconductor"],
		related: [
			"ウエハー",
			"ウェハー",
			"ファウンドリ",
			"露光装置",
			"エッチング",
			"wafer",
			"foundry",
			"lithography",
		],
		sqlRoots: [
			"半導体",
			"semiconductor",
			"ウエハ",
			"ウェハ",
			"ファウンドリ",
			"露光",
			"wafer",
			"foundry",
		],
	},
	{
		triggers: ["人工知能", "生成ai", "ai"],
		direct: ["人工知能", "生成ai", "artificial intelligence", "generative ai", "ai"],
		related: [],
		sqlRoots: ["人工知能", "ai", "artificial intelligence"],
	},
	{
		triggers: ["ロボット", "産業用ロボット", "robot", "robots", "robotics"],
		direct: ["ロボット", "産業用ロボット", "協働ロボット", "robot", "robotics"],
		related: [],
		sqlRoots: ["ロボット", "robot"],
	},
	{
		triggers: ["サイバーセキュリティ", "情報セキュリティ", "cybersecurity"],
		direct: [
			"サイバーセキュリティ",
			"情報セキュリティ",
			"cybersecurity",
			"network security",
			"endpoint security",
		],
		related: [],
		sqlRoots: ["セキュリティ", "cybersecurity", "security"],
	},
	{
		triggers: ["防衛", "国防", "defense"],
		direct: ["防衛", "国防", "防衛装備", "defense", "military"],
		related: [],
		sqlRoots: ["防衛", "国防", "defense", "military"],
	},
	{
		triggers: ["電気自動車", "ev"],
		direct: ["電気自動車", "ev", "electric vehicle"],
		related: [],
		sqlRoots: ["電気自動車", "ev", "electric vehicle"],
	},
	{
		triggers: ["洋上風力", "洋上風力発電", "offshore wind"],
		direct: ["洋上風力", "洋上風力発電", "offshore wind"],
		related: [],
		sqlRoots: ["洋上風力", "offshore wind"],
	},
	{
		triggers: ["クラウド", "saas", "cloud"],
		direct: ["クラウド", "saas", "cloud computing", "cloud software", "cloud"],
		related: [],
		sqlRoots: ["クラウド", "saas", "cloud"],
	},
];

/** Converts Hiragana code points (`U+3041..U+3096`) to Katakana (`+0x60`). */
function hiraganaToKatakana(text: string): string {
	let out = "";
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp >= HIRAGANA_START && cp <= HIRAGANA_END) {
			out += String.fromCodePoint(cp + KATAKANA_OFFSET);
		} else {
			out += ch;
		}
	}
	return out;
}

/**
 * Folds search text with NFKC, ASCII lowercasing, Hiragana -> Katakana (when pure kana),
 * and collapsed whitespace. Mixed Kanji+Hiragana tokens keep Hiragana (`向け`, `日本の`) intact!
 */
export function foldCompanySearchText(raw: string): string {
	const nfkc = raw
		.normalize("NFKC")
		.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
		.replace(/\s+/gu, " ")
		.trim();
	// Convert standalone Hiragana runs that are NOT attached to Kanji or adjacent Hiragana:
	return nfkc.replace(
		/(?<![\p{Script=Han}\u3041-\u3096])[\u3041-\u3096\u30fc]{2,}(?![\p{Script=Han}\u3041-\u3096])/gu,
		(m) => hiraganaToKatakana(m).normalize("NFC"),
	);
}

/** ASCII-only lower + NFKC fold suitable for matching SQLite's `lower(...)` after NFKC. */
export function foldSqlQueryText(raw: string): string {
	return raw
		.normalize("NFKC")
		.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
		.replace(/\s+/gu, " ")
		.trim();
}

/**
 * Orthographic canonicalization for Katakana words:
 * - Maps small kana (`ァィゥェォッャュョヮヵヶ`) to full-size (`フイルム` <-> `フィルム`, `キヤノン` <-> `キャノン`).
 * - Strips prolonged sound marks (`ー`) on words of length >= 3 (`エレベータ` <-> `エレベーター`, `モータ` <-> `モーター`).
 */
export function canonicalKana(text: string): string {
	const kata = hiraganaToKatakana(text.normalize("NFKC")).normalize("NFC");
	let mapped = "";
	for (const ch of kata) {
		mapped += SMALL_KANA_MAP[ch] ?? ch;
	}
	const chars = Array.from(mapped);
	if (chars.length < 3) return mapped;
	const withoutBar = chars.filter((ch) => ch !== "ー").join("");
	return Array.from(withoutBar).length >= 2 ? withoutBar : mapped;
}

/**
 * Safe English plural and `-building`/`-builder` stemmer.
 * Never conflates `shipping` with `ship` or `server`/`tanker`/`carrier`/`power` with unrelated roots.
 */
export function stemEnglishToken(word: string): string {
	const lower = word.toLowerCase();
	if (!ASCII_ALPHA_ONLY_RE.test(lower) || lower.length < 4) return lower;
	const compoundBuild = lower.match(/^(shipbuild|newbuild|homebuild|boatbuild)(?:ing|ers?|s)?$/);
	if (compoundBuild?.[1] !== undefined) return compoundBuild[1];

	let stem = lower;
	if (stem.length >= 5 && stem.endsWith("ies")) {
		stem = `${stem.slice(0, -3)}y`;
	} else if (
		stem.length >= 5 &&
		(stem.endsWith("shes") ||
			stem.endsWith("ches") ||
			stem.endsWith("xes") ||
			stem.endsWith("zes") ||
			stem.endsWith("sses"))
	) {
		stem = stem.slice(0, -2);
	} else if (
		stem.length >= 4 &&
		stem.endsWith("s") &&
		!stem.endsWith("ss") &&
		!stem.endsWith("us") &&
		!stem.endsWith("is")
	) {
		stem = stem.slice(0, -1);
	}
	return stem;
}

/** Classifies a folded token to assign its safe fuzzy edit budget (`TokenKind` in Lean). */
export function classifyCompanyTokenKind(token: string): CompanyTokenKind {
	if (NUMERIC_OR_TICKER_RE.test(token)) return "numericOrTicker";
	if (CJK_SCRIPT_RE.test(token)) return "cjk";
	if (ASCII_ALPHA_ONLY_RE.test(token)) return "ascii";
	if (KATAKANA_ONLY_RE.test(token)) return "katakana";
	return "mixed";
}

/** Exact mirror of `allowedEdits` in `CompanyScreening.lean`. */
export function fuzzyAllowedEdits(kind: CompanyTokenKind, codePointLength: number): number {
	switch (kind) {
		case "numericOrTicker":
		case "cjk":
		case "mixed":
			return 0;
		case "katakana":
			return codePointLength >= 5 ? 1 : 0;
		case "ascii":
			return codePointLength >= 9 ? 2 : codePointLength >= 5 ? 1 : 0;
	}
}

function optMin(a: number | null, b: number | null): number | null {
	if (a === null) return b;
	if (b === null) return a;
	return Math.min(a, b);
}

function optSucc(a: number | null): number | null {
	return a === null ? null : a + 1;
}

function osaWithinArrays(
	maxEdits: number,
	a: readonly number[],
	ai: number,
	b: readonly number[],
	bi: number,
): number | null {
	let i = ai;
	let j = bi;
	while (i < a.length && j < b.length && a[i] === b[j]) {
		i += 1;
		j += 1;
	}
	const remA = a.length - i;
	const remB = b.length - j;
	if (remA === 0 && remB === 0) return 0;
	if (maxEdits === 0) return null;
	if (remA === 0) return remB <= maxEdits ? remB : null;
	if (remB === 0) return remA <= maxEdits ? remA : null;
	if (Math.abs(remA - remB) > maxEdits) return null;

	const nextK = maxEdits - 1;
	const del = optSucc(osaWithinArrays(nextK, a, i + 1, b, j));
	const ins = optSucc(osaWithinArrays(nextK, a, i, b, j + 1));
	const sub = optSucc(osaWithinArrays(nextK, a, i + 1, b, j + 1));
	const trans =
		i + 1 < a.length && j + 1 < b.length && a[i] === b[j + 1] && a[i + 1] === b[j]
			? optSucc(osaWithinArrays(nextK, a, i + 2, b, j + 2))
			: null;
	return optMin(optMin(del, ins), optMin(sub, trans));
}

/** Exact mirror of `osaWithin` in `CompanyScreening.lean` over code-point arrays. */
export function osaWithinCodePoints(
	maxEdits: number,
	a: readonly number[],
	b: readonly number[],
): number | null {
	if (maxEdits < 0) return null;
	return osaWithinArrays(maxEdits, a, 0, b, 0);
}

/** Bounded Optimal String Alignment distance (`null` if distance `> maxEdits`). */
export function boundedOsaDistance(a: string, b: string, maxEdits: number): number | null {
	if (maxEdits < 0) return null;
	if (a === b) return 0;
	if (maxEdits === 0) return null;
	const cpA = Array.from(a, (ch) => ch.codePointAt(0) ?? 0);
	const cpB = Array.from(b, (ch) => ch.codePointAt(0) ?? 0);
	if (Math.abs(cpA.length - cpB.length) > maxEdits) return null;
	return osaWithinArrays(maxEdits, cpA, 0, cpB, 0);
}

/**
 * Sound 2-character pigeonhole slices (`slice2` in `CompanyScreening.lean`).
 * - `maxEdits === 1` (`length >= 5`): `[q[0..2), q[3..5)]`
 * - `maxEdits === 2` (`length >= 8`): `[q[0..2), q[3..5), q[6..8)]`
 */
export function prefilterSlices(token: string, maxEdits: number): readonly string[] {
	const chars = Array.from(token);
	if (maxEdits <= 0 || chars.length < 5) return [token];
	const s0 = chars.slice(0, 2).join("");
	const s3 = chars.slice(3, 5).join("");
	if (maxEdits === 1 || chars.length < 8) {
		return s0 === s3 ? [s0] : [s0, s3];
	}
	const s6 = chars.slice(6, 8).join("");
	return [...new Set([s0, s3, s6])];
}

/** Exact mirror of `themeQualifiesDirect` in `CompanyScreening.lean`. */
export function themeQualifiesDirect(flags: ThemeMatchFlags): boolean {
	return !flags.matchesTargetOnly && !flags.isAncillary && flags.matchesDirect;
}

/** Exact mirror of `themeQualifiesRelated` in `CompanyScreening.lean`. */
export function themeQualifiesRelated(flags: ThemeMatchFlags): boolean {
	return !flags.matchesTargetOnly && !flags.isAncillary && flags.matchesRelated;
}

/** Exact mirror of `classifyMembership` in `CompanyScreening.lean`. */
export function classifyCompanyMembership(
	hasSummary: boolean,
	isBlankCheck: boolean,
	terms: readonly CompanyTermMatch[],
): CompanyMembershipTier | null {
	if (terms.length === 0) return null;
	if (terms.every((t) => t.identity)) return "identity";
	if (isBlankCheck) return null;
	const anchored = (t: CompanyTermMatch) =>
		t.identity || t.directTheme || t.relatedTheme || t.sectorOrSegment;
	const satisfied = (t: CompanyTermMatch) => anchored(t) || t.activeBody;
	if (!terms.every(satisfied)) return null;
	if (hasSummary && !terms.some(anchored)) return null;
	if (terms.every((t) => t.identity || t.directTheme)) return "directTheme";
	if (terms.every((t) => t.identity || t.directTheme || t.relatedTheme)) return "relatedTheme";
	if (terms.every(anchored)) return "sectorSegment";
	return "activeFiling";
}

function hasCompatibleHeadForFuzzy(a: string, b: string): boolean {
	const cpA = Array.from(a);
	const cpB = Array.from(b);
	const a0 = cpA[0];
	const b0 = cpB[0];
	if (a0 === undefined || b0 === undefined) return false;
	if (a0 === b0) return true;
	const a1 = cpA[1];
	const b1 = cpB[1];
	return a1 !== undefined && b1 !== undefined && a0 === b1 && a1 === b0;
}

function splitWords(foldedText: string): readonly string[] {
	return foldedText.split(WORD_SPLIT_RE).filter((w) => w.length > 0);
}

/** Checks whole-token bounded match for numeric/ticker terms (`7018`, `jp:7018`, `drone25`). */
export function matchesBoundedToken(haystackFolded: string, needle: string): boolean {
	if (needle.length === 0) return false;
	let from = 0;
	while (from <= haystackFolded.length - needle.length) {
		const idx = haystackFolded.indexOf(needle, from);
		if (idx < 0) return false;
		const before = idx > 0 ? haystackFolded.charCodeAt(idx - 1) : 0;
		const afterIdx = idx + needle.length;
		const after = afterIdx < haystackFolded.length ? haystackFolded.charCodeAt(afterIdx) : 0;
		const isAsciiAlnum = (code: number) =>
			(code >= 48 && code <= 57) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
		if (!isAsciiAlnum(before) && !isAsciiAlnum(after)) return true;
		from = idx + 1;
	}
	return false;
}

/**
 * Matches a single variant phrase/word against `text` respecting script-specific boundaries:
 * - Numeric/ticker: whole-token bounded (`7018` never matches `7014` or `97018000`).
 * - ASCII phrases/words: token-boundary matched (`ship` never matches `membership`; `solar` != `polar`).
 * - Katakana: exact folded substring OR orthographic `canonicalKana` (`フイルム` <-> `フィルム`, `エレベータ` <-> `エレベーター`) OR bounded 1-edit OSA on >=5-kana tokens.
 * - CJK / mixed Japanese: exact folded substring (never edit-distance across unrelated Kanji!).
 */
export function textMatchesVariant(
	rawText: string,
	variant: string,
	allowFuzzyEdits = false,
): boolean {
	if (rawText === "" || variant === "") return false;
	const text = foldCompanySearchText(rawText);
	const v = foldCompanySearchText(variant);
	if (v === "") return false;

	if (NUMERIC_OR_TICKER_RE.test(v)) {
		return matchesBoundedToken(text, v);
	}

	// Multi-word ASCII phrase (e.g., "nuclear submarines", "ship repair"):
	if (/^[a-z][a-z0-9 -]*$/.test(v) && (v.includes(" ") || v.includes("-"))) {
		const phraseTokens = splitWords(v);
		const textTokens = splitWords(text);
		if (phraseTokens.length === 0 || textTokens.length < phraseTokens.length) return false;
		const phraseStems = phraseTokens.map(stemEnglishToken);
		const textStems = textTokens.map(stemEnglishToken);
		for (let i = 0; i <= textStems.length - phraseStems.length; i += 1) {
			let allMatch = true;
			for (let j = 0; j < phraseStems.length; j += 1) {
				if (textStems[i + j] !== phraseStems[j]) {
					allMatch = false;
					break;
				}
			}
			if (allMatch) return true;
		}
		return false;
	}

	if (ASCII_ALPHA_ONLY_RE.test(v)) {
		const qStem = stemEnglishToken(v);
		const words = splitWords(text);
		const maxEdits = allowFuzzyEdits ? fuzzyAllowedEdits("ascii", v.length) : 0;
		for (const word of words) {
			if (!ASCII_ALPHA_ONLY_RE.test(word)) continue;
			if (word === v) return true;
			const wStem = stemEnglishToken(word);
			if (wStem === qStem) return true;
			if (maxEdits > 0 && hasCompatibleHeadForFuzzy(v, word)) {
				const dRaw = boundedOsaDistance(v, word, maxEdits);
				if (dRaw !== null) return true;
				const stemEdits = fuzzyAllowedEdits("ascii", qStem.length);
				if (stemEdits > 0 && boundedOsaDistance(qStem, wStem, stemEdits) !== null) return true;
			}
		}
		return false;
	}

	if (KATAKANA_ONLY_RE.test(v)) {
		if (text.includes(v)) return true;
		const qKana = canonicalKana(v);
		const qLen = Array.from(qKana).length;
		const maxEdits = allowFuzzyEdits ? fuzzyAllowedEdits("katakana", Array.from(v).length) : 0;
		const runs = text.match(/[\u30a0-\u30ff]+/gu) ?? [];
		for (const run of runs) {
			const rKana = canonicalKana(run);
			if (rKana === qKana) return true;
			if (qLen >= 3 && rKana.includes(qKana)) return true;
			if (maxEdits > 0 && hasCompatibleHeadForFuzzy(qKana, rKana)) {
				if (boundedOsaDistance(qKana, rKana, maxEdits) !== null) return true;
			}
		}
		return false;
	}

	return text.includes(v);
}

export function textMatchesTermDirect(rawText: string, term: ParsedCompanyTerm): boolean {
	if (textMatchesVariant(rawText, term.folded, true)) return true;
	for (const variant of term.directVariants) {
		if (variant !== term.folded && textMatchesVariant(rawText, variant, false)) return true;
	}
	return false;
}

export function textMatchesTermRelated(rawText: string, term: ParsedCompanyTerm): boolean {
	for (const variant of term.relatedVariants) {
		if (textMatchesVariant(rawText, variant, false)) return true;
	}
	return false;
}

function buildSmallKanaSqlVariants(kata: string): readonly string[] {
	const variants = new Set<string>([kata]);
	let large = "";
	for (const ch of kata) large += SMALL_KANA_MAP[ch] ?? ch;
	variants.add(large);
	// Common small-kana pairs (`イ` -> `ィ`, `ヤ` -> `ャ`, `ユ` -> `ュ`, `ヨ` -> `ョ`, `ツ` -> `ッ`)
	const reversePairs: readonly [string, string][] = [
		["フイ", "フィ"],
		["ヴイ", "ヴィ"],
		["テイ", "ティ"],
		["デイ", "ディ"],
		["キヤ", "キャ"],
		["シヤ", "シャ"],
		["チヤ", "チャ"],
		["ニヤ", "ニャ"],
		["ヒヤ", "ヒャ"],
		["ミヤ", "ミャ"],
		["リヤ", "リャ"],
		["ギヤ", "ギャ"],
		["ジヤ", "ジャ"],
		["ビヤ", "ビャ"],
		["ピヤ", "ピャ"],
		["シユ", "シュ"],
		["チユ", "チュ"],
		["ジユ", "ジュ"],
		["シヨ", "ショ"],
		["チヨ", "チョ"],
		["ジヨ", "ジョ"],
		["バツ", "バッ"],
		["ネツ", "ネッ"],
		["ウエ", "ウェ"],
	];
	for (const base of [...variants]) {
		for (const [from, to] of reversePairs) {
			if (base.includes(from)) variants.add(base.replaceAll(from, to));
			if (base.includes(to)) variants.add(base.replaceAll(to, from));
		}
		if (Array.from(base).length >= 3) {
			if (base.endsWith("ー")) variants.add(base.slice(0, -1));
			else variants.add(`${base}ー`);
		}
	}
	return [...variants];
}

function compactSqlNeedles(needles: ReadonlySet<string>): readonly string[] {
	const raw = [...needles].filter((n) => n.length > 0);
	const substringRoots = raw
		.filter((n) => !NUMERIC_OR_TICKER_RE.test(n) && Array.from(n).length >= 2)
		.sort((a, b) => a.length - b.length);
	const kept: string[] = [];
	for (const candidate of raw) {
		if (NUMERIC_OR_TICKER_RE.test(candidate) || Array.from(candidate).length < 2) {
			kept.push(candidate);
			continue;
		}
		const covered = substringRoots.some(
			(root) => root !== candidate && root.length < candidate.length && candidate.includes(root),
		);
		if (!covered) kept.push(candidate);
	}
	return kept;
}

function parseSingleCompanyTerm(rawTerm: string): ParsedCompanyTerm {
	const cleaned = rawTerm.replace(/^日本の(?=[\p{Script=Han}\u30a0-\u30ff])/u, "");
	const folded = foldCompanySearchText(cleaned.length > 0 ? cleaned : rawTerm);
	const kind = classifyCompanyTokenKind(folded);
	const stem = kind === "ascii" ? stemEnglishToken(folded) : folded;
	const kanaKey = kind === "katakana" ? canonicalKana(folded) : folded;
	const codePointLength = Array.from(folded).length;
	const allowedEdits = fuzzyAllowedEdits(kind, codePointLength);

	const directSet = new Set<string>([folded]);
	const relatedSet = new Set<string>();
	if (stem !== folded) directSet.add(stem);

	const sqlNeedles = new Set<string>([folded]);
	if (stem !== folded) sqlNeedles.add(stem);
	if (KATAKANA_ONLY_RE.test(folded)) {
		for (const kv of buildSmallKanaSqlVariants(folded)) sqlNeedles.add(kv);
	}

	for (const synset of CONCEPT_SYNSETS) {
		const triggered = synset.triggers.some((trigger) => {
			if (trigger === folded || trigger === stem) return true;
			if (
				kind === "ascii" &&
				allowedEdits > 0 &&
				ASCII_ALPHA_ONLY_RE.test(trigger) &&
				hasCompatibleHeadForFuzzy(folded, trigger) &&
				boundedOsaDistance(folded, trigger, allowedEdits) !== null
			) {
				return true;
			}
			if (kind === "katakana" && KATAKANA_ONLY_RE.test(trigger)) {
				return canonicalKana(trigger) === kanaKey;
			}
			return false;
		});
		if (triggered) {
			for (const d of synset.direct) directSet.add(foldCompanySearchText(d));
			for (const r of synset.related) relatedSet.add(foldCompanySearchText(r));
			for (const root of synset.sqlRoots) sqlNeedles.add(foldCompanySearchText(root));
		}
	}

	const fuzzySlices = new Set<string>();
	if (allowedEdits > 0) {
		for (const slice of prefilterSlices(folded, allowedEdits)) {
			if (slice.length >= 2) fuzzySlices.add(slice);
		}
		if (kind === "katakana") {
			for (const kv of buildSmallKanaSqlVariants(folded)) {
				for (const slice of prefilterSlices(kv, allowedEdits)) {
					if (slice.length >= 2) fuzzySlices.add(slice);
				}
			}
		}
	}

	return {
		raw: rawTerm,
		folded,
		kind,
		stem,
		kanaKey,
		allowedEdits,
		directVariants: [...directSet],
		relatedVariants: [...relatedSet],
		sqlNeedles: compactSqlNeedles(sqlNeedles),
		fuzzySqlSlices: [...fuzzySlices],
	};
}

/**
 * Parses a company search query into optional market filter (`JP` / `US`), SPAC intent flag,
 * and normalized/expanded content terms.
 */
export function parseCompanySearchQuery(rawQuery: string): ParsedCompanyQuery {
	const normalized = foldSqlQueryText(rawQuery);
	const rawTokens = normalized.split(/\s+/u).filter((t) => t.length > 0);
	if (rawTokens.length === 0) {
		return { marketFilter: null, queriesBlankCheck: false, terms: [], rawTerms: [] };
	}

	let marketFilter: "JP" | "US" | null = null;
	const contentTokens: string[] = [];

	for (const token of rawTokens) {
		if (rawTokens.length > 1 && MARKET_QUALIFIERS_JP.has(token)) {
			marketFilter = "JP";
			continue;
		}
		if (rawTokens.length > 1 && MARKET_QUALIFIERS_US.has(token)) {
			marketFilter = "US";
			continue;
		}
		if (token.startsWith("日本の") && Array.from(token).length > 3) {
			marketFilter = "JP";
			contentTokens.push(token.slice(3));
			continue;
		}
		if (token.startsWith("米国の") && Array.from(token).length > 3) {
			marketFilter = "US";
			contentTokens.push(token.slice(3));
			continue;
		}
		const prefixed = token.match(/^(jp|us):([0-9a-z.-]+)$/);
		if (prefixed?.[1] !== undefined && prefixed[2] !== undefined) {
			marketFilter = prefixed[1] === "jp" ? "JP" : "US";
			contentTokens.push(prefixed[2]);
			continue;
		}
		contentTokens.push(token);
	}

	const effectiveTokens = contentTokens.length > 0 ? contentTokens : rawTokens;
	const terms = effectiveTokens.map(parseSingleCompanyTerm);
	const joined = normalized;
	const queriesBlankCheck =
		matchesBoundedToken(joined, "spac") ||
		joined.includes("blank check") ||
		joined.includes("blank-check") ||
		joined.includes("特別買収目的会社");

	return {
		marketFilter,
		queriesBlankCheck,
		terms,
		rawTerms: rawTokens,
	};
}

function anyTermMatchesPart(part: string, allTerms: readonly ParsedCompanyTerm[]): boolean {
	return allTerms.some(
		(term) => textMatchesTermDirect(part, term) || textMatchesTermRelated(part, term),
	);
}

function isDefenseExempt(term: ParsedCompanyTerm): boolean {
	return (
		DEFENSE_EXEMPT_TERMS.has(term.folded) ||
		term.directVariants.some((v) => DEFENSE_EXEMPT_TERMS.has(v))
	);
}

/**
 * Evaluates a `[en, ja]` theme pair against `term`, detecting customer-targeted (`向け`, `用`, `for`)
 * and ancillary service/material themes (`融資`, `貸渡業`, `部品`, `塗料`, `financing`, `leasing`, ...).
 */
export function evaluateThemeAgainstTerm(
	theme: ThemeName,
	term: ParsedCompanyTerm,
	allQueryTerms: readonly ParsedCompanyTerm[],
): ThemeMatchFlags {
	const matchesDirect =
		textMatchesTermDirect(theme.ja, term) || textMatchesTermDirect(theme.en, term);
	const matchesRelated =
		!matchesDirect &&
		(textMatchesTermRelated(theme.ja, term) || textMatchesTermRelated(theme.en, term));

	if (!matchesDirect && !matchesRelated) {
		return {
			matchesTargetOnly: false,
			isAncillary: false,
			matchesDirect: false,
			matchesRelated: false,
		};
	}

	if (isDefenseExempt(term)) {
		return {
			matchesTargetOnly: false,
			isAncillary: false,
			matchesDirect,
			matchesRelated,
		};
	}

	let matchesTargetOnly = false;

	// 1. `<Target>向け<Head>` in Japanese (`造船向け機械`, `半導体向け真空配管`, `介護事業者向けクラウド`)
	const mukeIdx = theme.ja.indexOf("向け");
	if (mukeIdx > 0) {
		const targetPart = theme.ja.slice(0, mukeIdx);
		const headPart = theme.ja.slice(mukeIdx + 2);
		const termHitsTarget =
			textMatchesTermDirect(targetPart, term) || textMatchesTermRelated(targetPart, term);
		const queryHitsHead = headPart.length > 0 && anyTermMatchesPart(headPart, allQueryTerms);
		if (termHitsTarget && !queryHitsHead) {
			matchesTargetOnly = true;
		}
	}

	// 2. `<Target>用<Head>` in Japanese (`船舶用スクリュー合金`, `船舶用大型エンジン`, `潜水艦用原子炉`)
	if (!matchesTargetOnly) {
		const yoIdx = theme.ja.indexOf("用");
		if (yoIdx > 0 && yoIdx < theme.ja.length - 1) {
			const targetPart = theme.ja.slice(0, yoIdx);
			const headPart = theme.ja.slice(yoIdx + 1);
			const singlePrefix =
				Array.from(targetPart).length === 1 && NON_TARGET_YO_PREFIXES.has(targetPart);
			const startsWithUtensilWord = headPart.startsWith("品") || headPart.startsWith("具");
			if (!singlePrefix && !startsWithUtensilWord) {
				const termHitsTarget =
					textMatchesTermDirect(targetPart, term) || textMatchesTermRelated(targetPart, term);
				const queryHitsHead = anyTermMatchesPart(headPart, allQueryTerms);
				if (termHitsTarget && !queryHitsHead) {
					matchesTargetOnly = true;
				}
			}
		}
	}

	// 3. `<Head> for <Target>` in English (`Piping for Semiconductors`, `Financing for Ships`)
	if (!matchesTargetOnly) {
		const enLower = foldCompanySearchText(theme.en);
		const forIdx = enLower.indexOf(" for ");
		if (forIdx > 0) {
			const headPart = enLower.slice(0, forIdx);
			const targetPart = enLower.slice(forIdx + 5);
			const termHitsTarget =
				textMatchesTermDirect(targetPart, term) || textMatchesTermRelated(targetPart, term);
			const queryHitsHead = anyTermMatchesPart(headPart, allQueryTerms);
			if (termHitsTarget && !queryHitsHead) {
				matchesTargetOnly = true;
			}
		}
	}

	// 4. Ancillary finance / leasing / agency / coatings / parts suffixes
	let isAncillary = false;
	const jaFolded = foldCompanySearchText(theme.ja);
	for (const suffix of ANCILLARY_JA_SUFFIXES) {
		if (jaFolded.endsWith(suffix) && jaFolded.length > suffix.length) {
			if (!anyTermMatchesPart(suffix, allQueryTerms)) {
				isAncillary = true;
				break;
			}
		}
	}
	// Match standalone katakana `ローン` (`船舶ローン`) without colliding with `ドローン` or `クローン`:
	if (
		!isAncillary &&
		/(?<![\u30a0-\u30ff])ローン$/u.test(jaFolded) &&
		jaFolded.length > 3 &&
		!anyTermMatchesPart("ローン", allQueryTerms)
	) {
		isAncillary = true;
	}
	if (!isAncillary) {
		const enWords = splitWords(foldCompanySearchText(theme.en));
		const lastWord = enWords[enWords.length - 1];
		if (
			lastWord !== undefined &&
			enWords.length >= 2 &&
			(ANCILLARY_EN_HEADS as readonly string[]).includes(lastWord) &&
			!anyTermMatchesPart(lastWord, allQueryTerms)
		) {
			isAncillary = true;
		}
	}

	// Also reject `<Shipbuilding> Machinery` when paired with `造船向け機械` or ending in `machinery` for `shipbuilding`
	if (!isAncillary && !matchesTargetOnly) {
		const enWords = splitWords(foldCompanySearchText(theme.en));
		const lastWord = enWords[enWords.length - 1];
		if (
			lastWord === "machinery" &&
			enWords.length >= 2 &&
			(term.folded === "造船" || term.stem === "shipbuild") &&
			!anyTermMatchesPart("machinery 機械", allQueryTerms)
		) {
			isAncillary = true;
		}
	}

	return {
		matchesTargetOnly,
		isAncillary,
		matchesDirect,
		matchesRelated,
	};
}

/** True when stored text identifies a blank-check SPAC without operating business. */
export function isBlankCheckCompany(text: string): boolean {
	if (text === "") return false;
	const folded = foldCompanySearchText(text);
	for (const pattern of BLANK_CHECK_PATTERNS) {
		if (folded.includes(pattern)) return true;
	}
	if (
		matchesBoundedToken(folded, "spac") &&
		(folded.includes("merger") ||
			folded.includes("acquisition") ||
			folded.includes("business combination") ||
			folded.includes("買収対象") ||
			folded.includes("企業結合"))
	) {
		return true;
	}
	return false;
}

/** True when a sentence describes only a divested business, historical spin-off, or customer list. */
export function isDivestedOrCustomerOnlySentence(sentence: string): boolean {
	const folded = foldCompanySearchText(sentence);
	for (const marker of DIVESTED_OR_CUSTOMER_MARKERS) {
		if (folded.includes(marker)) return true;
	}
	return false;
}

/**
 * True when `bodyText` contains at least one active (non-divested, non-customer-only) sentence
 * matching `term`.
 */
export function hasActiveBodyMatch(bodyText: string, term: ParsedCompanyTerm): boolean {
	if (bodyText === "") return false;
	const sentences = bodyText.split(SENTENCE_SPLIT_RE);
	for (const sentence of sentences) {
		const trimmed = sentence.trim();
		if (trimmed === "") continue;
		if (textMatchesTermDirect(trimmed, term) || textMatchesTermRelated(trimmed, term)) {
			if (!isDivestedOrCustomerOnlySentence(trimmed)) return true;
		}
	}
	return false;
}

function segmentQualifies(
	segment: ThemeName,
	term: ParsedCompanyTerm,
	allTerms: readonly ParsedCompanyTerm[],
): boolean {
	const flags = evaluateThemeAgainstTerm(segment, term, allTerms);
	return themeQualifiesDirect(flags) || themeQualifiesRelated(flags);
}

/**
 * Evaluates a candidate company row against a parsed company query.
 * Returns `null` when the company is excluded, or `{ tier, rank }` when verified.
 */
export function evaluateCompanyCandidate(
	candidate: CompanyCandidateInput,
	query: ParsedCompanyQuery,
): CompanyCandidateEvaluation | null {
	if (query.marketFilter !== null && candidate.market !== query.marketFilter) {
		return null;
	}
	if (query.terms.length === 0) return null;

	const identityText = `${candidate.market}:${candidate.symbol} ${candidate.symbol} ${candidate.localName ?? ""} ${candidate.name ?? ""}`;
	const sectorText = `${candidate.sector17Name ?? ""} ${candidate.sector33Name ?? ""}`.trim();
	const blankCheck = !query.queriesBlankCheck && isBlankCheckCompany(candidate.bodyText);

	// For individual filing paragraphs (`documentText !== undefined`), every query term must also
	// appear in that specific document's title or paragraph text (so unrelated 10-K paragraphs don't match).
	if (candidate.documentText !== undefined) {
		for (const term of query.terms) {
			const inDoc =
				textMatchesTermDirect(candidate.documentText, term) ||
				textMatchesTermRelated(candidate.documentText, term);
			if (!inDoc) return null;
		}
	}

	const termMatches: CompanyTermMatch[] = query.terms.map((term) => {
		const isShipbuildingConcept = term.folded === "造船" || term.stem === "shipbuild";
		const isShippingSector = candidate.sector33Name === "海運業";

		// Identity matches direct variants / stem / kana / bounded fuzzy on symbol & company names
		// (never broad domain related terms, so `川崎重工業` stays Tier 2 via `潜水艦建造` for `造船`).
		const identity =
			textMatchesVariant(identityText, term.folded, true) ||
			(term.kind !== "numericOrTicker" &&
				term.directVariants.some(
					(v) => v !== term.folded && textMatchesVariant(identityText, v, false),
				));

		let directTheme = false;
		let relatedTheme = false;
		for (const theme of candidate.themes) {
			const flags = evaluateThemeAgainstTerm(theme, term, query.terms);
			if (themeQualifiesDirect(flags)) directTheme = true;
			// Shipping lines (`海運業`) operating vessels do not qualify via related vessel themes on a shipbuilding screen.
			if (!isShipbuildingConcept || !isShippingSector) {
				if (themeQualifiesRelated(flags)) relatedTheme = true;
			}
		}

		const matchesSector =
			sectorText !== "" &&
			(textMatchesTermDirect(sectorText, term) || textMatchesTermRelated(sectorText, term));
		const matchesSegment = candidate.segmentNames.some((seg) =>
			segmentQualifies(seg, term, query.terms),
		);
		const sectorOrSegment = matchesSector || matchesSegment;

		const activeBody = hasActiveBodyMatch(candidate.bodyText, term);

		return {
			identity,
			directTheme,
			relatedTheme,
			sectorOrSegment,
			activeBody,
		};
	});

	const tier = classifyCompanyMembership(candidate.hasSummary, blankCheck, termMatches);
	if (tier === null) return null;
	return {
		tier,
		rank: COMPANY_MEMBERSHIP_TIER_RANK[tier],
		hasIdentityTerm: termMatches.some((match) => match.identity),
	};
}
