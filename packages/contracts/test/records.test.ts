import { describe, expect, it } from "vitest";
import {
	articleSchema,
	claimIssueSchema,
	claimSchema,
	claimStatusSchema,
	claimTypeSchema,
	datasetCellSchema,
	datasetColumnSchema,
	datasetSchema,
	demandScenarioSchema,
	EXCHANGES_BY_COUNTRY,
	evidenceLinkSchema,
	evidenceRelationSchema,
	evidenceSchema,
	feedStatusSchema,
	financialMetricCodeSchema,
	financialObservationSchema,
	investorFilingSchema,
	licensePolicySchema,
	newsSourceSchema,
	positionFiguresSchema,
	positionObservationSchema,
	pricingPowerRecordSchema,
	reportedPositionChangeSchema,
	reportingPeriodSchema,
	securitySchema,
	sourceClassSchema,
	sourceTypeSchema,
	supplierLinkSchema,
	trustClassificationSchema,
} from "../src/index.ts";
import {
	article,
	availableObservation,
	claim,
	dataset,
	demandScenario,
	evidence,
	investorFiling,
	jpPosition,
	jpSecurity,
	newsSource,
	pricingPowerRecord,
	reportingPeriod,
	supplierLink,
	unavailableObservation,
	usPosition,
	usSecurity,
} from "./fixtures.ts";
import { expectAccepted, expectRejected, repeat, without } from "./support.ts";

describe("record enumerations", () => {
	// Written out independently: adding or renaming a value is a contract change.
	it.each([
		[
			"licensePolicySchema",
			licensePolicySchema,
			["headline-and-link-only", "short-excerpt-permitted"],
		],
		["sourceTypeSchema", sourceTypeSchema, ["rss", "atom", "api", "html"]],
		[
			"trustClassificationSchema",
			trustClassificationSchema,
			["official", "established-media", "trade-press", "unclassified"],
		],
		["feedStatusSchema", feedStatusSchema, ["active", "failing", "paused"]],
		[
			"sourceClassSchema",
			sourceClassSchema,
			[
				"news",
				"regulatory-filing",
				"official-statistics",
				"company-disclosure",
				"market-data",
				"other",
			],
		],
		["claimTypeSchema", claimTypeSchema, ["observation", "inference", "hypothesis", "forecast"]],
		["evidenceRelationSchema", evidenceRelationSchema, ["supports", "contradicts", "context"]],
		["claimStatusSchema", claimStatusSchema, ["supported", "unsupported", "conflicting"]],
		[
			"financialMetricCodeSchema",
			financialMetricCodeSchema,
			[
				"trailing-per",
				"forward-per",
				"net-profit-margin",
				"revenue",
				"net-income",
				"eps-diluted",
				"share-price",
			],
		],
	] as const)("%s accepts exactly its documented values", (_name, schema, values) => {
		expect([...schema.options].sort()).toEqual([...values].sort());
		for (const value of values) expectAccepted(schema, value);
		for (const value of ["", "unknown", values[0].toUpperCase(), null, 1]) {
			expectRejected(schema, value);
		}
	});
});

describe("newsSourceSchema", () => {
	it("accepts a registered source", () => {
		expectAccepted(newsSourceSchema, newsSource);
		expectAccepted(newsSourceSchema, {
			...newsSource,
			feedStatus: "failing",
			lastFetchedAt: "2026-10-11T00:00:00Z",
			lastErrorCode: "FETCH_TIMEOUT",
		});
	});

	it("rejects a non-https canonical URL", () => {
		expectRejected(
			newsSourceSchema,
			{ ...newsSource, canonicalUrl: "http://news.example.com/rss" },
			["canonicalUrl"],
		);
	});

	it("rejects unknown enum values", () => {
		expectRejected(newsSourceSchema, { ...newsSource, sourceType: "scrape" }, ["sourceType"]);
		expectRejected(newsSourceSchema, { ...newsSource, licensePolicy: "full-text" }, [
			"licensePolicy",
		]);
		expectRejected(newsSourceSchema, { ...newsSource, trustClassification: "trusted" }, [
			"trustClassification",
		]);
		expectRejected(newsSourceSchema, { ...newsSource, feedStatus: "deleted" }, ["feedStatus"]);
	});

	it("rejects missing and unknown fields", () => {
		expectRejected(newsSourceSchema, without(newsSource, "licensePolicy"), ["licensePolicy"]);
		expectRejected(newsSourceSchema, { ...newsSource, ownerId: "someone" });
	});
});

