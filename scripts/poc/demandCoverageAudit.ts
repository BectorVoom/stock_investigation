/** Read-only diagnostic of actual stored coverage, not a synthetic matching test. */
import { articleListResponseSchema } from "../../packages/contracts/src/api.ts";
import {
	analyzeDemand,
	DEMAND_THEMES,
	type DemandCandidate,
} from "../../packages/domain/src/news/demandSignals.ts";

const address = process.argv[2];
if (address === undefined || !URL.canParse(address))
	throw new Error("Usage: node scripts/poc/demandCoverageAudit.ts <API origin>");
const root = new URL(address);
let cursor: string | null = null;
const visited = new Set<string>();
const candidates: DemandCandidate[] = [];
let complete = false;
let articlesWithExcerpts = 0;
for (let page = 0; page < 100; page += 1) {
	const url = new URL("/api/v1/articles", root);
	if (cursor !== null) url.searchParams.set("cursor", cursor);
	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`Article read failed: HTTP ${response.status}`);
	const parsed = articleListResponseSchema.parse(await response.json());
	articlesWithExcerpts += parsed.articles.filter((article) => article.excerpt !== null).length;
	candidates.push(...parsed.articles.map(analyzeDemand));
	cursor = parsed.nextCursor;
	if (cursor === null) {
		complete = true;
		break;
	}
	if (visited.has(cursor)) throw new Error("Article cursor repeated; coverage is incomplete.");
	visited.add(cursor);
}
console.log(
	JSON.stringify(
		{
			note: "Observed metadata coverage, not verified demand or evidence that demand is absent. No writes or provider calls performed.",
			articles: candidates.length,
			articlesWithExcerpts,
			articlesWithoutExcerpts: candidates.length - articlesWithExcerpts,
			complete,
			themes: DEMAND_THEMES.map((theme) => ({
				theme,
				topicalArticles: candidates.filter((candidate) => candidate.themes.includes(theme)).length,
				phraseMatchedArticles: candidates.filter(
					(candidate) => candidate.themes.includes(theme) && candidate.passages.length > 0,
				).length,
			})),
		},
		null,
		2,
	),
);
