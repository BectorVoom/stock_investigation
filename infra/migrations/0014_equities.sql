-- Durable normalized equities library. Naming: docs/NAMING_CONVENTIONS.md.
-- Bounded owner imports commit as one atomic SQL batch. No multi-request
-- staging or provider parser is implied by this import protocol.
-- Exact values stay in validated record JSON as canonical decimal strings.
-- Relational projections enforce owner/entity references and index reads.
-- Rollback: disable the feature and restore an export plus matching artifacts;
-- this additive migration never rewrites existing research/watchlist data.

CREATE TABLE equity_import (
    owner_id TEXT NOT NULL,
    import_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    committed_at TEXT NOT NULL,
    commit_sequence INTEGER NOT NULL CHECK (commit_sequence > 0),
    coverage_note TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    record_count INTEGER NOT NULL CHECK (record_count BETWEEN 1 AND 2000),
    PRIMARY KEY (owner_id, import_id),
    UNIQUE (owner_id, commit_sequence),
    UNIQUE (owner_id, idempotency_key)
) WITHOUT ROWID;

CREATE INDEX equity_import_by_commit ON equity_import(owner_id, committed_at DESC, import_id DESC);

CREATE TABLE equity_record (
    owner_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    record_type TEXT NOT NULL CHECK (record_type IN ('issuer','identifier','security','listing','source','document','filing','statement','metric','fact','price','action','fx','guidance')),
    import_id TEXT NOT NULL,
    body_json TEXT NOT NULL CHECK (json_valid(body_json)),
    PRIMARY KEY (owner_id, record_id),
    UNIQUE (owner_id, record_type, record_id),
    FOREIGN KEY (owner_id, import_id) REFERENCES equity_import(owner_id, import_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX equity_record_by_import ON equity_record(owner_id, import_id);

CREATE TABLE equity_issuer (
    owner_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    legal_name TEXT NOT NULL,
    local_name TEXT,
    PRIMARY KEY (owner_id, issuer_id),
    FOREIGN KEY (owner_id, issuer_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE TABLE equity_data_source (
    owner_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, source_id),
    FOREIGN KEY (owner_id, source_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE TABLE equity_source_document (
    owner_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    published_at TEXT,
    retrieved_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, source_document_id),
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_id) REFERENCES equity_data_source(owner_id, source_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE TABLE equity_issuer_identifier (
    owner_id TEXT NOT NULL,
    identifier_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    scheme TEXT NOT NULL,
    value TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, identifier_id),
    FOREIGN KEY (owner_id, identifier_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id) REFERENCES equity_issuer(owner_id, issuer_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX equity_issuer_identifier_by_value ON equity_issuer_identifier(owner_id, scheme, value);
CREATE TABLE equity_security (
    owner_id TEXT NOT NULL,
    security_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, security_id),
    FOREIGN KEY (owner_id, security_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id) REFERENCES equity_issuer(owner_id, issuer_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX equity_security_by_issuer ON equity_security(owner_id, issuer_id, security_id);
CREATE TABLE equity_listing (
    owner_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    security_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('JP','US')),
    venue_mic TEXT NOT NULL,
    symbol TEXT NOT NULL,
    listed_on TEXT,
    delisted_on TEXT,
    PRIMARY KEY (owner_id, listing_id),
    FOREIGN KEY (owner_id, listing_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, security_id) REFERENCES equity_security(owner_id, security_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX equity_listing_by_security ON equity_listing(owner_id, security_id, listing_id);
CREATE INDEX equity_listing_by_symbol ON equity_listing(owner_id, venue_mic, symbol);
CREATE TABLE equity_filing (
    owner_id TEXT NOT NULL,
    filing_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    public_available_at TEXT,
    amendment_of_filing_id TEXT,
    PRIMARY KEY (owner_id, filing_id),
    UNIQUE (owner_id, issuer_id, filing_id),
    FOREIGN KEY (owner_id, filing_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id) REFERENCES equity_issuer(owner_id, issuer_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id, amendment_of_filing_id) REFERENCES equity_filing(owner_id, issuer_id, filing_id) ON DELETE RESTRICT,
    CHECK (amendment_of_filing_id IS NULL OR amendment_of_filing_id <> filing_id)
) WITHOUT ROWID;
CREATE INDEX equity_filing_by_issuer ON equity_filing(owner_id, issuer_id, public_available_at, filing_id);
CREATE TABLE equity_statement (
    owner_id TEXT NOT NULL,
    statement_id TEXT NOT NULL,
    filing_id TEXT NOT NULL,
    period_end TEXT NOT NULL,
    PRIMARY KEY (owner_id, statement_id),
    FOREIGN KEY (owner_id, statement_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, filing_id) REFERENCES equity_filing(owner_id, filing_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX equity_statement_by_filing ON equity_statement(owner_id, filing_id, statement_id);
CREATE TABLE equity_metric_definition (
    owner_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    metric_code TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    PRIMARY KEY (owner_id, metric_definition_id),
    UNIQUE (owner_id, metric_code, version),
    FOREIGN KEY (owner_id, metric_definition_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE TABLE equity_financial_fact (
    owner_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    statement_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, fact_id),
    FOREIGN KEY (owner_id, fact_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, statement_id) REFERENCES equity_statement(owner_id, statement_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, metric_definition_id) REFERENCES equity_metric_definition(owner_id, metric_definition_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX equity_financial_fact_by_statement ON equity_financial_fact(owner_id, statement_id, fact_id);
CREATE TABLE equity_price_bar (
    owner_id TEXT NOT NULL,
    price_bar_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    trading_on TEXT NOT NULL,
    supersedes_price_bar_id TEXT,
    PRIMARY KEY (owner_id, price_bar_id),
    UNIQUE (owner_id, listing_id, price_bar_id),
    FOREIGN KEY (owner_id, price_bar_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, listing_id) REFERENCES equity_listing(owner_id, listing_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, listing_id, supersedes_price_bar_id) REFERENCES equity_price_bar(owner_id, listing_id, price_bar_id) ON DELETE RESTRICT,
    CHECK (supersedes_price_bar_id IS NULL OR supersedes_price_bar_id <> price_bar_id)
) WITHOUT ROWID;
CREATE INDEX equity_price_bar_by_listing ON equity_price_bar(owner_id, listing_id, trading_on, price_bar_id);
CREATE TABLE equity_corporate_action (
    owner_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    security_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    effective_on TEXT NOT NULL,
    supersedes_action_id TEXT,
    PRIMARY KEY (owner_id, action_id),
    UNIQUE (owner_id, security_id, action_id),
    FOREIGN KEY (owner_id, action_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, security_id) REFERENCES equity_security(owner_id, security_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, security_id, supersedes_action_id) REFERENCES equity_corporate_action(owner_id, security_id, action_id) ON DELETE RESTRICT,
    CHECK (supersedes_action_id IS NULL OR supersedes_action_id <> action_id)
) WITHOUT ROWID;
CREATE INDEX equity_corporate_action_by_security ON equity_corporate_action(owner_id, security_id, effective_on, action_id);
CREATE TABLE equity_fx_observation (
    owner_id TEXT NOT NULL,
    fx_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, fx_id),
    FOREIGN KEY (owner_id, fx_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE TABLE equity_guidance_observation (
    owner_id TEXT NOT NULL,
    guidance_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    supersedes_guidance_id TEXT,
    PRIMARY KEY (owner_id, guidance_id),
    UNIQUE (owner_id, issuer_id, guidance_id),
    FOREIGN KEY (owner_id, guidance_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id) REFERENCES equity_issuer(owner_id, issuer_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, metric_definition_id) REFERENCES equity_metric_definition(owner_id, metric_definition_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id, supersedes_guidance_id) REFERENCES equity_guidance_observation(owner_id, issuer_id, guidance_id) ON DELETE RESTRICT,
    CHECK (supersedes_guidance_id IS NULL OR supersedes_guidance_id <> guidance_id)
) WITHOUT ROWID;
CREATE INDEX equity_guidance_observation_by_issuer ON equity_guidance_observation(owner_id, issuer_id, guidance_id);
