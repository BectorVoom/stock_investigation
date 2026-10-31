import type { MaterialRepository } from "@research/application";
import {
	MATERIAL_LIMITS,
	marketCatalogEntrySchema,
	materialSeriesSchema,
} from "@research/contracts";
import { truncateText } from "@research/domain";
import { z } from "zod";
import type { SqlDatabase } from "./database.ts";
import { bodyOf } from "./rows.ts";

const catalogRow = z.object({ series_id: z.string(), title: z.string(), description: z.string() });

export function createMaterialRepository(db: SqlDatabase): MaterialRepository {
	return {
		async import(ownerId, input, committedAt) {
			const payload = input;
			const serialized = JSON.stringify(
				payload.series.map((series) => ({
					...series,
					observations: [...series.observations].sort((a, b) =>
						a.observedOn.localeCompare(b.observedOn),
					),
				})),
			);
			const guard = `NOT EXISTS (
					SELECT 1
					FROM json_each(?3) AS incoming
					INNER JOIN metal_series AS mts
						ON mts.owner_id = ?1 AND mts.series_id = json_extract(incoming.value, '$.seriesId')
					WHERE mts.body_json <> incoming.value
				)
				AND (
					(SELECT count(*) FROM metal_series AS mts WHERE mts.owner_id = ?1)
					+ (
						SELECT count(*)
						FROM json_each(?3) AS incoming
						WHERE NOT EXISTS (
							SELECT 1
							FROM metal_series AS mts
							WHERE mts.owner_id = ?1
								AND mts.series_id = json_extract(incoming.value, '$.seriesId')
						)
					)
				) <= ${MATERIAL_LIMITS.maxStoredSeries}`;
			await db.batch([
				db
					.prepare(
						`INSERT INTO metal_series (owner_id, series_id, body_json, committed_at, title, material,
							product, grade, basis, source_id, unit, frequency, publisher, source_url, retrieved_at)
						SELECT
							?1,
							json_extract(series_item.value, '$.seriesId'),
							series_item.value,
							?2,
							json_extract(series_item.value, '$.title'),
							json_extract(series_item.value, '$.material'),
							json_extract(series_item.value, '$.product'),
							json_extract(series_item.value, '$.grade'),
							json_extract(series_item.value, '$.basis'),
							json_extract(series_item.value, '$.sourceId'),
							json_extract(series_item.value, '$.unit'),
							json_extract(series_item.value, '$.frequency'),
							json_extract(series_item.value, '$.publisher'),
							json_extract(series_item.value, '$.sourceUrl'),
							json_extract(series_item.value, '$.retrievedAt')
						FROM json_each(?3) AS series_item
						WHERE ${guard}
						ON CONFLICT (owner_id, series_id) DO NOTHING`,
					)
					.bind(ownerId, committedAt, serialized),
				db
					.prepare(
						`INSERT INTO metal_observation (owner_id, series_id, observed_on, value_decimal,
							materials_source_updated_at)
						SELECT
							?1,
							json_extract(series_item.value, '$.seriesId'),
							json_extract(observation_item.value, '$.observedOn'),
							json_extract(observation_item.value, '$.valueDecimal'),
							json_extract(observation_item.value, '$.materialsSourceUpdatedAt')
						FROM json_each(?3) AS series_item
						INNER JOIN json_each(series_item.value, '$.observations') AS observation_item
						WHERE ${guard} AND ?2 IS NOT NULL
						ON CONFLICT (owner_id, series_id, observed_on) DO NOTHING`,
					)
					.bind(ownerId, committedAt, serialized),
				db
					.prepare(
						`INSERT INTO audit_log (owner_id, actor, action, resource, detail, at)
						SELECT ?1, ?1, 'materials.import', 'materials', 'series:' || json_array_length(?3), ?2
						WHERE ${guard}`,
					)
					.bind(ownerId, committedAt, serialized),
			]);
			const conflict = await db
				.prepare(
					`SELECT 1 AS conflict_found
					FROM json_each(?2) AS incoming
					LEFT JOIN metal_series AS mts
						ON mts.owner_id = ?1 AND mts.series_id = json_extract(incoming.value, '$.seriesId')
					WHERE mts.body_json IS NULL OR mts.body_json <> incoming.value
					LIMIT 1`,
				)
				.bind(ownerId, serialized)
				.first();
			return conflict === null;
		},
		async get(ownerId, seriesId) {
			const row = await db
				.prepare("SELECT body_json FROM metal_series WHERE owner_id = ? AND series_id = ?")
				.bind(ownerId, seriesId)
				.first();
			if (row === null) return null;
			return bodyOf("metal_series", materialSeriesSchema, row);
		},
		async listCatalog(ownerId) {
			const { results } = await db
				.prepare(
					`SELECT series_id, title, product || '; ' || grade || '; ' || basis AS description
					FROM metal_series
					WHERE owner_id = ?
					ORDER BY series_id`,
				)
				.bind(ownerId)
				.all();
			return results.map((row) => {
				const data = catalogRow.parse(row);
				return marketCatalogEntrySchema.parse({
					seriesId: data.series_id,
					label: data.title,
					category: "commodity",
					description: truncateText(data.description, 300),
				});
			});
		},
	};
}
