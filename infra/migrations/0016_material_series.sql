-- Immutable, bounded owner-imported physical-material snapshots. No seed data.
-- Product/grade/basis and source identity are preserved in validated body_json.
CREATE TABLE metal_series (
 owner_id TEXT NOT NULL,
 series_id TEXT NOT NULL CHECK (series_id GLOB 'materials:*' AND length(series_id) BETWEEN 11 AND 35),
 body_json TEXT NOT NULL CHECK (json_valid(body_json) AND length(body_json) <= 750000 AND json_extract(body_json, '$.seriesId') = series_id),
 committed_at TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
 material TEXT NOT NULL,
 product TEXT NOT NULL,
 grade TEXT NOT NULL,
 basis TEXT NOT NULL,
 source_id TEXT NOT NULL,
 unit TEXT NOT NULL,
 frequency TEXT NOT NULL,
 publisher TEXT NOT NULL,
 source_url TEXT NOT NULL,
 retrieved_at TEXT NOT NULL,
 PRIMARY KEY (owner_id, series_id)
) WITHOUT ROWID;
CREATE TRIGGER metal_series_immutable_update BEFORE UPDATE ON metal_series
BEGIN SELECT RAISE(ABORT, 'material series is immutable; import a new version'); END;
CREATE TRIGGER metal_series_immutable_delete BEFORE DELETE ON metal_series
BEGIN SELECT RAISE(ABORT, 'material series is immutable'); END;

CREATE TABLE metal_observation (
 owner_id TEXT NOT NULL,
 series_id TEXT NOT NULL,
 observed_on TEXT NOT NULL CHECK(length(observed_on) = 10),
 value_decimal TEXT NOT NULL CHECK(length(value_decimal) BETWEEN 1 AND 132),
 materials_source_updated_at TEXT CHECK (
 materials_source_updated_at IS NULL OR (
 typeof(materials_source_updated_at) = 'text'
 AND length(materials_source_updated_at) = 24
 AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') IS NOT NULL
 AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') = materials_source_updated_at
 )),
 PRIMARY KEY(owner_id, series_id, observed_on),
 FOREIGN KEY(owner_id, series_id) REFERENCES metal_series(owner_id, series_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE TRIGGER metal_observation_immutable_update BEFORE UPDATE ON metal_observation
BEGIN SELECT RAISE(ABORT, 'material observations are immutable'); END;
CREATE TRIGGER metal_observation_immutable_delete BEFORE DELETE ON metal_observation
BEGIN SELECT RAISE(ABORT, 'material observations are immutable'); END;
