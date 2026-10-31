-- Repair both early and current 0016 layouts without changing applied history.
-- Migration runners execute this file transactionally. Preserve existing rows.
CREATE TABLE IF NOT EXISTS metal_observation (
 owner_id TEXT NOT NULL, series_id TEXT NOT NULL, observed_on TEXT NOT NULL,
 value_decimal TEXT NOT NULL, materials_source_updated_at TEXT,
 PRIMARY KEY(owner_id, series_id, observed_on)
) WITHOUT ROWID;
CREATE TABLE metal_series_upgrade_backup AS SELECT owner_id, series_id, body_json, committed_at FROM metal_series;
CREATE TABLE metal_observation_upgrade_backup AS SELECT * FROM metal_observation;
DROP TABLE metal_observation;
DROP TABLE metal_series;
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

INSERT INTO metal_series (owner_id, series_id, body_json, committed_at, title, material, product, grade, basis, source_id, unit, frequency, publisher, source_url, retrieved_at)
SELECT owner_id, series_id, body_json, committed_at,
 json_extract(body_json, '$.title'), json_extract(body_json, '$.material'),
 json_extract(body_json, '$.product'), json_extract(body_json, '$.grade'),
 json_extract(body_json, '$.basis'), json_extract(body_json, '$.sourceId'),
 json_extract(body_json, '$.unit'), json_extract(body_json, '$.frequency'),
 json_extract(body_json, '$.publisher'), json_extract(body_json, '$.sourceUrl'),
 json_extract(body_json, '$.retrievedAt') FROM metal_series_upgrade_backup;
INSERT INTO metal_observation SELECT * FROM metal_observation_upgrade_backup;
INSERT INTO metal_observation (owner_id, series_id, observed_on, value_decimal, materials_source_updated_at)
SELECT s.owner_id, s.series_id, json_extract(o.value, '$.observedOn'),
 json_extract(o.value, '$.valueDecimal'), json_extract(o.value, '$.materialsSourceUpdatedAt')
FROM metal_series s, json_each(s.body_json, '$.observations') o WHERE true
ON CONFLICT(owner_id, series_id, observed_on) DO NOTHING;
DROP TABLE metal_observation_upgrade_backup;
DROP TABLE metal_series_upgrade_backup;
