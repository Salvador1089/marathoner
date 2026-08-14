import { App, TFile } from "obsidian";
import type MarathonerPlugin from "./main";
import { enrichmentFromMovie, enrichmentFromTv } from "./tmdb/enrichment";
import { createOrOpenTitleNote, findExistingTitleNote } from "./notes";
import { ensurePersonNotesForTitle } from "./people";
import { cacheAllSeasons } from "./episodes-cache";
import { ensureImageCached } from "./image-cache";
import type { MediaType } from "./models/title";

/**
 * Adds a title to the library given a known TMDB id (skipping the search
 * step). Used both by the search modal (after the person picks a result) and
 * by clicking an unowned poster in a person's filmography.
 *
 * For TV shows, this also fetches and caches every season's full episode
 * list before returning - one round of calls at add time, so the show is
 * completely usable offline immediately afterwards (browsing episodes,
 * marking them watched), not just its top-level metadata.
 */
export async function addTitleFromTmdb(app: App, plugin: MarathonerPlugin, tmdbId: number, type: MediaType): Promise<TFile> {
	// Already in the library - just open it. Re-running the full add flow
	// (season/episode caching, image download, person notes) on a title
	// that's already tracked would be pure waste, and risk clobbering local
	// state (watched episodes, etc.) that createOrOpenTitleNote itself
	// already guards against, but the callers of THIS function don't need to
	// know that - they can just always call addTitleFromTmdb and get the
	// right thing back either way.
	const existing = findExistingTitleNote(app, tmdbId, type);
	if (existing) return existing;

	if (type === "movie") {
		const details = await plugin.tmdb.getMovie(tmdbId);
		const enrichment = enrichmentFromMovie(details);

		const file = await createOrOpenTitleNote({
			app,
			libraryFolder: plugin.settings.libraryFolder,
			tmdbId,
			type,
			enrichment,
		});

		await ensureImageCached(
			app,
			plugin.settings.storeImagesLocally,
			plugin.settings.imagesFolder,
			"title",
			tmdbId,
			enrichment.posterPath
		);

		void ensurePersonNotesForTitle(app, plugin.tmdb, plugin.settings, enrichment.directorIds, enrichment.castIds);

		await plugin.logAction(`Movie added: "${enrichment.title}".`);

		return file;
	}

	const details = await plugin.tmdb.getTvShow(tmdbId);
	const enrichment = enrichmentFromTv(details);

	const file = await createOrOpenTitleNote({
		app,
		libraryFolder: plugin.settings.libraryFolder,
		tmdbId,
		type,
		enrichment,
	});

	// Awaited on purpose: the point is that by the time this returns, the show
	// is fully ready for offline use - not just top-level metadata.
	await cacheAllSeasons(app, plugin.tmdb, file, tmdbId, details.seasons);

	await ensureImageCached(
		app,
		plugin.settings.storeImagesLocally,
		plugin.settings.imagesFolder,
		"title",
		tmdbId,
		enrichment.posterPath
	);

	void ensurePersonNotesForTitle(app, plugin.tmdb, plugin.settings, enrichment.directorIds, enrichment.castIds);

	await plugin.logAction(`TV show added: "${enrichment.title}".`);

	return file;
}
