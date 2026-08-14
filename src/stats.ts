import type { LibraryEntry } from "./notes";
import { countWatchedEpisodes } from "./models/title";

export interface NameCount {
	name: string;
	count: number;
	/** Present only for people (actors/directors) - lets the UI link to their note. */
	tmdbId?: number;
}

export interface LibraryStats {
	totalTitles: number;
	movieCount: number;
	tvCount: number;
	movieCompletedCount: number;
	tvCompletedCount: number;
	completedCount: number;
	watchingCount: number;
	timeWatchedMinutes: number;
	timeRemainingMinutes: number;
	movieWatchedMinutes: number;
	movieRemainingMinutes: number;
	moviePercentWatched: number | null;
	tvWatchedMinutes: number;
	tvRemainingMinutes: number;
	tvPercentWatched: number | null;
	recentlyAdded: LibraryEntry[];
	recentlyUpdated: LibraryEntry[];
	byYear: NameCount[];
	topActors: NameCount[];
	topDirectors: NameCount[];
	topStudios: NameCount[];
}

const RECENT_LIST_SIZE = 6;
const TOP_LIST_SIZE = 8;
// "By year" used to have no cap at all (grew forever) and then its own
// larger cap - both made it stick out next to the other nerd-stats boxes,
// which are all capped at TOP_LIST_SIZE. Same size, same "count desc" sort,
// for visual consistency.
const BY_YEAR_LIST_SIZE = TOP_LIST_SIZE;

