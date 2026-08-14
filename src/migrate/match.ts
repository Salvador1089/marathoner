import { TmdbClient } from "../tmdb/client";
import type { MediaType } from "../models/title";
import type { ParsedImportItem } from "./types";

export interface MatchResult {
	tmdbId: number;
	type: MediaType;
	title: string;
}

/**
 * Resolves one imported item to a concrete TMDB id, trying the most reliable
 * signal first: an explicit TMDB id (Ryot, Simkl, some Trakt exports) needs
 * no network call at all; an IMDb id (IMDb, Simkl, Trakt) is looked up via
 * TMDB's /find endpoint, which is exact; only when neither is available does
 * this fall back to a title+year search, which is the one path that can
 * genuinely pick the wrong title (ambiguous/common names, remakes, etc).
 */
export async function matchImportItem(tmdb: TmdbClient, item: ParsedImportItem): Promise<MatchResult | null> {
	if (item.tmdbId && item.type) {
		return { tmdbId: item.tmdbId, type: item.type, title: item.title };
	}

	if (item.imdbId) {
		try {
			const found = await tmdb.findByExternalId(item.imdbId);
			const movie = found.movie_results[0];
			const tv = found.tv_results[0];

			if (item.type === "movie" && movie) return { tmdbId: movie.id, type: "movie", title: movie.title ?? item.title };
			if (item.type === "tv" && tv) return { tmdbId: tv.id, type: "tv", title: tv.name ?? item.title };
			if (!item.type) {
				if (movie) return { tmdbId: movie.id, type: "movie", title: movie.title ?? item.title };
				if (tv) return { tmdbId: tv.id, type: "tv", title: tv.name ?? item.title };
			}
		} catch {
			// Fall through to title search below.
		}
	}

	if (!item.title || item.title.startsWith("TMDB #")) return null; // Ryot items with no usable title and no id - nothing to search for.

	try {
		const results = (await tmdb.search(item.title)).results.filter((r) => r.media_type === "movie" || r.media_type === "tv");
		const candidates = item.type ? results.filter((r) => r.media_type === item.type) : results;
		if (candidates.length === 0) return null;

		const best = item.year ? pickBestYearMatch(candidates, item.year) : candidates[0];
		const type: MediaType = best.media_type === "movie" ? "movie" : "tv";
		return { tmdbId: best.id, type, title: best.title ?? best.name ?? item.title };
	} catch {
		return null;
	}
}

function pickBestYearMatch<T extends { release_date?: string; first_air_date?: string }>(candidates: T[], year: string): T {
	const exact = candidates.find((c) => (c.release_date ?? c.first_air_date ?? "").startsWith(year));
	return exact ?? candidates[0];
}
