import type { App } from "obsidian";
import type { LibraryEntry } from "./notes";
import { readEpisodesCache } from "./notes";
import type { CachedEpisode } from "./models/title";

export interface UpcomingItem {
	entry: LibraryEntry;
	date: string; // ISO date - the next episode's air date, or the movie's release date
	label: string; // e.g. "S03E05 - Winter's Coming", or "Movie release"
	daysUntil: number; // 0 = today
	/** "Every Thursday" etc, derived from the air date's weekday - TV only. Movies have no recurring cadence. */
	cadence: string | null;
	/** TV only - which season `label` belongs to. Lets the UI offer "add the rest of this season to my calendar" without a second read of the episode cache. */
	season: number | null;
}

/**
 * Everything in the library with a next episode or release date still ahead
 * of today - a simple "what's coming, and when" list. Sorted soonest first.
 */
export async function computeUpcoming(app: App, entries: LibraryEntry[]): Promise<UpcomingItem[]> {
	const todayIso = new Date().toISOString().slice(0, 10);
	const items: UpcomingItem[] = [];

	for (const entry of entries) {
		const fm = entry.frontmatter;
		if (fm.status === "dropped") continue;

		if (fm.type === "tv") {
			const seasons = await readEpisodesCache(app, entry.file);
			const next = flattenEpisodes(seasons).find((e) => e.airDate && e.airDate >= todayIso);
			if (!next || !next.airDate) continue;

			items.push({
				entry,
				date: next.airDate,
				label: `S${pad(next.season)}E${pad(next.number)} - ${next.name}`,
				daysUntil: daysBetween(todayIso, next.airDate),
				cadence: weekdayCadence(next.airDate),
				season: next.season,
			});
		} else if (fm.type === "movie" && fm.release_date && fm.release_date >= todayIso) {
			items.push({
				entry,
				date: fm.release_date,
				label: "Movie release",
				daysUntil: daysBetween(todayIso, fm.release_date),
				cadence: null,
				season: null,
			});
		}
	}

	return items.sort((a, b) => a.date.localeCompare(b.date));
}

export interface FlatEpisode {
	season: number;
	number: number;
	name: string;
	airDate: string | null;
}

export function flattenEpisodes(seasons: { seasonNumber: number; episodes: CachedEpisode[] }[]): FlatEpisode[] {
	const flat: FlatEpisode[] = [];
	for (const season of [...seasons].sort((a, b) => a.seasonNumber - b.seasonNumber)) {
		for (const episode of [...season.episodes].sort((a, b) => a.number - b.number)) {
			flat.push({ season: season.seasonNumber, number: episode.number, name: episode.name, airDate: episode.airDate });
		}
	}
	return flat;
}

function daysBetween(fromIso: string, toIso: string): number {
	const from = new Date(fromIso + "T00:00:00").getTime();
	const to = new Date(toIso + "T00:00:00").getTime();
	return Math.round((to - from) / (1000 * 60 * 60 * 24));
}

function weekdayCadence(dateIso: string): string {
	const date = new Date(dateIso + "T00:00:00");
	return `Every ${date.toLocaleDateString(undefined, { weekday: "long" })}`;
}

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}
