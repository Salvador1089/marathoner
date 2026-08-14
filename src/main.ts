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
import { refreshOnePerson } from "./people";
import type { LibraryEntry } from "./notes";
import { pushLogEntry } from "./activity-log";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export default class MarathonerPlugin extends Plugin {
	settings!: MarathonerSettings;
	tmdb!: TmdbClient;
	isRefreshing = false;

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
		this.app.workspace.onLayoutReady(() => this.maybeAutoRefresh());
	}

	onunload() {}

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