describe("articleSchema", () => {
	it("accepts an article with and without a publication date or excerpt", () => {
		expectAccepted(articleSchema, article);
		expectAccepted(articleSchema, { ...article, publishedAt: null, excerpt: "Short excerpt." });
	});

	it("requires a retrieval timestamp even when the publication date is unknown", () => {
		expectRejected(articleSchema, { ...article, retrievedAt: null }, ["retrievedAt"]);
	});

	it("requires a SHA-256 content fingerprint", () => {
		expectRejected(articleSchema, { ...article, contentFingerprint: "abc" }, [
			"contentFingerprint",
		]);
		expectRejected(articleSchema, { ...article, contentFingerprint: "A".repeat(64) }, [
			"contentFingerprint",
		]);
	});

	it("bounds the title and excerpt so articles cannot be copied wholesale", () => {
		expectAccepted(articleSchema, { ...article, title: "t".repeat(300), excerpt: "e".repeat(500) });
		expectRejected(articleSchema, { ...article, title: "t".repeat(301) }, ["title"]);
		expectRejected(articleSchema, { ...article, excerpt: "e".repeat(501) }, ["excerpt"]);
		expectRejected(articleSchema, { ...article, title: "" }, ["title"]);
	});

	it("rejects a full-text body field", () => {
		expectRejected(articleSchema, { ...article, body: "entire article text" });
	});
});

describe("evidenceSchema (DATA-002)", () => {
	it("accepts evidence with distinct published, retrieved and effective timestamps", () => {
		expectAccepted(evidenceSchema, evidence);
		expectAccepted(evidenceSchema, {
			...evidence,
			publishedAt: null,
			effectiveAt: "2026-09-30T00:00:00Z",
			excerpt: null,
			sourceClass: "regulatory-filing",
		});
	});

	it("requires each timestamp field to be present, even if null", () => {
		expectRejected(evidenceSchema, without(evidence, "publishedAt"), ["publishedAt"]);
		expectRejected(evidenceSchema, without(evidence, "effectiveAt"), ["effectiveAt"]);
		expectRejected(evidenceSchema, without(evidence, "retrievedAt"), ["retrievedAt"]);
	});

	it("rejects a non-https source URL, a bad checksum and an unknown source class", () => {
		expectRejected(evidenceSchema, { ...evidence, sourceUrl: "javascript:alert(1)" }, [
			"sourceUrl",
		]);
		expectRejected(evidenceSchema, { ...evidence, checksum: "xyz" }, ["checksum"]);
		expectRejected(evidenceSchema, { ...evidence, sourceClass: "rumour" }, ["sourceClass"]);
	});

	it("rejects a date-only timestamp", () => {
		expectRejected(evidenceSchema, { ...evidence, retrievedAt: "2026-10-11" }, ["retrievedAt"]);
	});
});

describe("claimSchema (DATA-003)", () => {
	it("accepts each claim type, status and relation", () => {
		for (const claimType of ["observation", "inference", "hypothesis", "forecast"]) {
			expectAccepted(claimSchema, { ...claim, claimType });
		}
		for (const status of ["supported", "unsupported", "conflicting"]) {
			expectAccepted(claimSchema, { ...claim, status });
		}
		for (const relation of ["supports", "contradicts", "context"]) {
			expectAccepted(evidenceLinkSchema, { evidenceId: "ev_1", relation, quote: null });
		}
	});

	it("accepts every verification issue shape", () => {
		expectAccepted(claimSchema, {
			...claim,
			status: "unsupported",
			links: [],
			issues: [
				{ code: "UNKNOWN_EVIDENCE", evidenceId: "ev_made_up" },
				{ code: "QUOTE_NOT_FOUND", evidenceId: "ev_1" },
				{ code: "MISSING_QUOTE", evidenceId: "ev_1" },
				{ code: "NUMBER_NOT_IN_EVIDENCE", numberText: "42" },
				{ code: "NO_SUPPORTING_EVIDENCE" },
			],
		});
	});

	it("rejects an unknown claim type, status, relation or issue code", () => {
		expectRejected(claimSchema, { ...claim, claimType: "fact" }, ["claimType"]);
		expectRejected(claimSchema, { ...claim, status: "verified" }, ["status"]);
		expectRejected(evidenceLinkSchema, { evidenceId: "ev_1", relation: "proves", quote: null });
		expectRejected(claimIssueSchema, { code: "LOOKS_FINE" });
	});

	it("rejects issues carrying the wrong payload for their code", () => {
		expectRejected(claimIssueSchema, { code: "UNKNOWN_EVIDENCE" });
		expectRejected(claimIssueSchema, { code: "NUMBER_NOT_IN_EVIDENCE", evidenceId: "ev_1" });
		expectRejected(claimIssueSchema, { code: "NO_SUPPORTING_EVIDENCE", evidenceId: "ev_1" });
	});

	it("requires the quote field on a link, even if null", () => {
		expectRejected(evidenceLinkSchema, { evidenceId: "ev_1", relation: "supports" }, ["quote"]);
	});

	it("bounds claim text, links and issues", () => {
		expectRejected(claimSchema, { ...claim, text: "" }, ["text"]);
		expectRejected(claimSchema, { ...claim, text: "x".repeat(1001) }, ["text"]);
		expectAccepted(claimSchema, { ...claim, links: repeat(claim.links[0], 12) });
		expectRejected(claimSchema, { ...claim, links: repeat(claim.links[0], 13) }, ["links"]);
		expectRejected(
			claimSchema,
			{ ...claim, issues: repeat({ code: "NO_SUPPORTING_EVIDENCE" }, 25) },
			["issues"],
		);
	});
});

