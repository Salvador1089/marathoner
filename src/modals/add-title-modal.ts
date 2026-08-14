import { App, SuggestModal, Notice, TFile } from "obsidian";
import type MarathonerPlugin from "../main";
import { TmdbClient } from "../tmdb/client";
import type { TmdbSearchResult } from "../tmdb/types";
import { addTitleFromTmdb } from "../add-title";
import { openTitleDetail } from "../views/open-title-detail";
import { findExistingTitleNote, getLibraryEntries } from "../notes";
import type { MediaType } from "../models/title";

const DEBOUNCE_MS = 350;

export class AddTitleModal extends SuggestModal<TmdbSearchResult> {
	private debounceTimer: number | null = null;
	// Snapshot of what's already in the library, taken once when the modal
	// opens - just for the "In library" tag on search results. It doesn't
	// need to track adds made mid-search (a rare, harmless staleness), and
	// findExistingTitleNote() is still what actually decides on selection.
	private libraryIds = new Set<string>();

	constructor(
		app: App,
		private plugin: MarathonerPlugin
	) {
		super(app);
		this.setPlaceholder("Search for a movie or TV show...");
		for (const { frontmatter } of getLibraryEntries(app, plugin.settings.libraryFolder)) {
			this.libraryIds.add(`${frontmatter.type}-${frontmatter.tmdb_id}`);
		}
	}

	// getSuggestions supports returning a Promise natively - Obsidian awaits it
	// before rendering. The debounce avoids hitting the TMDB API on every keystroke.
	getSuggestions(query: string): Promise<TmdbSearchResult[]> {
		if (query.trim().length < 2) {
			return Promise.resolve([]);
		}

		if (this.debounceTimer) {
			window.clearTimeout(this.debounceTimer);
		}

		return new Promise((resolve) => {
			this.debounceTimer = window.setTimeout(async () => {
				try {
					const response = await this.plugin.tmdb.search(query);
					const relevant = response.results.filter(
						(r) => r.media_type === "movie" || r.media_type === "tv"
					);
					resolve(relevant);
				} catch (err) {
					new Notice(`TMDB search failed: ${(err as Error).message}`);
					resolve([]);
				}
			}, DEBOUNCE_MS);
		});
	}

	renderSuggestion(result: TmdbSearchResult, el: HTMLElement): void {
		const container = el.createDiv({ cls: "marathoner-search-result" });

		const poster = TmdbClient.posterUrl(result.poster_path, "w200");
		if (poster) {
			container.createEl("img", {
				attr: { src: poster },
				cls: "marathoner-search-result-poster",
			});
		}

		const info = container.createDiv({ cls: "marathoner-search-result-info" });
		const name = result.title ?? result.name ?? "Untitled";
		const date = result.release_date ?? result.first_air_date;
		const year = date ? date.slice(0, 4) : "";
		const type: MediaType = result.media_type === "movie" ? "movie" : "tv";
		const typeLabel = type === "movie" ? "Movie" : "TV show";

		const titleRow = info.createDiv({ cls: "marathoner-search-result-title-row" });
		titleRow.createSpan({
			text: year ? `${name} (${year})` : name,
			cls: "marathoner-search-result-title",
		});
		if (this.libraryIds.has(`${type}-${result.id}`)) {
			titleRow.createSpan({ text: "In library", cls: "marathoner-search-result-badge" });
		}
		info.createEl("div", {
			text: typeLabel,
			cls: "marathoner-search-result-type",
		});
	}

	async onChooseSuggestion(result: TmdbSearchResult): Promise<void> {
		const type: MediaType = result.media_type === "movie" ? "movie" : "tv";
		const name = result.title ?? result.name ?? "title";

		const alreadyInLibrary = findExistingTitleNote(this.app, result.id, type) !== null;
		const notice = new Notice(
			alreadyInLibrary
				? `Opening "${name}" - already in your library...`
				: type === "tv"
					? `Adding "${name}" (fetching episodes)...`
					: `Adding "${name}"...`,
			0
		);

		try {
			const file: TFile = await addTitleFromTmdb(this.app, this.plugin, result.id, type);
			notice.hide();
			await openTitleDetail(this.app, file);
		} catch (err) {
			notice.hide();
			new Notice(`Could not create note: ${(err as Error).message}`);
		}
	}
}
