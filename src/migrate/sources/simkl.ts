import { parseCsv, findColumn, clampRating, normalizeDate } from "../csv";
import type { ParseResult, ParsedImportItem, ImportStatus } from "../types";
import type { MediaType } from "../../models/title";

/**
 * Simkl's CSV backup ("DOWNLOAD BACKUP (CSV Format)") header:
 * SIMKL_ID,Title,Type,Year,Watchlist,LastEpWatched,WatchedDate,Rating,Memo,TVDB,TMDB,IMDB
 * The TMDB column is a direct id when Simkl matched it - the most reliable
 * key we get from any of the CSV sources, since it skips title matching
 * entirely for most rows.
 */
export function parseSimklExport(text: string): ParseResult {
	const { headers, rows } = parseCsv(text);

	const titleCol = findColumn(headers, "title");
	const typeCol = findColumn(headers, "type");
	const yearCol = findColumn(headers, "year");
	const statusCol = findColumn(headers, "watchlist", "status");
	const dateCol = findColumn(headers, "watcheddate", "watched date");
	const ratingCol = findColumn(headers, "rating");
	const tmdbCol = findColumn(headers, "tmdb");
	const imdbCol = findColumn(headers, "imdb");

	if (!titleCol) {
		return { items: [], skipped: 0, warnings: ["Couldn't find a Title column - is this really a Simkl export CSV?"] };
	}

	const items: ParsedImportItem[] = [];
	let skipped = 0;

	for (const row of rows) {
		const title = row[titleCol]?.trim();
		if (!title) continue;

		const rawType = (typeCol ? row[typeCol] : "movie").toLowerCase();
		const type: MediaType | null = rawType.includes("movie")
			? "movie"
			: rawType.includes("tv") || rawType.includes("show") || rawType.includes("anime")
				? "tv"
				: null;
		if (!type) {
			skipped++;
			continue;
		}

		const tmdbRaw = tmdbCol ? row[tmdbCol]?.trim() : "";
		const ratingRaw = ratingCol ? row[ratingCol]?.trim() : "";

		items.push({
			title,
			year: yearCol ? row[yearCol]?.trim() || null : null,
			type,
			tmdbId: tmdbRaw ? Number(tmdbRaw) || null : null,
			imdbId: imdbCol ? row[imdbCol]?.trim() || null : null,
			status: mapSimklStatus(statusCol ? row[statusCol] : ""),
			rating: ratingRaw ? clampRating(Number(ratingRaw)) : null,
			watchedAt: dateCol ? normalizeDate(row[dateCol]) : null,
		});
	}

	return { items, skipped, warnings: [] };
}

function mapSimklStatus(raw: string): ImportStatus {
	const v = raw.toLowerCase();
	if (v.includes("watching")) return "watching";
	if (v.includes("plan")) return "planned";
	if (v.includes("hold")) return "on_hold";
	if (v.includes("drop")) return "dropped";
	return "completed"; // the CSV backup is fundamentally a watch-history export
}
