import {
	boundedOsaDistance,
	canonicalKana,
	classifyCompanyMembership,
	classifyCompanyTokenKind,
	evaluateCompanyCandidate,
	evaluateThemeAgainstTerm,
	foldCompanySearchText,
	fuzzyAllowedEdits,
	hasActiveBodyMatch,
	isBlankCheckCompany,
	matchesBoundedToken,
	parseCompanySearchQuery,
	prefilterSlices,
	stemEnglishToken,
	textMatchesVariant,
} from "@research/domain";
import { describe, expect, it } from "vitest";

describe("companyScreening fuzzy matching & normalization", () => {
	it("normalizes full-width ASCII, half-width katakana, and standalone hiragana without corrupting Kanji+okurigana", () => {
		expect(foldCompanySearchText("  ７０１８　ＳＯＬＡＲ  ")).toBe("7018 solar");
		expect(foldCompanySearchText("ﾄﾞﾛｰﾝ")).toBe("ドローン");
		expect(foldCompanySearchText("どろーん")).toBe("ドローン");
		expect(foldCompanySearchText("きやのん")).toBe("キヤノン");
		expect(foldCompanySearchText("目立った事業を持たない")).toBe("目立った事業を持たない");
		expect(foldCompanySearchText("造船向け機械")).toBe("造船向け機械");
	});

	it("canonicalizes small katakana and prolonged sound marks on >=3-kana words without collapsing 2-char words", () => {
		expect(canonicalKana("フイルム")).toBe(canonicalKana("フィルム"));
		expect(canonicalKana("キヤノン")).toBe(canonicalKana("キャノン"));
		expect(canonicalKana("シヤープ")).toBe(canonicalKana("シャープ"));
		expect(canonicalKana("エレベータ")).toBe(canonicalKana("エレベーター"));
		expect(canonicalKana("ボイラ")).toBe(canonicalKana("ボイラー"));
		expect(canonicalKana("モータ")).toBe(canonicalKana("モーター"));
		expect(canonicalKana("バルクキャリア")).toBe(canonicalKana("バルクキャリアー"));
		expect(canonicalKana("カー")).toBe("カー");
		expect(textMatchesVariant("富士フイルムホールディングス", "フィルム", true)).toBe(true);
		expect(textMatchesVariant("キヤノンマーケティング", "キャノン", true)).toBe(true);
		expect(textMatchesVariant("建設工事用エレベーター", "エレベータ", true)).toBe(true);
	});

	it("stems plurals and -building/-builder safely without conflating shipping/ship or server/tanker/power", () => {
		expect(stemEnglishToken("shipbuilding")).toBe("shipbuild");
		expect(stemEnglishToken("shipbuilder")).toBe("shipbuild");
		expect(stemEnglishToken("shipbuilders")).toBe("shipbuild");
		expect(stemEnglishToken("newbuilding")).toBe("newbuild");
		expect(stemEnglishToken("batteries")).toBe("battery");
		expect(stemEnglishToken("drones")).toBe("drone");
		expect(stemEnglishToken("semiconductors")).toBe("semiconductor");
		expect(stemEnglishToken("shipping")).toBe("shipping");
		expect(stemEnglishToken("shipping")).not.toBe(stemEnglishToken("shipbuilding"));
		expect(stemEnglishToken("server")).toBe("server");
		expect(stemEnglishToken("tanker")).toBe("tanker");
		expect(stemEnglishToken("carrier")).toBe("carrier");
		expect(stemEnglishToken("power")).toBe("power");
	});

	it("computes bounded OSA edit distance including adjacent transpositions and enforces script/length guards", () => {
		expect(boundedOsaDistance("shipbuiding", "shipbuilding", 2)).toBe(1);
		expect(boundedOsaDistance("hsipbuilding", "shipbuilding", 2)).toBe(1);
		expect(boundedOsaDistance("semicondutor", "semiconductor", 2)).toBe(1);
		expect(boundedOsaDistance("cybersecurty", "cybersecurity", 2)).toBe(1);
		expect(boundedOsaDistance("sollar", "solar", 1)).toBe(1);
		expect(boundedOsaDistance("shipbuilding", "nonexistent", 2)).toBeNull();

		expect(classifyCompanyTokenKind("7018")).toBe("numericOrTicker");
		expect(classifyCompanyTokenKind("jp:7018")).toBe("numericOrTicker");
		expect(classifyCompanyTokenKind("drone25")).toBe("numericOrTicker");
		expect(classifyCompanyTokenKind("造船")).toBe("cjk");
		expect(classifyCompanyTokenKind("ドローン")).toBe("katakana");
		expect(classifyCompanyTokenKind("shipbuilding")).toBe("ascii");

		expect(fuzzyAllowedEdits("numericOrTicker", 10)).toBe(0);
		expect(fuzzyAllowedEdits("cjk", 6)).toBe(0);
		expect(fuzzyAllowedEdits("ascii", 4)).toBe(0);
		expect(fuzzyAllowedEdits("ascii", 6)).toBe(1);
		expect(fuzzyAllowedEdits("ascii", 9)).toBe(2);
		expect(fuzzyAllowedEdits("katakana", 4)).toBe(0);
		expect(fuzzyAllowedEdits("katakana", 6)).toBe(1);
	});

	it("prevents CJK 1-char collisions, English rhyme collisions, suffix collisions, and numeric partial matches", () => {
		// CJK 1-char near-misses MUST NOT match
		expect(textMatchesVariant("日本造園建設", "造船", true)).toBe(false);
		expect(textMatchesVariant("合成酒造", "造船", true)).toBe(false);
		expect(textMatchesVariant("合成鋳造", "造船", true)).toBe(false);
		expect(textMatchesVariant("商船三井", "造船", true)).toBe(false);

		// English suffix and rhyme near-misses MUST NOT match
		expect(textMatchesVariant("Resorttrust Membership Club", "ship", true)).toBe(false);
		expect(textMatchesVariant("Global Leadership Partners", "ship", true)).toBe(false);
		expect(textMatchesVariant("Polar Bear Cooling", "solar", true)).toBe(false);
		expect(textMatchesVariant("Cell Tower Infrastructure", "power", true)).toBe(false);
		expect(textMatchesVariant("Grain Storage Corp", "train", true)).toBe(false);

		// Typos and transpositions on >=5-char tokens DO match
		expect(textMatchesVariant("Namura Shipbuilding Co., Ltd.", "shipbuiding", true)).toBe(true);
		expect(textMatchesVariant("Namura Shipbuilding Co., Ltd.", "hsipbuilding", true)).toBe(true);
		expect(textMatchesVariant("Analog Semiconductors", "semicondutor", true)).toBe(true);

		// Numeric/ticker boundary checks
		expect(matchesBoundedToken("jp:7018 synthetic zosen", "7018")).toBe(true);
		expect(matchesBoundedToken("jp:7014 namura", "7018")).toBe(false);
		expect(matchesBoundedToken("value=97018000", "7018")).toBe(false);
	});

	it("preserves at least one pigeonhole 2-gram slice for every valid 1-edit and 2-edit variation", () => {
		const word1 = "battery";
		const slices1 = prefilterSlices(word1, 1);
		for (const edited of ["batery", "batttery", "batxery", "btatery", "abattery"]) {
			expect(boundedOsaDistance(word1, edited, 1)).not.toBeNull();
			expect(slices1.some((s) => edited.includes(s))).toBe(true);
		}

		const word2 = "shipbuilding";
		const slices2 = prefilterSlices(word2, 2);
		for (const edited of [
			"shipbuiding",
			"hsipbuilding",
			"shibpuiding",
			"xhipyuilding",
			"shipbulidng",
		]) {
			const dist = boundedOsaDistance(word2, edited, 2);
			if (dist !== null) {
				expect(slices2.some((s) => edited.includes(s))).toBe(true);
			}
		}
	});
});