describe("demandScenarioSchema (FR-004 / DATA-009)", () => {
	it("accepts a complete scenario", () => {
		expectAccepted(demandScenarioSchema, demandScenario);
	});

	it("accepts a scenario with no sourced baseline and null CAGRs", () => {
		expectAccepted(demandScenarioSchema, {
			...demandScenario,
			baselineValue: null,
			baselineEvidenceId: null,
			derivedCagr: { bear: null, base: null, bull: null },
		});
	});

	it("requires unit, methodology and the three scenario cases", () => {
		expectRejected(demandScenarioSchema, { ...demandScenario, unit: "" }, ["unit"]);
		expectRejected(demandScenarioSchema, { ...demandScenario, methodology: "  " }, ["methodology"]);
		expectRejected(demandScenarioSchema, without(demandScenario, "bear"), ["bear"]);
		expectRejected(demandScenarioSchema, without(demandScenario, "bull"), ["bull"]);
		expectRejected(demandScenarioSchema, without(demandScenario, "falsifiers"), ["falsifiers"]);
	});

	it("rejects an unknown quantity kind, so unit demand and revenue are never conflated", () => {
		expectRejected(demandScenarioSchema, { ...demandScenario, quantityKind: "growth" }, [
			"quantityKind",
		]);
	});

	it("rejects non-finite and non-integer numbers", () => {
		expectRejected(demandScenarioSchema, { ...demandScenario, baselineValue: Number.NaN }, [
			"baselineValue",
		]);
		expectRejected(
			demandScenarioSchema,
			{
				...demandScenario,
				base: { ...demandScenario.base, targetValue: Number.POSITIVE_INFINITY },
			},
			["base", "targetValue"],
		);
		expectRejected(demandScenarioSchema, { ...demandScenario, baseYear: 2025.5 }, ["baseYear"]);
		expectRejected(
			demandScenarioSchema,
			{ ...demandScenario, derivedCagr: { bear: 0, base: Number.NaN, bull: 0.5 } },
			["derivedCagr", "base"],
		);
	});

	it("requires derivedCagr to state each case explicitly", () => {
		expectRejected(demandScenarioSchema, { ...demandScenario, derivedCagr: { base: 0.25 } }, [
			"derivedCagr",
		]);
	});

	it("rejects unknown fields such as a confidence percentage", () => {
		expectRejected(demandScenarioSchema, { ...demandScenario, probability: 0.8 });
	});
});

