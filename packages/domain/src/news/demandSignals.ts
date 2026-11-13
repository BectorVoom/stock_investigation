/** Heuristic reading leads, never verified demand or company attribution. */
export const DEMAND_THEMES = [
	"ai",
	"semiconductors",
	"energy",
	"mobility",
	"automation",
	"security",
	"healthcare",
	"infrastructure",
	"consumer",
	"finance",
	"materials",
	"agriculture",
	"telecom",
] as const;
export type DemandTheme = (typeof DEMAND_THEMES)[number];
export type DemandKind = "expanding" | "emerging" | "weakening" | "uncertain";
export type DemandKindFilter = DemandKind | "all" | "coverage";
export interface DemandPassage {
	readonly kind: DemandKind;
	readonly text: string;
}
export interface DemandCandidate {
	readonly articleId: string;
	readonly text: string;
	readonly themes: readonly DemandTheme[];
	readonly passages: readonly DemandPassage[];
}
const THEMES: Readonly<Record<DemandTheme, RegExp>> = {
	ai: /\b(?:ai|artificial intelligence|cloud|data cent(?:er|re)s?|gpu|saas)\b|生成ai|人工知能|クラウド|データセンター/iu,
	semiconductors: /\b(?:semiconductors?|chips?|hbm|foundr(?:y|ies)|wafer)\b|半導体|チップ|ウエハ/iu,
	energy:
		/\b(?:energy|electricity|power grid|solar|wind|batter(?:y|ies)|storage|hydrogen|lng|oil|gas)\b|電力|蓄電|電池|再生可能|太陽光|水素|石油|ガス/iu,
	mobility:
		/\b(?:evs?|electric vehicles?|automotive|vehicles?|charging|transport|logistics|shipping|aviation)\b|自動車|充電|物流|海運|航空|輸送/iu,
	automation:
		/\b(?:robots?|robotics|automation|industrial|manufacturing)\b|ロボット|自動化|省人化|製造/iu,
	security:
		/\b(?:cybersecurity|cyber security|defen[cs]e|security|aerospace)\b|サイバー|セキュリティ|防衛|宇宙/iu,
	healthcare:
		/\b(?:healthcare|health care|medical|drug|pharma\w*|biotech\w*|hospital|eldercare)\b|医療|医薬|介護|創薬|病院/iu,
	infrastructure:
		/\b(?:infrastructure|construction|housing|water|cooling|hvac)\b|インフラ|建設|住宅|水処理|空調|冷却/iu,
	consumer:
		/\b(?:consumer|retail|tourism|travel|hotel|entertainment|apparel)\b|消費|小売|観光|旅行|ホテル|娯楽|衣料/iu,
	finance: /\b(?:fintech|payments?|insurance|banking|financial services)\b|決済|保険|銀行|金融/iu,
	materials:
		/\b(?:copper|lithium|steel|alumin\w*|rare earth|metals?|materials?|chemicals?)\b|銅|リチウム|鉄鋼|アルミ|レアアース|素材|化学/iu,
	agriculture:
		/\b(?:agriculture|agricultural|food|fertili[sz]er|irrigation|farming)\b|農業|食品|肥料|灌漑|食料/iu,
	telecom: /\b(?:telecom\w*|5g|6g|broadband|fiber|fibre|satellite)\b|通信|光ファイバー|衛星/iu,
};
const EXPANDING =
	/\b(?:(?:expanding|growing|rising|surging|increasing|accelerating) demand|demand (?:growth|expansion|rises|grows|surges|increases|is (?:growing|rising|expanding))|(?:orders?|sales|bookings|backlog|spending|adoption) (?:rise|rises|grow|grows|surge|surges|double[ds]?|increase[ds]?)|record orders)\b|需要(?:が|の|は)?(?:拡大|増加|急増|増大)|受注(?:が|の|は)?(?:増加|急増|拡大)|販売(?:が|の)?増加/iu;
