-- A source's own record-update instant, distinct from retrieval/import time.
-- Existing records remain NULL; no fabricated backfill or current-time default.
-- Canonical UTC milliseconds: exactly 24 ASCII characters. Calendar validation
-- is repeated at the import boundary; SQLite checks both shape and round trip.
ALTER TABLE equity_source_document ADD COLUMN materials_source_updated_at TEXT
CHECK (
    materials_source_updated_at IS NULL OR (
        typeof(materials_source_updated_at) = 'text'
        AND length(materials_source_updated_at) = 24
        AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') = materials_source_updated_at
    )
);