describe("companyScreening theme/sector membership & false-positive exclusion", () => {
	it("parses market qualifiers and bilingual synsets cleanly", () => {
		const jpShip = parseCompanySearchQuery("日本 造船");
		expect(jpShip.marketFilter).toBe("JP");
		expect(jpShip.terms).toHaveLength(1);
		expect(jpShip.terms[0]?.folded).toBe("造船");

		const jpPossessive = parseCompanySearchQuery("日本の造船");
		expect(jpPossessive.marketFilter).toBe("JP");
		expect(jpPossessive.terms[0]?.folded).toBe("造船");

		const usShip = parseCompanySearchQuery("US shipbuilders");
		expect(usShip.marketFilter).toBe("US");
		expect(usShip.terms[0]?.stem).toBe("shipbuild");
	});

	it("excludes customer-targeted (`向け`, `用`, `for`) and ancillary themes while keeping genuine product/head matches", () => {
		const shipQuery = parseCompanySearchQuery("造船");
		const shipTerm = shipQuery.terms[0];
		if (!shipTerm) throw new Error("expected shipTerm");

		// Excluded customer/ancillary themes for `造船`:
		for (const falseTheme of [
			{ en: "Shipbuilding Machinery", ja: "造船向け機械" },
			{ en: "Marine Propeller Alloys", ja: "船舶用スクリュー合金" },
			{ en: "Marine Coatings", ja: "船舶用防汚塗料" },
			{ en: "Ship Financing", ja: "船舶融資" },
			{ en: "Ship Leasing", ja: "船舶貸渡業" },
			{ en: "Submarine Components", ja: "潜水艦部品" },
			{ en: "Submarine Nuclear Reactors", ja: "潜水艦用原子炉" },
			{ en: "Submarine Cable", ja: "海底ケーブル" },
		]) {
			const flags = evaluateThemeAgainstTerm(falseTheme, shipTerm, shipQuery.terms);
			expect(
				!flags.matchesTargetOnly &&
					!flags.isAncillary &&
					(flags.matchesDirect || flags.matchesRelated),
				`Expected ${falseTheme.ja} to be excluded for 造船`,
			).toBe(false);
		}

		// Included genuine shipbuilder themes for `造船`:
		for (const trueTheme of [
			{ en: "Shipbuilding", ja: "造船" },
			{ en: "Tanker and Bulk Carrier Newbuilding", ja: "タンカー・バルカー新造船" },
			{ en: "Ship Repair", ja: "船舶修繕" },
			{ en: "Submarine Construction", ja: "潜水艦建造" },
			{ en: "Conventional Submarines", ja: "通常動力型潜水艦" },
			{ en: "Nuclear Aircraft Carriers", ja: "原子力空母" },
		]) {
			const flags = evaluateThemeAgainstTerm(trueTheme, shipTerm, shipQuery.terms);
			expect(
				!flags.matchesTargetOnly &&
					!flags.isAncillary &&
					(flags.matchesDirect || flags.matchesRelated),
				`Expected ${trueTheme.ja} to qualify for 造船`,
			).toBe(true);
		}

		// Head-noun queries (`産業用ドローン` for `ドローン`, `車載用蓄電池` for `蓄電池`, `防衛向け航空機` for `防衛`) MUST qualify:
		const droneQuery = parseCompanySearchQuery("ドローン");
		const droneTerm = droneQuery.terms[0];
		if (!droneTerm) throw new Error("expected droneTerm");
		expect(
			evaluateThemeAgainstTerm(
				{ en: "Industrial Drones", ja: "産業用ドローン" },
				droneTerm,
				droneQuery.terms,
			),
		).toMatchObject({ matchesTargetOnly: false, isAncillary: false, matchesDirect: true });

		const defenseQuery = parseCompanySearchQuery("防衛");
		const defenseTerm = defenseQuery.terms[0];
		if (!defenseTerm) throw new Error("expected defenseTerm");
		expect(
			evaluateThemeAgainstTerm(
				{ en: "Military Aircraft", ja: "防衛向け航空機" },
				defenseTerm,
				defenseQuery.terms,
			),
		).toMatchObject({ matchesTargetOnly: false, isAncillary: false, matchesDirect: true });
	});

	it("excludes divested businesses, historical spin-offs, customer lists, and blank-check SPACs in evaluateCompanyCandidate", () => {
		const shipQuery = parseCompanySearchQuery("造船");

		// 1. Divested shipbuilder (Sanoyas-like JP:7022)
		expect(
			evaluateCompanyCandidate(
				{
					market: "JP",
					symbol: "7022",
					name: "Sanoyas Holdings Corporation",
					localName: "サノヤスホールディングス",
					hasSummary: true,
					themes: [
						{ en: "Mechanical Parking Systems", ja: "機械式駐車装置" },
						{ en: "Amusement Park Rides", ja: "遊園地遊戯機械" },
					],
					sector17Name: "機械",
					sector33Name: "機械",
					segmentNames: [{ en: "Leisure", ja: "レジャー" }],
					bodyText: "2021年に造船事業を譲渡。機械式駐車装置や遊園地遊戯機械を手掛ける。",
				},
				shipQuery,
			),
		).toBeNull();

		// 2. Customer-targeted machinery maker (Nitchitsu-like JP:7021)
		expect(
			evaluateCompanyCandidate(
				{
					market: "JP",
					symbol: "7021",
					name: "NITCHITSU CO.,LTD.",
					localName: "ニッチツ",
					hasSummary: true,
					themes: [{ en: "Shipbuilding Machinery", ja: "造船向け機械" }],
					sector17Name: "機械",
					sector33Name: "機械",
					segmentNames: [{ en: "Machinery-related Business", ja: "機械関連事業" }],
					bodyText: "主要顧客は国内造船所。",
				},
				shipQuery,
			),
		).toBeNull();

		// 3. Historical spin-off shipping line (Kawasaki Kisen-like JP:9107)
		expect(
			evaluateCompanyCandidate(
				{
					market: "JP",
					symbol: "9107",
					name: "Kawasaki Kisen Kaisha,Ltd.",
					localName: "川崎汽船",
					hasSummary: true,
					themes: [
						{ en: "Offshore Wind Support Vessels", ja: "洋上風力支援船" },
						{ en: "Liquefied CO2 Carriers", ja: "液化CO2輸送船" },
					],
					sector17Name: "運輸・物流",
					sector33Name: "海運業",
					segmentNames: [{ en: "Dry Bulk", ja: "ドライバルク" }],
					bodyText: "1919年に株式会社川崎造船所の船舶部の現物出資により当社設立。",
				},
				shipQuery,
			),
		).toBeNull();

		// 4. Blank-check SPAC targeting shipbuilding (KEYY-like)
		const spacBody =
			"Blank check company with no significant operations, formed to effect a merger. ケイマン諸島設立のSPAC。買収対象として造船や半導体を掲げる。";
		expect(isBlankCheckCompany(spacBody)).toBe(true);
		expect(
			evaluateCompanyCandidate(
				{
					market: "US",
					symbol: "KEYY",
					name: "Keystone Acquisition Corp.",
					localName: null,
					hasSummary: true,
					themes: [
						{ en: "Shipbuilding and Maritime Engineering", ja: "造船・海事エンジニアリング" },
					],
					sector17Name: null,
					sector33Name: null,
					segmentNames: [],
					bodyText: spacBody,
				},
				shipQuery,
			),
		).toBeNull();
		// Direct ticker lookup on the SPAC still finds it via Tier 0 identity:
		expect(
			evaluateCompanyCandidate(
				{
					market: "US",
					symbol: "KEYY",
					name: "Keystone Acquisition Corp.",
					localName: null,
					hasSummary: true,
					themes: [
						{ en: "Shipbuilding and Maritime Engineering", ja: "造船・海事エンジニアリング" },
					],
					sector17Name: null,
					sector33Name: null,
					segmentNames: [],
					bodyText: spacBody,
				},
				parseCompanySearchQuery("KEYY"),
			),
		).toEqual({ tier: "identity", rank: 0, hasIdentityTerm: true });

		// 5. Unsummarized SEC filing with divested shipbuilding business (Northrop-like)
		const nocParagraph =
			"Huntington Ingalls Industries, Inc. (HII), the current operator of our former shipbuilding business, provides naval vessels.";
		const firstShipTerm = shipQuery.terms[0];
		if (firstShipTerm === undefined) throw new Error("expected parsed ship term");
		expect(hasActiveBodyMatch(nocParagraph, firstShipTerm)).toBe(false);
		expect(
			evaluateCompanyCandidate(
				{
					market: "US",
					symbol: "NOC",
					name: "NORTHROP GRUMMAN CORP",
					localName: null,
					hasSummary: false,
					themes: [],
					sector17Name: null,
					sector33Name: null,
					segmentNames: [],
					bodyText: nocParagraph,
				},
				parseCompanySearchQuery("shipbuilding"),
			),
		).toBeNull();

		// 6. Genuine shipbuilders rank deterministically: identity (0) < directTheme (1) < relatedTheme (2)
		const naikai = evaluateCompanyCandidate(
			{
				market: "JP",
				symbol: "7018",
				name: "Naikai Zosen Corporation",
				localName: "内海造船",
				hasSummary: true,
				themes: [
					{ en: "RORO Cargo Ships", ja: "RORO船" },
					{ en: "Ship Repair", ja: "船舶修繕" },
				],
				sector17Name: "自動車・輸送機",
				sector33Name: "輸送用機器",
				segmentNames: [{ en: "Shipbuilding", ja: "船舶事業" }],
				bodyText: "広島県尾道市の2工場で船を建造。",
			},
			shipQuery,
		);
		const pureThemeShipbuilder = evaluateCompanyCandidate(
			{
				market: "JP",
				symbol: "7003",
				name: "Synthetic Marine Engineering",
				localName: "合成マリンエンジニアリング",
				hasSummary: true,
				themes: [{ en: "Shipbuilding", ja: "造船" }],
				sector17Name: "機械",
				sector33Name: "機械",
				segmentNames: [],
				bodyText: "船舶を建造。",
			},
			shipQuery,
		);
		const kawasakiHeavy = evaluateCompanyCandidate(
			{
				market: "JP",
				symbol: "7012",
				name: "Kawasaki Heavy Industries,Ltd.",
				localName: "川崎重工業",
				hasSummary: true,
				themes: [{ en: "Submarine Construction", ja: "潜水艦建造" }],
				sector17Name: "自動車・輸送機",
				sector33Name: "輸送用機器",
				segmentNames: [{ en: "Aerospace Systems", ja: "航空宇宙システム事業" }],
				bodyText: "潜水艦や鉄道車両を製造。",
			},
			shipQuery,
		);

		expect(naikai).toEqual({ tier: "identity", rank: 0, hasIdentityTerm: true });
		expect(pureThemeShipbuilder).toEqual({
			tier: "directTheme",
			rank: 1,
			hasIdentityTerm: false,
		});
		expect(kawasakiHeavy).toEqual({
			tier: "relatedTheme",
			rank: 2,
			hasIdentityTerm: false,
		});
		expect(classifyCompanyMembership(true, false, [])).toBeNull();
	});
});
