import type { LibraryEntry } from "./notes";

const SHELF_SIZE = 12;

export interface WatchlistSections {
	favorites: LibraryEntry[];
	recentlyAdded: LibraryEntry[];
	recentlyWatched: LibraryEntry[];
	recentlyReleased: LibraryEntry[];
}

/** The effective "release" date for a title: a movie's release date, or a TV show's most recently aired episode. */
function releaseSignal(entry: LibraryEntry): string | null {
	const fm = entry.frontmatter;
	return fm.type === "movie" ? fm.release_date : fm.last_episode_air_date;
}

export function computeWatchlistSections(entries: LibraryEntry[]): WatchlistSections {
	const todayIso = new Date().toISOString().slice(0, 10);

	const favorites = entries
		.filter((e) => e.frontmatter.favorite)
		.sort((a, b) => a.frontmatter.title.localeCompare(b.frontmatter.title));

	const recentlyAdded = [...entries]
		.sort((a, b) => b.frontmatter.date_added.localeCompare(a.frontmatter.date_added))
		.slice(0, SHELF_SIZE);

	const recentlyWatched = entries
		.filter((e) => e.frontmatter.date_last_watched !== null)
		.sort((a, b) => b.frontmatter.date_last_watched!.localeCompare(a.frontmatter.date_last_watched!))
		.slice(0, SHELF_SIZE);

	// Only titles actively being followed (watching or planned) - already-completed
	// or dropped titles aren't waiting on new content, so they don't belong here.
	const recentlyReleased = entries
		.filter((e) => e.frontmatter.status === "watching" || e.frontmatter.status === "planned")
		.map((e) => ({ entry: e, signal: releaseSignal(e) }))
		.filter((x): x is { entry: LibraryEntry; signal: string } => x.signal !== null && x.signal <= todayIso)
		.sort((a, b) => b.signal.localeCompare(a.signal))
		.slice(0, SHELF_SIZE)
		.map((x) => x.entry);

	return { favorites, recentlyAdded, recentlyWatched, recentlyReleased };
}
