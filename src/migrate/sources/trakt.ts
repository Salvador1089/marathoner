import type { ParseResult, ParsedImportItem } from "../types";
import type { MediaType } from "../../models/title";

/**
 * Trakt's full export ("Settings > Data > Export All") is a zip of several
 * dozen JSON files mirroring its own API responses 1:1 - watched-movies.json,
 * watched-shows.json (per-title totals), watched-history-N.json (the actual
 * per-watch events, which is where TV's per-episode data lives), ratings-*.json,
 * and lists-watchlist.json. Every item carries `ids.tmdb` directly, so - like
 * Ryot - this needs no title/year matching at all, just merging.
 *
 * Only the files below are read; everything else in the export (comments,
 * network, hidden progress, notes, custom lists, etc.) isn't something
 * Marathoner tracks.
 */
export function parseTraktZip(files: Record<string, string>): ParseResult {
	const warnings: string[] = [];
	const byKey = new Map<string, ParsedImportItem>();

	const get = (name: string): unknown[] => {
		const raw = files[name];
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			warnings.push(`Couldn't parse ${name} - skipped.`);
			return [];
		}
	};

	const keyFor = (type: MediaType, tmdbId: number) => `${type}-${tmdbId}`;

	const ensure = (type: MediaType, tmdbId: number, title: string, year: number | null): ParsedImportItem => {
		const key = keyFor(type, tmdbId);
		let item = byKey.get(key);
		if (!item) {
			item = {
				title,
				year: year ? String(year) : null,
				type,
				tmdbId,
				imdbId: null,
				status: null,
				rating: null,
				watchedAt: null,
				episodes: type === "tv" ? [] : undefined,
			};
			byKey.set(key, item);
		}
		return item;
	};

	const latestDate = (a: string | null, b: string | null): string | null => {
		if (!a) return b;
		if (!b) return a;
		return a > b ? a : b;
	};

	// --- Movies watched (aggregate totals) ---
	for (const entry of get("watched-movies.json") as TraktWatchedMovie[]) {
		const tmdbId = entry.movie?.ids?.tmdb;
		if (!tmdbId) continue;
		const item = ensure("movie", tmdbId, entry.movie.title, entry.movie.year);
		item.status = "completed";
		item.watchedAt = latestDate(item.watchedAt, dateOnly(entry.last_watched_at));
	}

	// --- Shows watched (aggregate totals - only watchedAt here; status is
	// decided below once we know how many episodes were actually watched). ---
	for (const entry of get("watched-shows.json") as TraktWatchedShow[]) {
		const tmdbId = entry.show?.ids?.tmdb;
		if (!tmdbId) continue;
		const item = ensure("tv", tmdbId, entry.show.title, entry.show.year);
		item.watchedAt = latestDate(item.watchedAt, dateOnly(entry.last_watched_at));
	}

	// --- Full watch history (watched-history-1.json, -2.json, ...) - the
	// authoritative source for exactly which episodes were watched. ---
	const historyFiles = Object.keys(files).filter((name) => /^watched-history-\d+\.json$/.test(name));
	for (const name of historyFiles) {
		for (const entry of get(name) as TraktHistoryEntry[]) {
			if (entry.type === "movie" && entry.movie?.ids?.tmdb) {
				const item = ensure("movie", entry.movie.ids.tmdb, entry.movie.title, entry.movie.year);
				item.status = "completed";
				item.watchedAt = latestDate(item.watchedAt, dateOnly(entry.watched_at));
			} else if (entry.type === "episode" && entry.show?.ids?.tmdb && entry.episode) {
				const item = ensure("tv", entry.show.ids.tmdb, entry.show.title, entry.show.year);
				item.episodes!.push({ season: entry.episode.season, episode: entry.episode.number });
				item.watchedAt = latestDate(item.watchedAt, dateOnly(entry.watched_at));
			}
		}
	}

	// A show is "completed" only if every aired episode was actually watched;
	// otherwise it's "watching" - mirrors Marathoner's own auto-completion rule.
	for (const entry of get("watched-shows.json") as TraktWatchedShow[]) {
		const tmdbId = entry.show?.ids?.tmdb;
		if (!tmdbId) continue;
		const item = byKey.get(keyFor("tv", tmdbId));
		if (!item) continue;
		const watchedCount = new Set((item.episodes ?? []).map((e) => `${e.season}-${e.episode}`)).size;
		item.status = entry.show.aired_episodes > 0 && watchedCount >= entry.show.aired_episodes ? "completed" : "watching";
	}

	// --- Ratings ---
	for (const entry of get("ratings-movies.json") as TraktRating[]) {
		const tmdbId = entry.movie?.ids?.tmdb;
		if (!tmdbId || !entry.rating) continue;
		const item = ensure("movie", tmdbId, entry.movie!.title, entry.movie!.year);
		item.rating = entry.rating;
		if (!item.status) item.status = "completed";
	}
	for (const entry of get("ratings-shows.json") as TraktRating[]) {
		const tmdbId = entry.show?.ids?.tmdb;
		if (!tmdbId || !entry.rating) continue;
		const item = ensure("tv", tmdbId, entry.show!.title, entry.show!.year);
		item.rating = entry.rating;
	}

	// --- Watchlist (not yet watched) - only sets status if nothing above already did. ---
	for (const entry of get("lists-watchlist.json") as TraktWatchlistEntry[]) {
		const type: MediaType | null = entry.movie ? "movie" : entry.show ? "tv" : null;
		const media = entry.movie ?? entry.show;
		if (!type || !media?.ids?.tmdb) continue;
		const item = ensure(type, media.ids.tmdb, media.title, media.year);
		if (!item.status) item.status = "planned";
	}

	const foundAnyFile = Object.keys(files).some(
		(name) => name.startsWith("watched-") || name.startsWith("ratings-") || name.startsWith("lists-watchlist")
	);
	if (!foundAnyFile) {
		warnings.push("None of the expected Trakt export files were found in this zip (watched-*.json, ratings-*.json, lists-watchlist.json).");
	}

	return { items: Array.from(byKey.values()), skipped: 0, warnings };
}

function dateOnly(iso: string | null | undefined): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

interface TraktIds {
	tmdb: number | null;
}
interface TraktMovieRef {
	ids: TraktIds;
	title: string;
	year: number | null;
}
interface TraktShowRef {
	ids: TraktIds;
	title: string;
	year: number | null;
	aired_episodes: number;
}
interface TraktWatchedMovie {
	last_watched_at: string | null;
	movie: TraktMovieRef;
}
interface TraktWatchedShow {
	last_watched_at: string | null;
	show: TraktShowRef;
}
interface TraktHistoryEntry {
	type: "movie" | "episode" | string;
	watched_at: string | null;
	movie?: TraktMovieRef;
	show?: TraktShowRef;
	episode?: { season: number; number: number };
}
interface TraktRating {
	rating: number | null;
	movie?: TraktMovieRef;
	show?: TraktShowRef;
}
interface TraktWatchlistEntry {
	movie?: TraktMovieRef;
	show?: TraktShowRef;
}
