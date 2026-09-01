export const CURRENT_SCHEMA_VERSION = 8;

export type MediaType = "movie" | "tv";

export type WatchStatus = "watching" | "completed" | "planned" | "paused" | "dropped";

/** Key = season number, value = array of watched episode numbers. */
export type WatchedMap = Record<number, number[]>;

/** Key = season number, then episode number, value = personal rating (1-10). */
export type EpisodeRatingMap = Record<number, Record<number, number>>;

/**
 * Exact shape of the YAML frontmatter for each title note.
 * Keep this in sync with what is read/written across the codebase -
 * this is the source of truth for the schema.
 */
export interface TitleFrontmatter {
	schema_version: number;
	tmdb_id: number;
	type: MediaType;
	status: WatchStatus;
	rating: number | null; // 0-10, personal rating
	date_added: string; // ISO date (YYYY-MM-DD)
	date_modified: string; // full ISO datetime - set only on meaningful updates (status, rating, episodes), not note edits
	date_last_watched: string | null; // full ISO datetime - set only when an episode is watched or a movie is completed
	date_started: string | null;
	date_completed: string | null;
	watched?: WatchedMap; // only relevant for type: "tv"
	episode_ratings?: EpisodeRatingMap; // only relevant for type: "tv"
	favorite: boolean;

	// Cached display fields, captured at creation time so views can render
	// without re-fetching TMDB for every note on every open.
	title: string;
	year: string | null;
	poster_path: string | null;
	overview: string | null; // synopsis, cached so it's available offline too - never left as a "loading" placeholder
	release_date: string | null; // movies: full TMDB release date. Null for TV (use last_episode_air_date instead).
	last_episode_air_date: string | null; // TV only: air date of the most recently aired episode.
	next_episode_air_date: string | null; // TV only: air date of the next episode, if scheduled.
	next_episode_label: string | null; // TV only: e.g. "S3E5 - Winter's Coming"
	next_episode_season: number | null; // TV only: structured season number, so Upcoming can check watched-status precisely
	next_episode_number: number | null; // TV only: structured episode number, same reason
	tmdb_synced_at: string | null; // ISO datetime of the last successful TMDB fetch for this note (creation or refresh)

	// Enriched metadata, also cached at creation time (and via Repair).
	director: string[]; // movies: crew with job "Director". TV: created_by.
	director_ids: number[]; // TMDB person ids, parallel to director[] - enables precise cross-referencing.
	cast: string[]; // top-billed cast, capped
	cast_ids: number[]; // TMDB person ids, parallel to cast[]
	studio: string[]; // production_companies (movie) or networks (tv)
	runtime: number | null; // minutes - movie runtime, or TV episode runtime
	total_episodes: number | null; // TV only - from TMDB number_of_episodes, needed for "time remaining"
	community_rating: number | null; // TMDB vote_average
	community_votes: number | null; // TMDB vote_count
	trailer_url: string | null; // YouTube URL, if a trailer exists
	imdb_url: string | null;
}

/** Metadata fetched from TMDB that gets cached into the frontmatter. */
export interface TitleEnrichment {
	title: string;
	year: string | null;
	posterPath: string | null;
	overview: string | null;
	releaseDate: string | null;
	lastEpisodeAirDate: string | null;
	nextEpisodeAirDate: string | null;
	nextEpisodeLabel: string | null;
	nextEpisodeSeason: number | null;
	nextEpisodeNumber: number | null;
	director: string[];
	directorIds: number[];
	cast: string[];
	castIds: number[];
	studio: string[];
	runtime: number | null;
	totalEpisodes: number | null;
	communityRating: number | null;
	communityVotes: number | null;
	trailerUrl: string | null;
	imdbUrl: string | null;
}

export function createDefaultFrontmatter(
	tmdbId: number,
	type: MediaType,
	enrichment: TitleEnrichment
): TitleFrontmatter {
	return {
		schema_version: CURRENT_SCHEMA_VERSION,
		tmdb_id: tmdbId,
		type,
		status: "planned",
		rating: null,
		date_added: new Date().toISOString().slice(0, 10),
		date_modified: new Date().toISOString(),
		date_last_watched: null,
		date_started: null,
		date_completed: null,
		watched: type === "tv" ? {} : undefined,
		episode_ratings: type === "tv" ? {} : undefined,
		favorite: false,
		title: enrichment.title,
		year: enrichment.year,
		poster_path: enrichment.posterPath,
		overview: enrichment.overview,
		release_date: enrichment.releaseDate,
		last_episode_air_date: enrichment.lastEpisodeAirDate,
		next_episode_air_date: enrichment.nextEpisodeAirDate,
		next_episode_label: enrichment.nextEpisodeLabel,
		next_episode_season: enrichment.nextEpisodeSeason,
		next_episode_number: enrichment.nextEpisodeNumber,
		tmdb_synced_at: new Date().toISOString(),
		director: enrichment.director,
		director_ids: enrichment.directorIds,
		cast: enrichment.cast,
		cast_ids: enrichment.castIds,
		studio: enrichment.studio,
		runtime: enrichment.runtime,
		total_episodes: enrichment.totalEpisodes,
		community_rating: enrichment.communityRating,
		community_votes: enrichment.communityVotes,
		trailer_url: enrichment.trailerUrl,
		imdb_url: enrichment.imdbUrl,
	};
}

