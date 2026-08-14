import { parseCsv, findColumn, clampRating, normalizeDate } from "../csv";
import type { ParseResult, ParsedImportItem } from "../types";
import type { MediaType } from "../../models/title";

/**
 * IMDb's "Export" button (on Your Ratings or Your Watchlist) produces a CSV
 * with a stable, documented header set:
 * Const,Your Rating,Date Rated,Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,...
 * `Const` is the IMDb id (tt1234567) - a direct, reliable match key.
 */
export function parseImdbExport(text: string): ParseResult {
	const { headers, rows } = parseCsv(text);

	const constCol = findColumn(headers, "const", "imdb id", "imdb_id");
	const titleCol = findColumn(headers, "title");
	const typeCol = findColumn(headers, "title type", "type");
	const yearCol = findColumn(headers, "year");
	const ratingCol = findColumn(headers, "your rating");
	const dateCol = findColumn(headers, "date rated", "created");

	if (!titleCol) {
		return { items: [], skipped: 0, warnings: ["Couldn't find a Title column - is this really an IMDb export CSV?"] };
	}

	const items: ParsedImportItem[] = [];
	let skipped = 0;

	for (const row of rows) {
		const title = row[titleCol]?.trim();
		if (!title) continue;

		const rawType = (typeCol ? row[typeCol] : "").toLowerCase();
		const type: MediaType | null =
			rawType.includes("series") || rawType.includes("mini")
				? "tv"
				: rawType.includes("movie") || rawType.includes("short") || rawType === ""
					? "movie"
					: null;

		// Individual episode ratings (tvEpisode) aren't something Marathoner
		// tracks at that granularity via import - skip rather than misfile them.
		if (!type) {
			skipped++;
			continue;
		}

		const ratingRaw = ratingCol ? row[ratingCol]?.trim() : "";

		items.push({
			title,
			year: yearCol ? row[yearCol]?.trim() || null : null,
			type,
			tmdbId: null,
			imdbId: constCol ? row[constCol]?.trim() || null : null,
			status: "completed",
			rating: ratingRaw ? clampRating(Number(ratingRaw)) : null,
			watchedAt: dateCol ? normalizeDate(row[dateCol]) : null,
		});
	}

	return { items, skipped, warnings: [] };
}
