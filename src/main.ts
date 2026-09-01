import { Plugin, Notice, TFile } from "obsidian";
import { MarathonerSettings, MarathonerSettingTab, DEFAULT_SETTINGS } from "./settings";
import { TmdbClient } from "./tmdb/client";
import { AddTitleModal } from "./modals/add-title-modal";
import { MigrateModal } from "./modals/migrate-modal";
import { WatchlistView, VIEW_TYPE_WATCHLIST } from "./views/watchlist-view";
import { DetailView, VIEW_TYPE_DETAIL } from "./views/detail-view";
import { DashboardView, VIEW_TYPE_DASHBOARD } from "./views/dashboard-view";
import { PersonDetailView, VIEW_TYPE_PERSON_DETAIL } from "./views/person-detail-view";
import { UpcomingView, VIEW_TYPE_UPCOMING } from "./views/upcoming-view";
import { LogView, VIEW_TYPE_LOG } from "./views/log-view";
import { activateWatchlistView } from "./views/activate-watchlist-view";
import { activateDashboardView } from "./views/activate-dashboard-view";
import { activateUpcomingView } from "./views/activate-upcoming-view";
import { activateLogView } from "./views/activate-log-view";
import { repairLibrary, refreshOneTitleEntry, RepairResult, RepairProgressCallback } from "./repair";
import { parsePersonFrontmatter, refreshOnePerson, resolvePersonFolder } from "./people";
import { getLibraryEntries, type LibraryEntry } from "./notes";
import { pushLogEntry } from "./activity-log";
import { ensureImageCached, isImageCached, type ImageKind } from "./image-cache";
import { ensureFolderExists } from "./vault-helpers";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const IMAGE_CACHE_CONCURRENCY = 4;

interface ImageCacheTask {
	kind: ImageKind;
	tmdbId: number;
	path: string;
}

export default class MarathonerPlugin extends Plugin {
	settings!: MarathonerSettings;
	tmdb!: TmdbClient;
	isRefreshing = false;
	isCachingImages = false;
	private imageCacheGeneration = 0;