/** Checks whether a specific episode is marked as watched. */
export function isEpisodeWatched(fm: TitleFrontmatter, season: number, episode: number): boolean {
	return fm.watched?.[season]?.includes(episode) ?? false;
}

/** Toggles a single episode. Returns a new WatchedMap (immutable). */
export function toggleEpisode(
	watched: WatchedMap,
	season: number,
	episode: number
): WatchedMap {
	const current = watched[season] ?? [];
	const isWatched = current.includes(episode);
	const updated = isWatched
		? current.filter((e) => e !== episode)
		: [...current, episode].sort((a, b) => a - b);

	return { ...watched, [season]: updated };
}

/** Returns the personal rating for one episode, if it has one. */
export function getEpisodeRating(ratings: EpisodeRatingMap | undefined, season: number, episode: number): number | null {
	return ratings?.[season]?.[episode] ?? null;
}

/**
 * Sets or clears one episode rating without mutating the existing map. Empty
 * season entries are removed so hand-readable frontmatter stays compact.
 */
export function setEpisodeRating(
	ratings: EpisodeRatingMap,
	season: number,
	episode: number,
	rating: number | null
): EpisodeRatingMap {
	const seasonRatings = { ...(ratings[season] ?? {}) };

	if (rating === null) {
		delete seasonRatings[episode];
	} else {
		seasonRatings[episode] = rating;
	}

	if (Object.keys(seasonRatings).length === 0) {
		const next = { ...ratings };
		delete next[season];
		return next;
	}

	return { ...ratings, [season]: seasonRatings };
}

/** True once an episode's air date has passed (or is today). Episodes with no
 *  known air date, or a future one, are never considered aired - this is what
 *  stops "mark season watched" from claiming you've seen episodes that
 *  haven't broadcast yet. */
export function isEpisodeAired(episode: CachedEpisode, today: string = new Date().toISOString().slice(0, 10)): boolean {
	return episode.airDate !== null && episode.airDate <= today;
}

/** How many episodes of a season have actually aired so far - the real
 *  ceiling for "mark season watched" (as opposed to the season's full,
 *  eventual episode count, which may include unaired episodes). */
export function airedEpisodeCount(episodes: CachedEpisode[], today?: string): number {
	return episodes.filter((e) => isEpisodeAired(e, today)).length;
}

/** Marks every *aired* episode of a season as watched. Deliberately excludes
 *  unaired/unannounced episodes - you can't have watched something that
 *  hasn't been broadcast yet. */
export function markSeasonWatched(watched: WatchedMap, season: number, episodes: CachedEpisode[]): WatchedMap {
	const today = new Date().toISOString().slice(0, 10);
	const airedNumbers = episodes.filter((e) => isEpisodeAired(e, today)).map((e) => e.number);
	return { ...watched, [season]: airedNumbers };
}

/** Clears all watched episodes for a season. */
export function unmarkSeasonWatched(watched: WatchedMap, season: number): WatchedMap {
	return { ...watched, [season]: [] };
}

/** Total count of watched episodes across all seasons, for stats. */
export function countWatchedEpisodes(watched: WatchedMap | undefined): number {
	if (!watched) return 0;
	return Object.values(watched).reduce((sum, eps) => sum + eps.length, 0);
}

/**
 * The single rule that decides whether a TV show counts as "completed":
 * reachable only by watching every episode, never by manual selection.
 * Also handles the reverse - if new episodes appear (a season airs) after
 * the show was marked completed, it automatically un-completes, since the
 * person hasn't actually seen the new content yet. Call this any time the
 * watched map or the total episode count changes.
 */
export function applyTvCompletionRule(
	fm: Record<string, unknown>,
	watched: WatchedMap,
	totalEpisodes: number | null
): void {
	if (totalEpisodes === null || totalEpisodes <= 0) return;

	const watchedCount = countWatchedEpisodes(watched);
	const isNowComplete = watchedCount >= totalEpisodes;
	const wasComplete = fm.status === "completed";

	if (isNowComplete && !wasComplete) {
		fm.status = "completed";
		fm.date_completed = new Date().toISOString().slice(0, 10);
	} else if (!isNowComplete && wasComplete) {
		// New content became available (or an episode got unmarked) after completion - un-complete.
		fm.status = "watching";
		fm.date_completed = null;
	}
}

/** Full episode-level structure, cached in the note body (not frontmatter -
 *  it's nested and would be unwieldy as hand-written YAML). Populated in full
 *  when a TV title is added, so the show is completely usable offline right
 *  away, not just its top-level metadata. */
export interface CachedEpisode {
	number: number;
	name: string;
	airDate: string | null;
}

export interface CachedSeason {
	seasonNumber: number;
	name: string;
	episodes: CachedEpisode[];
}
