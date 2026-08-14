import { parseCsv, findColumn, clampRating, normalizeDate } from "../csv";
import type { ParseResult, ParsedImportItem } from "../types";

/**
 * Letterboxd's "Export your data" gives a zip with several CSVs
 * (watched.csv, ratings.csv, diary.csv, reviews.csv...) - the person uploads
 * whichever one they have. Common columns across them: Date, Name, Year,
 * Letterboxd URI, and (ratings.csv/diary.csv only) Rating. Letterboxd is
 * movies-only, no TV.
 */
export function parseLetterboxdExport(text: string): ParseResult {
	const { headers, rows } = parseCsv(text);

	const nameCol = findColumn(headers, "name", "title");
	const yearCol = findColumn(headers, "year");
	const ratingCol = findColumn(headers, "rating");
	const dateCol = findColumn(headers, "watched date", "date");

	if (!nameCol) {
		return { items: [], skipped: 0, warnings: ["Couldn't find a Name column - is this really a Letterboxd export CSV?"] };
	}

	const items: ParsedImportItem[] = [];

	for (const row of rows) {
		const title = row[nameCol]?.trim();
		if (!title) continue;

		// Letterboxd rates on a 0.5-5 star scale - map onto Marathoner's 0-10.
		const ratingRaw = ratingCol ? row[ratingCol]?.trim() : "";
		const rating = ratingRaw ? clampRating(Number(ratingRaw) * 2) : null;

		items.push({
			title,
			year: yearCol ? row[yearCol]?.trim() || null : null,
			type: "movie",
			tmdbId: null,
			imdbId: null,
			status: "completed",
			rating,
			watchedAt: dateCol ? normalizeDate(row[dateCol]) : null,
		});
	}

	return { items, skipped: 0, warnings: [] };
}