describe("securitySchema (FR-005)", () => {
	it("accepts Japanese and US securities on their own exchanges", () => {
		expectAccepted(securitySchema, jpSecurity);
		expectAccepted(securitySchema, usSecurity);
		for (const exchange of EXCHANGES_BY_COUNTRY.JP) {
			expectAccepted(securitySchema, { ...jpSecurity, exchange });
		}
		for (const exchange of EXCHANGES_BY_COUNTRY.US) {
			expectAccepted(securitySchema, { ...usSecurity, exchange });
		}
	});

	it("rejects an exchange that does not belong to the security's country", () => {
		expectRejected(securitySchema, { ...jpSecurity, exchange: "NASDAQ" }, ["exchange"]);
		expectRejected(securitySchema, { ...jpSecurity, exchange: "NYSE" }, ["exchange"]);
		expectRejected(securitySchema, { ...usSecurity, exchange: "TSE" }, ["exchange"]);
		expectRejected(securitySchema, { ...usSecurity, country: "JP" }, ["exchange"]);
	});

	it("rejects an unknown exchange", () => {
		expectRejected(securitySchema, { ...usSecurity, exchange: "LSE" }, ["exchange"]);
		expectRejected(securitySchema, { ...usSecurity, exchange: "nasdaq" }, ["exchange"]);
	});

	it("requires the exchange alongside the ticker", () => {
		expectRejected(securitySchema, without(usSecurity, "exchange"), ["exchange"]);
		expectRejected(securitySchema, { ...usSecurity, exchange: "" }, ["exchange"]);
	});

	it("rejects an unsupported country and malformed tickers or currencies", () => {
		expectRejected(securitySchema, { ...usSecurity, country: "GB" }, ["country"]);
		expectRejected(securitySchema, { ...usSecurity, ticker: "exmp" }, ["ticker"]);
		expectRejected(securitySchema, { ...usSecurity, ticker: "" }, ["ticker"]);
		expectRejected(securitySchema, { ...usSecurity, listingCurrency: "usd" }, ["listingCurrency"]);
	});

	it("accepts unknown issuer identifier and reporting currency as explicit nulls", () => {
		expectAccepted(securitySchema, {
			...usSecurity,
			issuerIdentifier: null,
			reportingCurrency: null,
		});
		expectRejected(securitySchema, without(usSecurity, "issuerIdentifier"), ["issuerIdentifier"]);
	});

	it("tracks former tickers with their validity date", () => {
		expectRejected(
			securitySchema,
			{ ...usSecurity, formerTickers: [{ ticker: "EXM", exchange: "NYSE" }] },
			["formerTickers", 0, "validUntil"],
		);
	});
});

describe("supplierLinkSchema (FR-005 / DATA-001)", () => {
	it("accepts a link with evidence", () => {
		expectAccepted(supplierLinkSchema, supplierLink);
		expectAccepted(supplierLinkSchema, { ...supplierLink, scenarioId: null });
	});

	it("rejects a supplier relationship with no evidence", () => {
		expectRejected(supplierLinkSchema, { ...supplierLink, evidenceIds: [] }, ["evidenceIds"]);
		expectRejected(supplierLinkSchema, without(supplierLink, "evidenceIds"), ["evidenceIds"]);
	});

	it("rejects a link naming no product or service, or no exposure", () => {
		expectRejected(supplierLinkSchema, { ...supplierLink, productsOrServices: [] }, [
			"productsOrServices",
		]);
		expectRejected(supplierLinkSchema, { ...supplierLink, businessExposure: "" }, [
			"businessExposure",
		]);
	});
});

describe("reportingPeriodSchema", () => {
	it("accepts each fiscal period", () => {
		for (const fiscalPeriod of ["FY", "Q1", "Q2", "Q3", "Q4", "TTM"]) {
			expectAccepted(reportingPeriodSchema, { ...reportingPeriod, fiscalPeriod });
		}
	});

	it("rejects unknown periods and malformed dates", () => {
		expectRejected(reportingPeriodSchema, { ...reportingPeriod, fiscalPeriod: "H1" }, [
			"fiscalPeriod",
		]);
		expectRejected(reportingPeriodSchema, { ...reportingPeriod, periodEnd: "March 2026" }, [
			"periodEnd",
		]);
		expectRejected(reportingPeriodSchema, { ...reportingPeriod, fiscalYear: 25 }, ["fiscalYear"]);
	});
});