	async onload() {
		await this.loadSettings();
		this.tmdb = this.createTmdbClient();

		this.addSettingTab(new MarathonerSettingTab(this.app, this));

		this.registerView(VIEW_TYPE_DASHBOARD, (leaf) => new DashboardView(leaf, this));
		this.registerView(VIEW_TYPE_WATCHLIST, (leaf) => new WatchlistView(leaf, this));
		this.registerView(VIEW_TYPE_DETAIL, (leaf) => new DetailView(leaf, this));
		this.registerView(VIEW_TYPE_PERSON_DETAIL, (leaf) => new PersonDetailView(leaf, this));
		this.registerView(VIEW_TYPE_UPCOMING, (leaf) => new UpcomingView(leaf, this));
		this.registerView(VIEW_TYPE_LOG, (leaf) => new LogView(leaf, this));

		// The dashboard is the app's entry point - not the watchlist.
		this.addRibbonIcon("clapperboard", "Open Marathoner", () => {
			activateDashboardView(this.app);
		});

		this.addCommand({
			id: "marathoner-open-dashboard",
			name: "Dashboard",
			callback: () => activateDashboardView(this.app),
		});

		this.addCommand({
			id: "marathoner-open-watchlist",
			name: "Open watchlist",
			callback: () => activateWatchlistView(this.app),
		});

		this.addCommand({
			id: "marathoner-open-upcoming",
			name: "Upcoming",
			callback: () => activateUpcomingView(this.app),
		});

		this.addCommand({
			id: "marathoner-open-log",
			name: "Open activity log",
			callback: () => activateLogView(this.app),
		});

		this.addCommand({
			id: "marathoner-import",
			name: "Import from another app",
			callback: () => new MigrateModal(this.app, this).open(),
		});

		this.addCommand({
			id: "marathoner-add-title",
			name: "Add title",
			callback: () => {
				new AddTitleModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: "marathoner-say-hello",
			name: "Say hello",
			callback: () => {
				new Notice("Marathoner is alive");
			},
		});

		// Deferred until after startup - never block Obsidian's boot on network calls.
		this.app.workspace.onLayoutReady(() => {
			void this.runStartupTasks();
		});
	}

	onunload() {
		// Let in-flight requests finish, but stop workers from starting any more
		// downloads after the plugin has been disabled/reloaded.
		this.imageCacheGeneration += 1;
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Object.assign only shallow-merges - visibleShelves is a nested object,
		// so an existing saved settings blob would otherwise silently overwrite
		// the whole thing, leaving any shelf toggle added in a later version
		// (like the per-status ones) undefined instead of defaulting to visible.
		this.settings.visibleShelves = Object.assign({}, DEFAULT_SETTINGS.visibleShelves, data?.visibleShelves);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.tmdb = this.createTmdbClient();
	}

	private createTmdbClient(): TmdbClient {
		return new TmdbClient(this.settings.tmdbApiKey, this.settings.tmdbLanguage);
	}

	private async runStartupTasks(): Promise<void> {
		await this.maybeAutoRefresh();
		if (this.settings.storeImagesLocally) {
			await this.cacheMissingImages(false);
		}
	}

	/**
	 * Backfills posters/photos already represented in cached frontmatter. This
	 * needs no TMDB API calls: it downloads the known image paths directly and
	 * can safely resume on the next startup because existing files are skipped.
	 */
	async cacheMissingImages(showNotice = true): Promise<void> {
		if (!this.settings.storeImagesLocally || this.isCachingImages) return;

		const tasks: ImageCacheTask[] = [];
		const seen = new Set<string>();
		const addTask = (kind: ImageKind, tmdbId: number, path: string | null): void => {
			if (!path) return;
			const key = `${kind}:${tmdbId}`;
			if (seen.has(key) || isImageCached(this.app, this.settings.imagesFolder, kind, tmdbId, path)) return;
			seen.add(key);
			tasks.push({ kind, tmdbId, path });
		};

		for (const { frontmatter } of getLibraryEntries(this.app, this.settings.libraryFolder)) {
			addTask("title", frontmatter.tmdb_id, frontmatter.poster_path);
		}

		const peopleFolder = resolvePersonFolder(this.settings.peopleFolder);
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(`${peopleFolder}/`)) continue;
			const raw = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const person = parsePersonFrontmatter(raw);
			if (person) addTask("person", person.tmdb_id, person.profile_path);
		}

		if (tasks.length === 0) {
			if (showNotice) new Notice("All Marathoner images are already stored locally.");
			return;
		}

		this.isCachingImages = true;
		const generation = ++this.imageCacheGeneration;
		const notice = showNotice ? new Notice(`Storing images locally... 0/${tasks.length}`, 0) : null;
		let nextTask = 0;
		let completed = 0;
		let cached = 0;

		try {
			await ensureFolderExists(this.app.vault, this.settings.imagesFolder);

			const worker = async (): Promise<void> => {
				while (
					this.settings.storeImagesLocally &&
					generation === this.imageCacheGeneration &&
					nextTask < tasks.length
				) {
					const task = tasks[nextTask++];
					const success = await ensureImageCached(
						this.app,
						true,
						this.settings.imagesFolder,
						task.kind,
						task.tmdbId,
						task.path
					);
					if (success) cached += 1;
					completed += 1;
					if (notice && (completed === tasks.length || completed % 5 === 0)) {
						notice.setMessage(`Storing images locally... ${completed}/${tasks.length}`);
					}
				}
			};

			const workerCount = Math.min(IMAGE_CACHE_CONCURRENCY, tasks.length);
			await Promise.all(Array.from({ length: workerCount }, () => worker()));
		} catch (err) {
			if (showNotice && generation === this.imageCacheGeneration) {
				new Notice(`Could not store images locally: ${(err as Error).message}`);
			}
		} finally {
			notice?.hide();
			if (generation === this.imageCacheGeneration) this.isCachingImages = false;
		}

