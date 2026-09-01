import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type MarathonerPlugin from "./main";
import { TmdbClient } from "./tmdb/client";
import { FolderSuggest } from "./ui/folder-suggest";
import { TMDB_LANGUAGES, DEFAULT_TMDB_LANGUAGE } from "./tmdb/languages";
import type { LogEntry } from "./activity-log";
import { MigrateModal } from "./modals/migrate-modal";

export interface MarathonerSettings {
	tmdbApiKey: string;
	tmdbLanguage: string;
	libraryFolder: string;
	visibleShelves: {
		favorites: boolean;
		recentlyAdded: boolean;
		recentlyWatched: boolean;
		recentlyReleased: boolean;
		statusWatching: boolean;
		statusPlanned: boolean;
		statusPaused: boolean;
		statusCompleted: boolean;
		statusDropped: boolean;
	};
	refreshFrequencyDays: number | null; // null = manual only
	refreshOnlyActiveTitles: boolean; // true = skip completed/dropped titles
	lastAutoRefresh: string | null; // ISO datetime, internal bookkeeping
	peopleFolder: string;
	createDirectorNotes: boolean;
	createCastNotes: boolean;
	storeImagesLocally: boolean;
	imagesFolder: string;
	activityLog: LogEntry[]; // most-recent-first, capped - see activity-log.ts
}

export const DEFAULT_SETTINGS: MarathonerSettings = {
	tmdbApiKey: "",
	tmdbLanguage: DEFAULT_TMDB_LANGUAGE,
	libraryFolder: "Marathoner",
	visibleShelves: {
		favorites: true,
		recentlyAdded: true,
		recentlyWatched: true,
		recentlyReleased: true,
		statusWatching: true,
		statusPlanned: true,
		statusPaused: true,
		statusCompleted: true,
		statusDropped: true,
	},
	refreshFrequencyDays: 7,
	refreshOnlyActiveTitles: true,
	lastAutoRefresh: null,
	peopleFolder: "Marathoner/People",
	createDirectorNotes: false,
	createCastNotes: false,
	storeImagesLocally: false,
	imagesFolder: "Marathoner/Assets",
	activityLog: [],
};

export class MarathonerSettingTab extends PluginSettingTab {
	plugin: MarathonerPlugin;