describe("financialObservationSchema (FR-006 / DATA-001 / DATA-011)", () => {
	it("accepts an available observation that cites its source", () => {
		expectAccepted(financialObservationSchema, availableObservation);
	});

	it("accepts an unavailable observation: null value plus a reason", () => {
		expectAccepted(financialObservationSchema, unavailableObservation);
	});

	it("accepts a currency-denominated observation that states its currency", () => {
		expectAccepted(financialObservationSchema, {
			...availableObservation,
			metricCode: "revenue",
			value: 4_530_000,
			unit: "currency",
			currency: "JPY",
			marketDataAsOf: null,
			formula: null,
		});
	});

	it("accepts a negative value (a net loss is a real observation, not a missing one)", () => {
		expectAccepted(financialObservationSchema, {
			...availableObservation,
			metricCode: "net-income",
			value: -300,
			unit: "currency",
			currency: "USD",
		});
	});

	it("rejects a value together with an unavailable reason", () => {
		expectRejected(
			financialObservationSchema,
			{ ...availableObservation, unavailableReason: "not available" },
			["unavailableReason"],
		);
	});

	it("rejects a missing value with no reason", () => {
		expectRejected(
			financialObservationSchema,
			{ ...availableObservation, value: null, unavailableReason: null },
			["unavailableReason"],
		);
	});

	it("rejects an empty reason", () => {
		expectRejected(
			financialObservationSchema,
			{ ...unavailableObservation, unavailableReason: "" },
			["unavailableReason"],
		);
	});

	it("rejects an available value without source evidence", () => {
		expectRejected(
			financialObservationSchema,
			{ ...availableObservation, sourceEvidenceId: null },
			["sourceEvidenceId"],
		);
	});

	it("rejects zero used as a stand-in for a value with no source", () => {
		expectRejected(
			financialObservationSchema,
			{ ...availableObservation, value: 0, sourceEvidenceId: null },
			["sourceEvidenceId"],
		);
	});

	it("rejects a currency amount without a currency", () => {
		for (const unit of ["currency", "currency-per-share"]) {
			expectRejected(
				financialObservationSchema,
				{ ...availableObservation, metricCode: "eps-diluted", unit, currency: null },
				["currency"],
			);
		}
	});

	it("rejects non-finite values", () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expectRejected(financialObservationSchema, { ...availableObservation, value }, ["value"]);
		}
	});

	it("requires actual-versus-estimate to be stated", () => {
		expectRejected(financialObservationSchema, without(availableObservation, "actualOrEstimate"), [
			"actualOrEstimate",
		]);
		expectRejected(
			financialObservationSchema,
			{ ...availableObservation, actualOrEstimate: "guess" },
			["actualOrEstimate"],
		);
	});

	it("rejects unknown metric codes, units and extra fields", () => {
		expectRejected(financialObservationSchema, { ...availableObservation, metricCode: "ratio" }, [
			"metricCode",
		]);
		expectRejected(financialObservationSchema, { ...availableObservation, unit: "percent" }, [
			"unit",
		]);
		expectRejected(financialObservationSchema, { ...availableObservation, note: "trust me" });
	});

	it("requires every nullable qualifier to be present explicitly", () => {
		for (const key of [
			"value",
			"unavailableReason",
			"sourceEvidenceId",
			"period",
			"currency",
		] as const) {
			expectRejected(financialObservationSchema, without(availableObservation, key));
		}
	});
});

describe("positionFiguresSchema (FR-007 / DATA-006)", () => {
	it("accepts Japanese margin balances and US short interest as distinct shapes", () => {
		expectAccepted(positionFiguresSchema, jpPosition.figures);
		expectAccepted(positionFiguresSchema, usPosition.figures);
		expectAccepted(positionFiguresSchema, {
			...usPosition.figures,
			averageDailyVolumeShares: null,
		});
	});

	it("rejects US short interest carrying Japanese margin fields", () => {
		expectRejected(positionFiguresSchema, {
			...usPosition.figures,
			marginBuyBalanceShares: 1_200_000,
		});
		expectRejected(positionFiguresSchema, {
			jurisdiction: "US",
			metric: "us-short-interest",
			marginBuyBalanceShares: 1_200_000,
			marginSellBalanceShares: 400_000,
		});
	});

	it("rejects Japanese margin balances carrying a US short-interest field", () => {
		expectRejected(positionFiguresSchema, {
			...jpPosition.figures,
			reportedShortInterestShares: 9_000_000,
		});
	});

	it("rejects a jurisdiction that does not match the metric", () => {
		expectRejected(positionFiguresSchema, { ...jpPosition.figures, jurisdiction: "US" }, [
			"jurisdiction",
		]);
		expectRejected(positionFiguresSchema, { ...usPosition.figures, jurisdiction: "JP" }, [
			"jurisdiction",
		]);
	});

	it("rejects a US margin-buy metric, which does not exist at security level", () => {
		expectRejected(positionFiguresSchema, {
			jurisdiction: "US",
			metric: "us-margin-balance",
			marginBuyBalanceShares: 1,
			marginSellBalanceShares: 1,
		});
	});

	it("rejects negative and non-finite share counts", () => {
		expectRejected(positionFiguresSchema, { ...jpPosition.figures, marginBuyBalanceShares: -1 });
		expectRejected(positionFiguresSchema, {
			...usPosition.figures,
			reportedShortInterestShares: Number.NaN,
		});
	});
});