		if (showNotice && completed > 0 && generation === this.imageCacheGeneration) {
			new Notice(`Stored ${cached} of ${completed} image(s) locally.`);
		}
	}

	/**
	 * Records one line in the activity log (Marathoner: activity log view) and
	 * persists it right away. This is the single place every user-visible
	 * action funnels through - added/deleted titles, watched/status/date
	 * changes, refreshes - so the log stays a complete, chronological record
	 * without each call site needing to know about storage or the cap.
	 */
	async logAction(message: string): Promise<void> {
		pushLogEntry(this.settings.activityLog, message);
		await this.saveData(this.settings);
	}

	/**
	 * Single choke point for refreshing library metadata from TMDB, used by both
	 * the manual "Refresh" buttons and the automatic scheduler. The isRefreshing
	 * guard means a manual click while an automatic refresh is already running
	 * (or vice versa) is simply skipped rather than run twice in parallel.
	 */
	async refreshLibrary(options: { auto: boolean; onProgress?: RepairProgressCallback }): Promise<RepairResult | null> {
		if (this.isRefreshing) return null;
		if (!this.settings.tmdbApiKey) return null;

		this.isRefreshing = true;
		try {
			const result = await repairLibrary(
				this.app,
				this.tmdb,
				{
					libraryFolder: this.settings.libraryFolder,
					onlyActiveTitles: this.settings.refreshOnlyActiveTitles,
					peopleFolder: this.settings.peopleFolder,
					createDirectorNotes: this.settings.createDirectorNotes,
					createCastNotes: this.settings.createCastNotes,
					storeImagesLocally: this.settings.storeImagesLocally,
					imagesFolder: this.settings.imagesFolder,
				},
				options.onProgress
			);

			if (options.auto) {
				this.settings.lastAutoRefresh = new Date().toISOString();
				await this.saveData(this.settings);
			}

			if (result.repaired > 0) {
				await this.logAction(
					`Library refreshed ${options.auto ? "automatically" : "manually"}: ${result.repaired} title(s) updated${result.failed > 0 ? `, ${result.failed} failed` : ""}.`
				);
			}

			return result;
		} finally {
			this.isRefreshing = false;
		}
	}

	private async maybeAutoRefresh(): Promise<void> {
		const frequency = this.settings.refreshFrequencyDays;
		if (frequency === null) return;

		const last = this.settings.lastAutoRefresh;
		const dueSinceMs = last ? Date.now() - new Date(last).getTime() : Infinity;
		if (dueSinceMs < frequency * MS_PER_DAY) return;

		const result = await this.refreshLibrary({ auto: true });
		if (result && result.repaired > 0) {
			new Notice(`Marathoner: refreshed metadata for ${result.repaired} title(s).`);
		}
	}

	/**
	 * Refreshes a single title note from TMDB right now, regardless of the
	 * automatic refresh schedule - the "Refresh" button on the Detail view.
	 * Deliberately independent of the `isRefreshing` bulk-refresh guard: a
	 * single note is fast, and there's no reason to block it behind an
	 * unrelated library-wide sweep (or vice versa).
	 */
	async refreshOneTitle(entry: LibraryEntry): Promise<void> {
		if (!this.settings.tmdbApiKey) {
			throw new Error("TMDB API key is not configured. Set it in Settings > Marathoner.");
		}
		await refreshOneTitleEntry(this.app, this.tmdb, entry, {
			peopleFolder: this.settings.peopleFolder,
			createDirectorNotes: this.settings.createDirectorNotes,
			createCastNotes: this.settings.createCastNotes,
			storeImagesLocally: this.settings.storeImagesLocally,
			imagesFolder: this.settings.imagesFolder,
		});
		await this.logAction(`"${entry.frontmatter.title}" refreshed manually.`);
	}

	/** Same idea as refreshOneTitle, but for a person note - the "Refresh" button on the Person detail view. */
	async refreshOnePersonNote(file: TFile, tmdbId: number): Promise<void> {
		if (!this.settings.tmdbApiKey) {
			throw new Error("TMDB API key is not configured. Set it in Settings > Marathoner.");
		}
		await refreshOnePerson(this.app, this.tmdb, file, tmdbId, this.settings.storeImagesLocally, this.settings.imagesFolder);
		await this.logAction(`Person note "${file.basename}" refreshed manually.`);
	}
}