function tallyNames(lists: string[][]): NameCount[] {
	const counts = new Map<string, number>();
	for (const list of lists) {
		for (const name of list) {
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}
	return Array.from(counts.entries())
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Same idea as tallyNames, but keyed by tmdb_id (not name) so the UI can
 * link each row to that person's note - and so two different people who
 * happen to share a name aren't merged into one row.
 */
function tallyPeople(names: string[][], ids: number[][]): NameCount[] {
	const counts = new Map<number, { name: string; count: number }>();
	for (let i = 0; i < names.length; i++) {
		const nameList = names[i];
		const idList = ids[i];
		for (let j = 0; j < nameList.length; j++) {
			const tmdbId = idList[j];
			if (tmdbId == null) continue;
			const existing = counts.get(tmdbId);
			if (existing) existing.count++;
			else counts.set(tmdbId, { name: nameList[j], count: 1 });
		}
	}
	return Array.from(counts.entries())
		.map(([tmdbId, v]) => ({ name: v.name, count: v.count, tmdbId }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function computeLibraryStats(entries: LibraryEntry[]): LibraryStats {
	let movieCount = 0;
	let tvCount = 0;
	let movieCompletedCount = 0;
	let tvCompletedCount = 0;
	let completedCount = 0;
	let watchingCount = 0;
	let timeWatchedMinutes = 0;
	let timeRemainingMinutes = 0;
	let movieWatchedMinutes = 0;
	let movieRemainingMinutes = 0;
	let tvWatchedMinutes = 0;
	let tvRemainingMinutes = 0;

	const yearCounts = new Map<string, number>();

	for (const { frontmatter: fm } of entries) {
		if (fm.type === "movie") movieCount++;
		else tvCount++;

		if (fm.status === "completed") {
			completedCount++;
			if (fm.type === "movie") movieCompletedCount++;
			else tvCompletedCount++;
		}
		if (fm.status === "watching") watchingCount++;

		if (fm.year) {
			yearCounts.set(fm.year, (yearCounts.get(fm.year) ?? 0) + 1);
		}

		if (fm.type === "movie") {
			if (fm.runtime !== null) {
				if (fm.status === "completed") {
					movieWatchedMinutes += fm.runtime;
				} else if (fm.status === "planned" || fm.status === "watching" || fm.status === "paused") {
					movieRemainingMinutes += fm.runtime;
				}
			}
		} else {
			const watchedEpisodes = countWatchedEpisodes(fm.watched);
			if (fm.runtime !== null) {
				tvWatchedMinutes += fm.runtime * watchedEpisodes;

				if (fm.total_episodes !== null && fm.status !== "dropped") {
					const remainingEpisodes = Math.max(0, fm.total_episodes - watchedEpisodes);
					tvRemainingMinutes += fm.runtime * remainingEpisodes;
				}
			}
		}
	}

	timeWatchedMinutes = movieWatchedMinutes + tvWatchedMinutes;
	timeRemainingMinutes = movieRemainingMinutes + tvRemainingMinutes;

	const moviePercentWatched =
		movieWatchedMinutes + movieRemainingMinutes > 0
			? Math.round((movieWatchedMinutes / (movieWatchedMinutes + movieRemainingMinutes)) * 100)
			: null;

	const tvPercentWatched =
		tvWatchedMinutes + tvRemainingMinutes > 0
			? Math.round((tvWatchedMinutes / (tvWatchedMinutes + tvRemainingMinutes)) * 100)
			: null;

	const byYear: NameCount[] = Array.from(yearCounts.entries())
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || b.name.localeCompare(a.name))
		.slice(0, BY_YEAR_LIST_SIZE);

	const recentlyAdded = [...entries]
		.sort((a, b) => b.frontmatter.date_added.localeCompare(a.frontmatter.date_added))
		.slice(0, RECENT_LIST_SIZE);

	const recentlyUpdated = [...entries]
		.sort((a, b) => b.frontmatter.date_modified.localeCompare(a.frontmatter.date_modified))
		.slice(0, RECENT_LIST_SIZE);

	return {
		totalTitles: entries.length,
		movieCount,
		tvCount,
		movieCompletedCount,
		tvCompletedCount,
		completedCount,
		watchingCount,
		timeWatchedMinutes,
		timeRemainingMinutes,
		movieWatchedMinutes,
		movieRemainingMinutes,
		moviePercentWatched,
		tvWatchedMinutes,
		tvRemainingMinutes,
		tvPercentWatched,
		recentlyAdded,
		recentlyUpdated,
		byYear,
		topActors: tallyPeople(
			entries.map((e) => e.frontmatter.cast),
			entries.map((e) => e.frontmatter.cast_ids)
		).slice(0, TOP_LIST_SIZE),
		topDirectors: tallyPeople(
			entries.map((e) => e.frontmatter.director),
			entries.map((e) => e.frontmatter.director_ids)
		).slice(0, TOP_LIST_SIZE),
		topStudios: tallyNames(entries.map((e) => e.frontmatter.studio)).slice(0, TOP_LIST_SIZE),
	};
}

export function formatMinutes(minutes: number): string {
	if (minutes <= 0) return "0h";

	const totalHours = Math.floor(minutes / 60);
	const mins = Math.round(minutes % 60);

	// Under a day, show hours/minutes as before. Past that, a library's watch
	// time reads as "3000h" instead of the far more legible "125d 5h" - days
	// are the natural unit once you're tracking a whole library, not one show.
	if (totalHours < 24) {
		return mins > 0 ? `${totalHours}h ${mins}m` : `${totalHours}h`;
	}

	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/** Human-friendly "last synced with TMDB" label, shared by the title and person Detail views. */
export function formatSyncedAt(iso: string | null): string {
	if (!iso) return "Never synced with TMDB";

	const then = new Date(iso).getTime();
	if (isNaN(then)) return "Never synced with TMDB";

	const diffMs = Date.now() - then;
	const diffMinutes = Math.floor(diffMs / (60 * 1000));
	const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
	const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

	if (diffMinutes < 1) return "Updated just now";
	if (diffMinutes < 60) return `Updated ${diffMinutes}m ago`;
	if (diffHours < 24) return `Updated ${diffHours}h ago`;
	if (diffDays === 1) return "Updated yesterday";
	if (diffDays < 30) return `Updated ${diffDays}d ago`;

	return `Updated ${new Date(iso).toISOString().slice(0, 10)}`;
}