describe("positionObservationSchema (FR-007 / DATA-006)", () => {
	it("accepts a Japanese and a US observation", () => {
		expectAccepted(positionObservationSchema, jpPosition);
		expectAccepted(positionObservationSchema, usPosition);
	});

	it("accepts an unavailable observation with a reason and no figures", () => {
		expectAccepted(positionObservationSchema, {
			...usPosition,
			figures: null,
			unavailableReason: "Source does not publish short interest for this venue.",
			asOfDate: null,
			disseminatedAt: null,
			sourceEvidenceId: null,
		});
	});

	it("rejects a US observation labelled with the Japanese margin metric", () => {
		expectRejected(positionObservationSchema, { ...usPosition, metric: "jp-margin-balance" }, [
			"metric",
		]);
	});

	it("rejects a US observation carrying Japanese margin figures", () => {
		expectRejected(positionObservationSchema, { ...usPosition, figures: jpPosition.figures }, [
			"metric",
		]);
		expectRejected(positionObservationSchema, {
			...usPosition,
			figures: { ...usPosition.figures, marginBuyBalanceShares: 5, marginSellBalanceShares: 5 },
		});
	});

	it("rejects a Japanese observation carrying US short-interest figures or the US metric", () => {
		expectRejected(positionObservationSchema, { ...jpPosition, figures: usPosition.figures }, [
			"metric",
		]);
		expectRejected(positionObservationSchema, { ...jpPosition, metric: "us-short-interest" }, [
			"metric",
		]);
	});

	it("rejects a jurisdiction swap that leaves the figures behind", () => {
		expectRejected(positionObservationSchema, { ...jpPosition, jurisdiction: "US" }, ["metric"]);
		expectRejected(positionObservationSchema, { ...usPosition, jurisdiction: "JP" }, ["metric"]);
	});

	it("applies the jurisdiction pairing even when the figures are unavailable", () => {
		expectRejected(
			positionObservationSchema,
			{
				...usPosition,
				metric: "jp-margin-balance",
				figures: null,
				unavailableReason: "n/a",
				asOfDate: null,
				sourceEvidenceId: null,
			},
			["metric"],
		);
	});

	it("rejects figures together with an unavailable reason, and neither", () => {
		expectRejected(positionObservationSchema, { ...jpPosition, unavailableReason: "n/a" }, [
			"unavailableReason",
		]);
		expectRejected(positionObservationSchema, { ...jpPosition, figures: null }, [
			"unavailableReason",
		]);
	});

	it("rejects available figures without source evidence or an as-of date", () => {
		expectRejected(positionObservationSchema, { ...jpPosition, sourceEvidenceId: null }, [
			"figures",
		]);
		expectRejected(positionObservationSchema, { ...jpPosition, asOfDate: null }, ["figures"]);
	});

	it("requires the source's metric definition and the shares unit", () => {
		expectRejected(positionObservationSchema, { ...jpPosition, metricDefinition: "" }, [
			"metricDefinition",
		]);
		expectRejected(positionObservationSchema, { ...jpPosition, unit: "yen" }, ["unit"]);
	});
});

describe("investorFilingSchema (FR-008 / DATA-007)", () => {
	it("accepts a filing with its reporting period, filing date and link", () => {
		expectAccepted(investorFilingSchema, investorFiling);
	});

	it("accepts each reported-position change and a null comparison", () => {
		const [holding] = investorFiling.holdings;
		for (const change of reportedPositionChangeSchema.options) {
			expectAccepted(investorFilingSchema, {
				...investorFiling,
				holdings: [{ ...holding, changeFromPriorFiling: change }],
			});
		}
		expectAccepted(investorFilingSchema, {
			...investorFiling,
			holdings: [{ ...holding, changeFromPriorFiling: null }],
		});
	});

	it("has no vocabulary for a purchase or sale", () => {
		for (const wording of ["bought", "purchased", "sold", "new-purchase", "recent-buy"]) {
			expectRejected(reportedPositionChangeSchema, wording);
		}
		expect(reportedPositionChangeSchema.options.every((option) => /report/.test(option))).toBe(
			true,
		);
	});

	it("rejects a transaction date on a holding", () => {
		const [holding] = investorFiling.holdings;
		expectRejected(investorFilingSchema, {
			...investorFiling,
			holdings: [{ ...holding, purchasedAt: "2026-05-02" }],
		});
	});

	it("requires the filing URL, report period, filing date and source evidence", () => {
		expectRejected(investorFilingSchema, without(investorFiling, "filingUrl"), ["filingUrl"]);
		expectRejected(investorFilingSchema, { ...investorFiling, filingUrl: "http://sec.example/x" }, [
			"filingUrl",
		]);
		expectRejected(investorFilingSchema, without(investorFiling, "reportPeriodEnd"), [
			"reportPeriodEnd",
		]);
		expectRejected(investorFilingSchema, without(investorFiling, "filedAt"), ["filedAt"]);
		expectRejected(investorFilingSchema, { ...investorFiling, sourceEvidenceId: null }, [
			"sourceEvidenceId",
		]);
	});

	it("bounds the number of holdings", () => {
		const [holding] = investorFiling.holdings;
		expectAccepted(investorFilingSchema, { ...investorFiling, holdings: repeat(holding, 60) });
		expectRejected(investorFilingSchema, { ...investorFiling, holdings: repeat(holding, 61) }, [
			"holdings",
		]);
	});
});

