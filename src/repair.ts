import { App } from "obsidian";
import { TmdbClient } from "./tmdb/client";
import { enrichmentFromMovie, enrichmentFromTv } from "./tmdb/enrichment";
import { getLibraryEntries, resolveTitleFolder, LibraryEntry } from "./notes";
import { ensurePersonNotesForTitle, migratePersonNotes, backfillPersonImages } from "./people";
import { cacheAllSeasons } from "./episodes-cache";
import { migrateFileToFolder, waitForMetadataRefresh } from "./vault-helpers";
import { ensureImageCached } from "./image-cache";
import { CURRENT_SCHEMA_VERSION, applyTvCompletionRule, WatchedMap } from "./models/title";

export interface RepairResult {
	scanned: number;
	repaired: number;
	failed: number;
	moved: number;
}

export type RepairProgressCallback = (done: number, total: number) => void;

/**
 * "Dropped" means the person explicitly quit - never worth refreshing.
 * A completed movie's data is essentially permanent once released, so it's
 * safe to skip. A completed TV show is different: it can be renewed with a
 * new season at any point, so it must keep getting refreshed to notice that
 * and (via applyTvCompletionRule) automatically un-complete when it happens.
 */
function isWorthRefreshing(entry: LibraryEntry): boolean {
	const fm = entry.frontmatter;
	if (fm.status === "dropped") return false;
	if (fm.type === "movie" && fm.status === "completed") return false;
	return true;
}

export interface RepairOptions {
	libraryFolder: string;
	onlyActiveTitles: boolean;
	peopleFolder: string;
	createDirectorNotes: boolean;
	createCastNotes: boolean;
	storeImagesLocally: boolean;
	imagesFolder: string;
}

export interface SingleTitleRefreshOptions {
	peopleFolder: string;
	createDirectorNotes: boolean;
	createCastNotes: boolean;
	storeImagesLocally: boolean;
	imagesFolder: string;
}

/**
 * Re-fetches full metadata (including the synopsis) for a single title note
 * from TMDB and writes it back, refreshing the offline episode cache for TV
 * shows too. This is the single-note counterpart to repairLibrary's loop
 * body - used by both the bulk "Refresh library now" button and the
 * per-note manual "Refresh" button on the Detail view.
 */
export async function refreshOneTitleEntry(
	app: App,
	tmdb: TmdbClient,
	entry: LibraryEntry,
	options: SingleTitleRefreshOptions
): Promise<void> {
	const { file, frontmatter } = entry;
	const isTv = frontmatter.type === "tv";
	const movieDetails = isTv ? null : await tmdb.getMovie(frontmatter.tmdb_id);
	const tvDetails = isTv ? await tmdb.getTvShow(frontmatter.tmdb_id) : null;
	const enrichment = isTv ? enrichmentFromTv(tvDetails!) : enrichmentFromMovie(movieDetails!);

	await app.fileManager.processFrontMatter(file, (fm) => {
		fm.schema_version = CURRENT_SCHEMA_VERSION;
		fm.title = enrichment.title;
		fm.year = enrichment.year;
		fm.poster_path = enrichment.posterPath;
		fm.overview = enrichment.overview;
		fm.release_date = enrichment.releaseDate;
		fm.last_episode_air_date = enrichment.lastEpisodeAirDate;
		fm.next_episode_air_date = enrichment.nextEpisodeAirDate;
		fm.next_episode_label = enrichment.nextEpisodeLabel;
		fm.next_episode_season = enrichment.nextEpisodeSeason;
		fm.next_episode_number = enrichment.nextEpisodeNumber;
		fm.director = enrichment.director;
		fm.director_ids = enrichment.directorIds;
		fm.cast = enrichment.cast;
		fm.cast_ids = enrichment.castIds;
		fm.studio = enrichment.studio;
		fm.runtime = enrichment.runtime;
		fm.total_episodes = enrichment.totalEpisodes;
		if (isTv) {
			// New episodes may have aired since this note was last refreshed - if that
			// pushes total_episodes past what's watched, un-complete automatically.
			applyTvCompletionRule(fm, (fm.watched as WatchedMap) ?? {}, enrichment.totalEpisodes);
		}
		fm.community_rating = enrichment.communityRating;
		fm.community_votes = enrichment.communityVotes;
		fm.trailer_url = enrichment.trailerUrl;
		fm.imdb_url = enrichment.imdbUrl;
		fm.tmdb_synced_at = new Date().toISOString();
		// date_started is intentionally left untouched - it's user-owned state, not TMDB metadata.
		// date_modified is also intentionally left untouched - a metadata refresh isn't
		// user watch activity, and shouldn't push everything to the top of "Recently updated".
		// favorite and date_last_watched are likewise never touched here, for the same reason.
	});

	// Same reasoning as the person-note refresh: the caller (Detail view) may
	// re-read frontmatter from metadataCache right after this resolves - give
	// the cache a chance to catch up first so it doesn't flash a false
	// "malformed note" error.
	await waitForMetadataRefresh(app, file);

	if (isTv && tvDetails) {
		// Keep the offline episode cache in sync too - a new season airing
		// should be fully browsable/markable offline, not just detected.
		await cacheAllSeasons(app, tmdb, file, frontmatter.tmdb_id, tvDetails.seasons);
	}

	await ensureImageCached(
		app,
		options.storeImagesLocally,
		options.imagesFolder,
		"title",
		frontmatter.tmdb_id,
		enrichment.posterPath
	);

	await ensurePersonNotesForTitle(app, tmdb, options, enrichment.directorIds, enrichment.castIds);
}

/**
 * Re-fetches full metadata from TMDB for every note in the library and
 * writes it back via processFrontMatter. Useful after schema changes, for
 * notes created before caching was introduced, or simply to refresh stale
 * metadata (poster updates, cast/rating changes on TMDB's side). Also
 * backfills any missing person notes for directors/cast, if enabled, and
 * moves any note that isn't in its correct Movies/TV Shows/Directors/Cast
 * subfolder there.
 */
export async function repairLibrary(
	app: App,
	tmdb: TmdbClient,
	options: RepairOptions,
	onProgress?: RepairProgressCallback
): Promise<RepairResult> {
	const allEntries = getLibraryEntries(app, options.libraryFolder);
	const entries = options.onlyActiveTitles ? allEntries.filter(isWorthRefreshing) : allEntries;
	let repaired = 0;
	let failed = 0;
	let moved = 0;

	// Folder placement is a free, local fix - it must not be gated behind the
	// "only active titles" API-saving filter, or titles outside that filter
	// (completed/dropped) would never get moved into their correct subfolder.
	for (const { file, frontmatter } of allEntries) {
		const targetFolder = resolveTitleFolder(options.libraryFolder, frontmatter.type);
		if ((file.parent?.path ?? "") !== targetFolder) {
			await migrateFileToFolder(app, file, targetFolder);
			moved++;
		}
	}

	for (let i = 0; i < entries.length; i++) {
		try {
			await refreshOneTitleEntry(app, tmdb, entries[i], options);
			repaired++;
		} catch {
			failed++;
		}

		onProgress?.(i + 1, entries.length);
	}

	moved += await migratePersonNotes(app, options.peopleFolder);

	await backfillPersonImages(app, options.peopleFolder, options.storeImagesLocally, options.imagesFolder);

	return { scanned: entries.length, repaired, failed, moved };
}
