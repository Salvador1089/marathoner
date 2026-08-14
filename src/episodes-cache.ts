import { App, TFile } from "obsidian";
import { TmdbClient } from "./tmdb/client";
import { writeEpisodesCache } from "./notes";
import type { CachedSeason } from "./models/title";
import type { TmdbSeasonSummary } from "./tmdb/types";

/**
 * Fetches every season's full episode list (one TMDB call per season) and
 * writes it to the note's local cache. This is what makes a show completely
 * usable offline right after being added, instead of only fetching episode
 * data lazily the first time someone happens to expand that season.
 */
export async function cacheAllSeasons(
	app: App,
	tmdb: TmdbClient,
	file: TFile,
	tvId: number,
	seasons: TmdbSeasonSummary[]
): Promise<void> {
	const cached: CachedSeason[] = [];

	for (const season of seasons) {
		if (season.season_number === 0) continue; // Specials are never shown for tracking - don't bother caching them.

		try {
			const details = await tmdb.getSeason(tvId, season.season_number);
			cached.push({
				seasonNumber: season.season_number,
				name: details.name,
				episodes: details.episodes.map((e) => ({
					number: e.episode_number,
					name: e.name,
					airDate: e.air_date,
				})),
			});
		} catch {
			// One season failing to fetch (rare) shouldn't block caching the rest.
		}
	}

	await writeEpisodesCache(app, file, cached);
}