describe("pricingPowerRecordSchema (FR-009 / DATA-008)", () => {
	it("accepts a record with disclosed and undisclosed inputs", () => {
		expectAccepted(pricingPowerRecordSchema, pricingPowerRecord);
		expectAccepted(pricingPowerRecordSchema, {
			...pricingPowerRecord,
			inputs: { ...pricingPowerRecord.inputs, priceRealizationPct: null, volumeGrowthPct: null },
			assessment: {
				classification: "margin-improvement-without-price-evidence",
				missingInputs: ["priceRealizationPct", "volumeGrowthPct"],
				unexplainedRevenueResidualPct: null,
			},
		});
	});

	it("keeps price, volume, mix, FX and cost effects as separate required fields", () => {
		for (const key of [
			"priceRealizationPct",
			"volumeGrowthPct",
			"mixEffectPct",
			"fxEffectPct",
			"inputCostChangePct",
		] as const) {
			expectRejected(
				pricingPowerRecordSchema,
				{ ...pricingPowerRecord, inputs: without(pricingPowerRecord.inputs, key) },
				["inputs", key],
			);
		}
	});

	it("rejects an unknown classification such as plain 'pricing-power'", () => {
		expectRejected(
			pricingPowerRecordSchema,
			{
				...pricingPowerRecord,
				assessment: { ...pricingPowerRecord.assessment, classification: "pricing-power" },
			},
			["assessment", "classification"],
		);
	});

	it("rejects a record with no evidence and non-finite inputs", () => {
		expectRejected(pricingPowerRecordSchema, { ...pricingPowerRecord, evidenceIds: [] }, [
			"evidenceIds",
		]);
		expectRejected(
			pricingPowerRecordSchema,
			{
				...pricingPowerRecord,
				inputs: { ...pricingPowerRecord.inputs, priceRealizationPct: Number.NaN },
			},
			["inputs", "priceRealizationPct"],
		);
	});
});

