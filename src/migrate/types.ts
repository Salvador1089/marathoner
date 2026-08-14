import type { MediaType } from "../models/title";

export type ImportSource = "trakt" | "letterboxd" | "simkl" | "imdb" | "ryot";

export type ImportStatus = "watching" | "completed" | "planned" | "dropped" | "on_hold";

export interface ParsedImportItem {
	/** Display title. For Ryot (which doesn't export titles) this is a placeholder - the real title comes from TMDB once matched. */
	title: string;
	year: string | null;
	/** null when the source file doesn't say - resolved via a fallback picked in the modal, or left for matching to sort out. */
	type: MediaType | null;
	tmdbId: number | null;
	imdbId: string | null;
	status: ImportStatus | null;
	rating: number | null; // normalized to a 0-10 scale
	watchedAt: string | null; // ISO date (yyyy-mm-dd), best-known "last watched"/"rated on" date
	/** TV only, and only when the source tracks episode-level progress (currently just Ryot). */
	episodes?: { season: number; episode: number }[];
}

export interface ParseResult {
	items: ParsedImportItem[];
	/** Rows that were recognized but intentionally not imported (e.g. a book from a Ryot export, an unrecognized IMDb title type). */
	skipped: number;
	warnings: string[];
}
