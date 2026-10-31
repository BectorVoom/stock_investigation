-- Index naming and review (docs/DATABASE_CONVENTIONS.md), version 20.
--
-- Renames every secondary index to idx_<table>__<columns>, drops indexes that
-- no query uses, fixes three column orders so their ORDER BY needs no
-- temporary sort, and adds one index measured to pay for itself. Only
-- indexes change: no table, column or row is touched, so no data can be lost.
-- The resulting schema equals `db/schema.sql`
-- (packages/adapters/test/sqlite/canonicalSchema.test.ts).
--
-- Dropped (each is pure write cost; on D1 every index entry is a billed row
-- write):
--   articles_by_source        never chosen: the one article query filters
--                             the source optionally (`?2 IS NULL OR ...`).
--   audit_log_by_owner        the application never reads audit_log.
--   equity_record_by_import   reverse foreign-key index; equity_import rows
--                             are never deleted or re-keyed, and no query
--                             filters equity_record by import_id.
--   equity_guidance_observation_by_issuer
--                             exact duplicate of the table's
--                             UNIQUE (owner_id, issuer_id, guidance_id).
--
-- Changed columns:
--   articles       (owner_id, retrieved_at DESC, article_id) ->
--                  (owner_id, retrieved_at, article_id), scanned backwards:
--                  ORDER BY retrieved_at DESC, article_id DESC is index order.
--   research_jobs  workspace index gains run_id (the ORDER BY tie-breaker).
--   notebook_turns workspace index gains run_id (the ORDER BY tie-breaker).
--   scheduled_tasks due index gains task_id (the ORDER BY tie-breaker).
--
-- Added:
--   idx_research_jobs__owner_id_kind_created_at_run_id: the latest job of a
--   kind (every Home/Watchlist read) went from a scan of all the owner's jobs
--   plus a sort to an index range (9.6 ms -> 1.0 ms at 20,000 jobs). Every
--   column is immutable after insert, so it costs one index write per job.
--
-- Rollback: restore the pre-migration backup (`wrangler d1 export`, see
-- docs/OPERATIONS.md), or recreate the version-19 indexes by name. Index
-- names are not read by any code, so version-19 code runs unchanged against
-- a version-20 database.

DROP INDEX IF EXISTS articles_by_source;
DROP INDEX IF EXISTS articles_by_retrieval;
CREATE INDEX idx_articles__owner_id_retrieved_at_article_id
    ON articles (owner_id, retrieved_at, article_id);

DROP INDEX IF EXISTS chat_messages_by_run;
CREATE INDEX idx_chat_messages__owner_id_workspace_id_run_id
    ON chat_messages (owner_id, workspace_id, run_id);

DROP INDEX IF EXISTS research_jobs_by_state;
CREATE INDEX idx_research_jobs__owner_id_state_created_at
    ON research_jobs (owner_id, state, created_at);
DROP INDEX IF EXISTS research_jobs_by_workspace;
CREATE INDEX idx_research_jobs__owner_id_workspace_id_created_at_run_id
    ON research_jobs (owner_id, workspace_id, created_at, run_id);
CREATE INDEX idx_research_jobs__owner_id_kind_created_at_run_id
    ON research_jobs (owner_id, kind, created_at, run_id);

DROP INDEX IF EXISTS job_transitions_by_run;
CREATE INDEX idx_job_transitions__owner_id_run_id_transition_id
    ON job_transitions (owner_id, run_id, transition_id);

DROP INDEX IF EXISTS evidence_by_run;
CREATE INDEX idx_evidence__owner_id_run_id
    ON evidence (owner_id, run_id);

DROP INDEX IF EXISTS claims_by_run;
CREATE INDEX idx_claims__owner_id_run_id
    ON claims (owner_id, run_id);

DROP INDEX IF EXISTS claim_evidence_by_evidence;
CREATE INDEX idx_claim_evidence__owner_id_evidence_id
    ON claim_evidence (owner_id, evidence_id);

DROP INDEX IF EXISTS research_records_by_run;
CREATE INDEX idx_research_records__owner_id_run_id_record_type_ordinal
    ON research_records (owner_id, run_id, record_type, ordinal);

DROP INDEX IF EXISTS datasets_by_workspace;
CREATE INDEX idx_datasets__owner_id_workspace_id
    ON datasets (owner_id, workspace_id);

DROP INDEX IF EXISTS notebook_turns_by_workspace;
CREATE INDEX idx_notebook_turns__owner_id_workspace_id_created_at_run_id
    ON notebook_turns (owner_id, workspace_id, created_at, run_id);

DROP INDEX IF EXISTS scheduled_tasks_due;
CREATE INDEX idx_scheduled_tasks__owner_id_next_run_at_task_id
    ON scheduled_tasks (owner_id, next_run_at, task_id);

DROP INDEX IF EXISTS audit_log_by_owner;

DROP INDEX IF EXISTS equity_import_by_commit;
CREATE INDEX idx_equity_import__owner_id_committed_at_import_id
    ON equity_import (owner_id, committed_at DESC, import_id DESC);

DROP INDEX IF EXISTS equity_record_by_import;

DROP INDEX IF EXISTS equity_issuer_identifier_by_value;
CREATE INDEX idx_equity_issuer_identifier__owner_id_scheme_value
    ON equity_issuer_identifier (owner_id, scheme, value);

DROP INDEX IF EXISTS equity_security_by_issuer;
CREATE INDEX idx_equity_security__owner_id_issuer_id_security_id
    ON equity_security (owner_id, issuer_id, security_id);

DROP INDEX IF EXISTS equity_listing_by_security;
CREATE INDEX idx_equity_listing__owner_id_security_id_listing_id
    ON equity_listing (owner_id, security_id, listing_id);
DROP INDEX IF EXISTS equity_listing_by_symbol;
CREATE INDEX idx_equity_listing__owner_id_venue_mic_symbol
    ON equity_listing (owner_id, venue_mic, symbol);

DROP INDEX IF EXISTS equity_filing_by_issuer;
CREATE INDEX idx_equity_filing__owner_id_issuer_id_public_available_at_filing_id
    ON equity_filing (owner_id, issuer_id, public_available_at, filing_id);

DROP INDEX IF EXISTS equity_statement_by_filing;
CREATE INDEX idx_equity_statement__owner_id_filing_id_statement_id
    ON equity_statement (owner_id, filing_id, statement_id);

DROP INDEX IF EXISTS equity_financial_fact_by_statement;
CREATE INDEX idx_equity_financial_fact__owner_id_statement_id_fact_id
    ON equity_financial_fact (owner_id, statement_id, fact_id);

DROP INDEX IF EXISTS equity_price_bar_by_listing;
CREATE INDEX idx_equity_price_bar__owner_id_listing_id_trading_on_price_bar_id
    ON equity_price_bar (owner_id, listing_id, trading_on, price_bar_id);

DROP INDEX IF EXISTS equity_corporate_action_by_security;
CREATE INDEX idx_equity_corporate_action__owner_id_security_id_effective_on_action_id
    ON equity_corporate_action (owner_id, security_id, effective_on, action_id);

DROP INDEX IF EXISTS equity_guidance_observation_by_issuer;