	constructor(app: App, plugin: MarathonerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("TMDB API key")
			.setDesc("Read Access Token (v4) from your TMDB account. Create one at themoviedb.org under Settings > API.")
			.addText((text) =>
				text
					.setPlaceholder("eyJhbGciOiJIUzI1NiJ9...")
					.setValue(this.plugin.settings.tmdbApiKey)
					.onChange(async (value) => {
						this.plugin.settings.tmdbApiKey = value.trim();
						await this.plugin.saveSettings();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					const client = new TmdbClient(this.plugin.settings.tmdbApiKey, this.plugin.settings.tmdbLanguage);
					const ok = await client.testConnection();
					new Notice(ok ? "TMDB connection successful" : "Connection failed. Check your API key.");
				})
			);

		new Setting(containerEl)
			.setName("Metadata language")
			.setDesc("Language used for titles, overviews, and other metadata fetched from TMDB.")
			.addDropdown((dropdown) => {
				for (const { code, label } of TMDB_LANGUAGES) {
					dropdown.addOption(code, label);
				}
				dropdown.setValue(this.plugin.settings.tmdbLanguage).onChange(async (value) => {
					this.plugin.settings.tmdbLanguage = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Library folder")
			.setDesc(
				"Where your library lives in the vault. Movies and TV shows are kept in Movies/ and TV Shows/ subfolders underneath it, created automatically."
			)
			.addText((text) => {
				text
					.setPlaceholder("Marathoner")
					.setValue(this.plugin.settings.libraryFolder)
					.onChange(async (value) => {
						this.plugin.settings.libraryFolder = value.trim() || DEFAULT_SETTINGS.libraryFolder;
						await this.plugin.saveSettings();
					});

				new FolderSuggest(this.app, text.inputEl, async (path) => {
					this.plugin.settings.libraryFolder = path;
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("p", {
			text: "This product uses the TMDB API but is not endorsed or certified by TMDB.",
			cls: "setting-item-description",
		});

		containerEl.createEl("h3", { text: "Automatic refresh" });

		new Setting(containerEl)
			.setName("Refresh frequency")
			.setDesc(
				"How often Marathoner re-fetches metadata from TMDB in the background (rating, cast, next episode, etc.)."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ manual: "Manual only", "1": "Daily", "7": "Weekly" })
					.setValue(this.plugin.settings.refreshFrequencyDays === null ? "manual" : String(this.plugin.settings.refreshFrequencyDays))
					.onChange(async (value) => {
						this.plugin.settings.refreshFrequencyDays = value === "manual" ? null : Number(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Only refresh titles you're following")
			.setDesc(
				"Skip Dropped titles and completed movies, since their metadata rarely changes. Completed TV shows are still refreshed - they can be renewed with a new season at any time. Applies to both automatic and manual refresh."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.refreshOnlyActiveTitles).onChange(async (value) => {
					this.plugin.settings.refreshOnlyActiveTitles = value;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "People notes" });
		containerEl.createEl("p", {
			text: "Create a dedicated note for directors and/or cast members, with a biography, photo, and a dynamic list of what they appear in across your library.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Create director/creator notes")
			.setDesc("Applies to movie directors and TV show creators.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.createDirectorNotes).onChange(async (value) => {
					this.plugin.settings.createDirectorNotes = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Create cast notes")
			.setDesc("Applies to the top-billed cast cached for each title (up to 10 per title).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.createCastNotes).onChange(async (value) => {
					this.plugin.settings.createCastNotes = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("People folder")
			.setDesc("Where person notes are created in the vault.")
			.addText((text) => {
				text
					.setPlaceholder("Marathoner/People")
					.setValue(this.plugin.settings.peopleFolder)
					.onChange(async (value) => {
						this.plugin.settings.peopleFolder = value.trim() || DEFAULT_SETTINGS.peopleFolder;
						await this.plugin.saveSettings();
					});

				new FolderSuggest(this.app, text.inputEl, async (path) => {
					this.plugin.settings.peopleFolder = path;
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("h3", { text: "Offline images" });
		containerEl.createEl("p", {
			text: "By default, posters and photos are always loaded from TMDB's servers and need an internet connection to display. Storing them locally makes Marathoner fully usable offline, at the cost of vault size.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Store images locally")
			.setDesc("Download posters and photos into the vault instead of loading them from TMDB every time. Existing images are filled in automatically in the background when enabled.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.storeImagesLocally).onChange(async (value) => {
					const wasEnabled = this.plugin.settings.storeImagesLocally;
					this.plugin.settings.storeImagesLocally = value;
					await this.plugin.saveSettings();
					if (value && !wasEnabled) void this.plugin.cacheMissingImages();
				})
			);

		new Setting(containerEl)
			.setName("Images folder")
			.setDesc("Where downloaded posters and photos are stored in the vault.")
			.addText((text) => {
				text
					.setPlaceholder("Marathoner/Assets")
					.setValue(this.plugin.settings.imagesFolder)
					.onChange(async (value) => {
						this.plugin.settings.imagesFolder = value.trim() || DEFAULT_SETTINGS.imagesFolder;
						await this.plugin.saveSettings();
					});

				new FolderSuggest(this.app, text.inputEl, async (path) => {
					this.plugin.settings.imagesFolder = path;
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("h3", { text: "Maintenance" });

		new Setting(containerEl)
			.setName("Refresh library now")
			.setDesc(
				"Re-fetches metadata for every eligible note in the library from TMDB right now, ignoring the schedule above."
			)
			.addButton((btn) =>
				btn.setButtonText("Refresh").onClick(async () => {
					btn.setDisabled(true);
					const notice = new Notice("Refreshing library... 0%", 0);

					const result = await this.plugin.refreshLibrary({
						auto: false,
						onProgress: (done, total) => {
							notice.setMessage(`Refreshing library... ${done}/${total}`);
						},
					});

					notice.hide();
					if (result === null) {
						new Notice("A refresh is already in progress, or no TMDB API key is set.");
					} else {
						new Notice(
							`Refresh complete: ${result.repaired} updated, ${result.moved} moved, ${result.failed} failed, ${result.scanned} scanned.`
						);
					}
					btn.setDisabled(false);
				})
			);

		new Setting(containerEl)
			.setName("Import from another app")
			.setDesc("Bring in watched titles, ratings, and status from Trakt, Letterboxd, Simkl, IMDb, or Ryot.")
			.addButton((btn) =>
				btn.setButtonText("Import").onClick(() => {
					new MigrateModal(this.app, this.plugin).open();
				})
			);
	}
}