describe("dataset schemas (UI-007 / hard gate 6)", () => {
	it("accepts a dataset with sourced, dated and explicitly unavailable cells", () => {
		expectAccepted(datasetSchema, dataset);
	});

	it("accepts text, number and null-with-reason cells", () => {
		expectAccepted(datasetCellSchema, { v: "text" });
		expectAccepted(datasetCellSchema, { v: 0, basis: "assumption" });
		expectAccepted(datasetCellSchema, { v: 20, basis: "derived" });
		expectAccepted(datasetCellSchema, { v: 12.5, sourceId: "ev_1", asOf: "2026-10-01T00:00:00Z" });
		expectAccepted(datasetCellSchema, { v: null, reason: "Not disclosed." });
	});

	it("rejects a bare number: every figure cites a source or declares its basis (hard gate 6)", () => {
		expectRejected(datasetCellSchema, { v: 999 }, ["basis"]);
		expectRejected(datasetCellSchema, { v: 999, asOf: "2026-10-01" }, ["basis"]);
		expectRejected(datasetCellSchema, { v: 999, basis: "measured" });
	});

	it("rejects an empty cell without a reason", () => {
		expectRejected(datasetCellSchema, { v: null }, ["reason"]);
		expectRejected(datasetCellSchema, { v: null, reason: "" }, ["reason"]);
		expectRejected(datasetCellSchema, {});
	});

	it("rejects non-finite numbers, objects and unknown cell fields", () => {
		expectRejected(datasetCellSchema, { v: Number.NaN });
		expectRejected(datasetCellSchema, { v: Number.POSITIVE_INFINITY });
		expectRejected(datasetCellSchema, { v: { html: "<b>x</b>" } });
		expectRejected(datasetCellSchema, { v: 1, html: "<b>1</b>" });
		expectRejected(datasetCellSchema, { v: 1, asOf: "last week" }, ["asOf"]);
	});

	it("rejects a number column without a unit", () => {
		expectRejected(
			datasetSchema,
			{
				...dataset,
				columns: [
					dataset.columns[0],
					{ key: "cagr", label: "Base CAGR", kind: "number" },
					dataset.columns[2],
				],
			},
			["columns"],
		);
	});

	it("allows text and date columns without a unit", () => {
		expectAccepted(datasetColumnSchema, { key: "name", label: "Name", kind: "text" });
		expectAccepted(datasetColumnSchema, { key: "day", label: "Day", kind: "date" });
		expectRejected(datasetColumnSchema, { key: "n", label: "N", kind: "number", unit: "" }, [
			"unit",
		]);
	});

	it("rejects rows that use undeclared column keys", () => {
		expectRejected(
			datasetSchema,
			{ ...dataset, rows: [{ product: { v: "x" }, secret: { v: "y" } }] },
			["rows"],
		);
	});

	it("rejects duplicate column keys", () => {
		expectRejected(
			datasetSchema,
			{ ...dataset, columns: [dataset.columns[0], dataset.columns[0]], rows: [] },
			["rows"],
		);
	});

	it("rejects an empty cell without a reason inside a row", () => {
		expectRejected(datasetSchema, { ...dataset, rows: [{ product: { v: null } }] }, [
			"rows",
			0,
			"product",
			"reason",
		]);
	});

	it("rejects malformed column keys and unknown kinds", () => {
		expectRejected(datasetColumnSchema, { key: "1st", label: "First", kind: "text" }, ["key"]);
		expectRejected(datasetColumnSchema, { key: "a b", label: "AB", kind: "text" }, ["key"]);
		expectRejected(datasetColumnSchema, { key: "a", label: "A", kind: "html" }, ["kind"]);
	});

	it("bounds columns and rows", () => {
		const column = (index: number) => ({ key: `c${index}`, label: `C${index}`, kind: "text" });
		const columns = (count: number) =>
			Array.from({ length: count }, (_unused, index) => column(index));
		expectAccepted(datasetSchema, { ...dataset, columns: columns(16), rows: [] });
		expectRejected(datasetSchema, { ...dataset, columns: columns(17), rows: [] }, ["columns"]);
		expectRejected(datasetSchema, { ...dataset, columns: [], rows: [] }, ["columns"]);
		expectAccepted(datasetSchema, { ...dataset, rows: repeat(dataset.rows[0], 300) });
		expectRejected(datasetSchema, { ...dataset, rows: repeat(dataset.rows[0], 301) }, ["rows"]);
	});
});

describe("datasetSchema: cell values match their column kind (hard gate 6)", () => {
	const dataset = (cell: unknown, kind: "number" | "text" | "date" = "number") => ({
		datasetId: "ds_kind",
		title: "Kinds",
		columns: [
			{ key: "value", label: "Value", kind, ...(kind === "number" ? { unit: "USD" } : {}) },
		],
		rows: [{ value: cell }],
		createdAt: "2026-10-11T00:00:00.000Z",
	});

	it("rejects a figure smuggled as text into a number column", () => {
		// Without the kind check this would dodge "a sourced number must carry an as-of date".
		expect(datasetSchema.safeParse(dataset({ v: "18.25", sourceId: "ev_1" })).success).toBe(false);
	});

	it("rejects a number in a text or date column", () => {
		expect(datasetSchema.safeParse(dataset({ v: 5 }, "text")).success).toBe(false);
		expect(datasetSchema.safeParse(dataset({ v: 5 }, "date")).success).toBe(false);
	});

	it("accepts matching kinds and explicit unavailability in any column", () => {
		expect(
			datasetSchema.safeParse(dataset({ v: 18.25, sourceId: "ev_1", asOf: "2026-10-01" })).success,
		).toBe(true);
		expect(datasetSchema.safeParse(dataset({ v: "note" }, "text")).success).toBe(true);
		expect(datasetSchema.safeParse(dataset({ v: null, reason: "not disclosed" })).success).toBe(
			true,
		);
	});
});
