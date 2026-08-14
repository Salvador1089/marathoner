import type { ParseResult, ParsedImportItem, ImportStatus } from "../types";
import type { MediaType } from "../../models/title";

/**
 * Ryot's export (Settings > Imports and Exports > Export, or the file used
 * with its own "Generic JSON Importer") is a single JSON file following its
 * documented `CompleteExport` schema. Each `metadata` entry has a `source`
 * ("tmdb", "tvdb", "custom", ...) and an `identifier` - when the source is
 * "tmdb", that identifier IS the TMDB id, which makes this the most
 * reliable of all five imports: no title/year matching needed at all.
 * Entries from other sources (tvdb-only shows, custom entries) don't carry
 * a title in this export format, so there's nothing usable to match them
 * against - they're skipped rather than guessed at.
 */
export function parseRyotExport(jsonText: string): ParseResult {
	let data: unknown;
	try {
		data = JSON.parse(jsonText);
	} catch {
		return {
			items: [],
			skipped: 0,
			warnings: ["This doesn't look like valid JSON. Use the file from Ryot's Export tab (Imports and Exports settings)."],
		};
	}

	const metadata = (data as { metadata?: unknown[] })?.metadata;
	if (!Array.isArray(metadata)) {
		return { items: [], skipped: 0, warnings: ["No \"metadata\" array found - is this a Ryot CompleteExport file?"] };
	}

	const items: ParsedImportItem[] = [];
	let skipped = 0;

	for (const raw of metadata) {
		const m = raw as RyotMetadataItem;
		if (m.lot !== "movie" && m.lot !== "show") {
			skipped++;
			continue;
		}
		if (m.source !== "tmdb") {
			skipped++;
			continue;
		}

		const tmdbId = Number(m.identifier);
		if (!tmdbId || isNaN(tmdbId)) {
			skipped++;
			continue;
		}

		const type: MediaType = m.lot === "movie" ? "movie" : "tv";
		const seenHistory = m.seen_history ?? [];
		const reviews = m.reviews ?? [];

		items.push({
			title: `TMDB #${tmdbId}`, // Ryot doesn't export a title - resolved from TMDB during matching.
			year: null,
			type,
			tmdbId,
			imdbId: null,
			status: deriveStatus(seenHistory),
			rating: deriveOverallRating(reviews),
			watchedAt: deriveWatchedAt(seenHistory),
			episodes: type === "tv" ? deriveWatchedEpisodes(seenHistory) : undefined,
		});
	}

	return { items, skipped, warnings: [] };
}

interface RyotSeen {
	state: "dropped" | "on_a_hold" | "completed" | "in_progress" | null;
	started_on: string | null;
	ended_on: string | null;
	show_season_number: number | null;
	show_episode_number: number | null;
}

interface RyotRating {
	rating: string | null;
	show_season_number: number | null;
	show_episode_number: number | null;
}

interface RyotMetadataItem {
	lot: string;
	source: string;
	identifier: string;
	seen_history?: RyotSeen[];
	reviews?: RyotRating[];
}

function deriveStatus(seenHistory: RyotSeen[]): ImportStatus {
	if (seenHistory.some((s) => (s.state ?? "completed") === "completed")) return "completed";
	if (seenHistory.some((s) => s.state === "in_progress")) return "watching";
	if (seenHistory.some((s) => s.state === "dropped")) return "dropped";
	if (seenHistory.some((s) => s.state === "on_a_hold")) return "on_hold";
	return "planned";
}

function deriveWatchedAt(seenHistory: RyotSeen[]): string | null {
	const dates = seenHistory.map((s) => s.ended_on ?? s.started_on).filter((d): d is string => !!d);
	if (dates.length === 0) return null;
	return dates.sort().pop() ?? null;
}

/** The show/season-level overall rating - not a per-episode one. */
function deriveOverallRating(reviews: RyotRating[]): number | null {
	const overall = reviews.find((r) => r.show_season_number == null && r.show_episode_number == null && r.rating != null);
	if (!overall?.rating) return null;

	const raw = Number(overall.rating);
	if (!isFinite(raw)) return null;

	// Ryot's rating scale is user-configurable (out of 10, out of 100, or a
	// 3-point smiley face) - anything clearly above 10 is treated as "out of 100".
	const normalized = raw > 10 ? raw / 10 : raw;
	return Math.max(0, Math.min(10, Math.round(normalized)));
}

function deriveWatchedEpisodes(seenHistory: RyotSeen[]): { season: number; episode: number }[] {
	return seenHistory
		.filter(
			(s) =>
				s.show_season_number != null && s.show_episode_number != null && (s.state ?? "completed") === "completed"
		)
		.map((s) => ({ season: s.show_season_number as number, episode: s.show_episode_number as number }));
}
