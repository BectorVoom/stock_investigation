/** Trusted projection registry; SQL identifiers are never supplied by an import. */
export const EQUITY_TABLES = [
	{
		kind: "issuer",
		table: "equity_issuer",
		columns: [
			["issuer_id", "issuerId"],
			["legal_name", "legalName"],
			["local_name", "localName"],
		],
	},
	{ kind: "source", table: "equity_data_source", columns: [["source_id", "sourceId"]] },
	{
		kind: "document",
		table: "equity_source_document",
		columns: [
			["source_document_id", "sourceDocumentId"],
			["source_id", "sourceId"],
			["published_at", "publishedAt"],
			["materials_source_updated_at", "materialsSourceUpdatedAt"],
			["retrieved_at", "retrievedAt"],
		],
	},
	{
		kind: "identifier",
		table: "equity_issuer_identifier",
		columns: [
			["identifier_id", "identifierId"],
			["issuer_id", "issuerId"],
			["scheme", "scheme"],
			["value", "value"],
			["source_document_id", "sourceDocumentId"],
		],
	},
	{
		kind: "security",
		table: "equity_security",
		columns: [
			["security_id", "securityId"],
			["issuer_id", "issuerId"],
		],
	},
	{
		kind: "listing",
		table: "equity_listing",
		columns: [
			["listing_id", "listingId"],
			["security_id", "securityId"],
			["market", "market"],
			["venue_mic", "venueMic"],
			["symbol", "symbol"],
			["listed_on", "listedOn"],
			["delisted_on", "delistedOn"],
		],
	},
	{
		kind: "filing",
		table: "equity_filing",
		columns: [
			["filing_id", "filingId"],
			["issuer_id", "issuerId"],
			["source_document_id", "sourceDocumentId"],
			["public_available_at", "publicAvailableAt"],
			["amendment_of_filing_id", "amendmentOfFilingId"],
		],
	},
	{
		kind: "statement",
		table: "equity_statement",
		columns: [
			["statement_id", "statementId"],
			["filing_id", "filingId"],
			["period_end", "periodEnd"],
		],
	},
	{
		kind: "metric",
		table: "equity_metric_definition",
		columns: [
			["metric_definition_id", "metricDefinitionId"],
			["metric_code", "metricCode"],
			["version", "version"],
		],
	},
	{
		kind: "fact",
		table: "equity_financial_fact",
		columns: [
			["fact_id", "factId"],
			["statement_id", "statementId"],
			["metric_definition_id", "metricDefinitionId"],
		],
	},
	{
		kind: "price",
		table: "equity_price_bar",
		columns: [
			["price_bar_id", "priceBarId"],
			["listing_id", "listingId"],
			["source_document_id", "sourceDocumentId"],
			["trading_on", "tradingOn"],
			["supersedes_price_bar_id", "supersedesPriceBarId"],
		],
	},
	{
		kind: "action",
		table: "equity_corporate_action",
		columns: [
			["action_id", "actionId"],
			["security_id", "securityId"],
			["source_document_id", "sourceDocumentId"],
			["effective_on", "effectiveOn"],
			["supersedes_action_id", "supersedesActionId"],
		],
	},
	{
		kind: "fx",
		table: "equity_fx_observation",
		columns: [
			["fx_id", "fxId"],
			["source_document_id", "sourceDocumentId"],
			["observed_at", "observedAt"],
		],
	},
	{
		kind: "guidance",
		table: "equity_guidance_observation",
		columns: [
			["guidance_id", "guidanceId"],
			["issuer_id", "issuerId"],
			["source_document_id", "sourceDocumentId"],
			["metric_definition_id", "metricDefinitionId"],
			["supersedes_guidance_id", "supersedesGuidanceId"],
		],
	},
] as const;