const GROWTH_WORDING =
	/\b(?:demand|orders?|sales|bookings|backlog|spending|adoption)\b[^.!?\n]{0,80}?\b(?:rose|grew|surged|increased|expanded|doubled|rising|growing|increasing|expanding|grow|rise|increase|expand)\b|(?:需要|受注)(?:が|は|の)?(?:(?:前年比|前年同期比|前期比|で|約)|[0-9.%、\s]){0,24}(?:拡大|増加|急増|増大)/iu;
const EMERGING =
	/\b(?:(?:new|emerging|untapped) demand|demand (?:emerges|emerging)|first (?:commercial )?(?:orders?|customers?|contracts?)|new (?:applications?|use cases?|customers?))\b|新たな需要|新規需要|需要創出|初受注|初の(?:受注|商用|顧客)|新たな用途|新規顧客/iu;
const WEAKENING =
	/\b(?:(?:falling|declining|weak|weakening|slowing) demand|demand (?:falls|fell|declines|declined|slows|drops|dropped)|(?:orders?|sales|spending) (?:fall|falls|fell|decline|declines|declined|drop|drops|dropped)|order cancellations?)\b|需要(?:が|の|は)?(?:減少|減退|低迷|縮小)|受注(?:が|の|は)?(?:減少|縮小)|受注キャンセル/iu;
const NEGATED =
	/\b(?:no|not|without|isn't|isn’t|aren't|aren’t|failed to)\b.{0,45}\b(?:demand|growth|growing|rising|expanding|orders|increas\w*)\b|\b(?:demand|orders)\b.{0,35}\b(?:not|no longer)\b|需要.{0,20}(?:見られない|みられない|増えていない|拡大していない|増加していない)|(?:需要|受注).{0,12}(?:拡大|増加).{0,8}(?:否定|せず|ない)/iu;
const UNCERTAIN =
	/\b(?:forecast\w*|expect\w*|project\w*|potential|could|may|might|would|predict\w*|estimat\w*|target\w*)\b|見込|予測|期待|可能性|見通し|目指/iu;
const normalize = (text: string): string => text.normalize("NFKC").toLowerCase();

/** Precedence is conservative within a passage; other passages retain mixed evidence. */
export function demandKind(flags: {
	readonly expanding: boolean;
	readonly emerging: boolean;
	readonly weakening: boolean;
	readonly uncertain: boolean;
}): DemandKind | null {
	if (!(flags.expanding || flags.emerging || flags.weakening)) return null;
	if (flags.uncertain) return "uncertain";
	if (flags.weakening) return "weakening";
	return flags.emerging ? "emerging" : "expanding";
}
export function analyzeDemand(article: {
	readonly articleId: string;
	readonly title: string;
	readonly excerpt: string | null;
}): DemandCandidate {
	const text = normalize(`${article.title}\n${article.excerpt ?? ""}`);
	const passages: DemandPassage[] = [];
	for (const passage of `${article.title}\n${article.excerpt ?? ""}`.split(
		/\n|[。！？]|(?<=[.!?])\s+/u,
	)) {
		const original = passage.trim();
		if (!original) continue;
		const normalized = normalize(original);
		const kind = demandKind({
			expanding:
				EXPANDING.test(normalized) || GROWTH_WORDING.test(normalized) || NEGATED.test(normalized),
			emerging: EMERGING.test(normalized),
			weakening: WEAKENING.test(normalized),
			uncertain: NEGATED.test(normalized) || UNCERTAIN.test(normalized),
		});
		if (kind !== null) passages.push({ kind, text: original });
	}
	return {
		articleId: article.articleId,
		text,
		themes: DEMAND_THEMES.filter((theme) => THEMES[theme].test(text)),
		passages,
	};
}
/** Every filter is conjunctive; an unclassified theme remains discoverable in All themes. */
export function matchesDemand(
	candidate: DemandCandidate,
	filter: {
		readonly theme: DemandTheme | "all";
		readonly kind: DemandKindFilter;
		readonly query: string;
	},
): boolean {
	return (
		(filter.kind === "coverage" ||
			candidate.passages.some(
				(passage) => filter.kind === "all" || passage.kind === filter.kind,
			)) &&
		(filter.theme === "all" || candidate.themes.includes(filter.theme)) &&
		candidate.text.includes(normalize(filter.query.trim()))
	);
}
