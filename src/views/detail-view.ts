import {
	ItemView,
	WorkspaceLeaf,
	TFile,
	ButtonComponent,
	DropdownComponent,
	Notice,
	debounce,
	setIcon,
} from "obsidian";
import type MarathonerPlugin from "../main";
import { resolveImageSrc } from "../image-cache";
import { parseTitleFrontmatter, readNotesBody, writeNotesBody, readEpisodesCache } from "../notes";
import { pruneOrphanedPersonNotes } from "../people";
import { computeTitleStats } from "../title-stats";
import { formatMinutes, formatSyncedAt } from "../stats";
import { ConfirmModal } from "../ui/confirm-modal";
import { openPersonDetail } from "./open-person-detail";
import { activateWatchlistView } from "./activate-watchlist-view";
import {
	TitleFrontmatter,
	WatchStatus,
	WatchedMap,
	CachedSeason,
	toggleEpisode,
	markSeasonWatched,
	unmarkSeasonWatched,
	applyTvCompletionRule,
	isEpisodeAired,
	airedEpisodeCount,
} from "../models/title";

export const VIEW_TYPE_DETAIL = "marathoner-detail";

const STATUS_OPTIONS: { value: WatchStatus; label: string }[] = [
	{ value: "planned", label: "Planned" },
	{ value: "watching", label: "Watching" },
	{ value: "paused", label: "Paused" },
	{ value: "completed", label: "Completed" },
	{ value: "dropped", label: "Dropped" },
];

const SEASON_ACCENTS = ["mrt-green", "mrt-peach", "mrt-blue", "mrt-mauve", "mrt-teal", "mrt-red"];

export class DetailView extends ItemView {
	private filePath: string | null = null;
	private expandedSeasons: Set<number> = new Set();
	// Source of truth for season/episode structure - read from the note's local
	// cache, never fetched lazily from TMDB per-season anymore. This is what
	// makes browsing and marking episodes work fully offline.
	private cachedSeasons: CachedSeason[] = [];
	// Authoritative local copy of the watched map, updated synchronously on every
	// write. Never re-read from metadataCache right after our own writes - the
	// cache re-indexes asynchronously and can briefly lag behind, which caused
	// the season buttons to show stale counts and need multiple clicks to "catch up".
	private currentWatched: WatchedMap = {};
	// Authoritative local copy of the frontmatter, mirrored on every write via
	// updateFrontmatter(). Lets us re-render the header (status, stats, dates)
	// immediately after marking episodes/seasons, without waiting for
	// metadataCache to re-index - which lags and was causing the header to
	// look stuck on the old status until the note was closed and reopened.
	private currentFm: TitleFrontmatter | null = null;
	private headerContainerEl: HTMLElement | null = null;
	private seasonsHostEl: HTMLElement | null = null;
	private saveNotesDebounced = debounce(
		(text: string) => {
			const file = this.getFile();
			if (file) void writeNotesBody(this.app, file, text);
		},
		600,
		true
	);

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: MarathonerPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_DETAIL;
	}

	getDisplayText(): string {
		return "Title details";
	}

	getIcon(): string {
		return "clapperboard";
	}

	async onOpen(): Promise<void> {
		if (!this.filePath) {
			this.contentEl.empty();
			this.contentEl.createEl("p", { text: "No title selected." });
		}
	}

	/** Called directly by whoever opens this view, instead of relying on setState/getState. */
	async setFile(file: TFile): Promise<void> {
		this.filePath = file.path;
		this.expandedSeasons.clear();
		this.cachedSeasons = [];
		await this.loadDetail();
	}

	async onClose(): Promise<void> {}

	private getFile(): TFile | null {
		if (!this.filePath) return null;
		const file = this.app.vault.getAbstractFileByPath(this.filePath);
		return file instanceof TFile ? file : null;
	}

	private getFrontmatter(): TitleFrontmatter | null {
		const file = this.getFile();
		if (!file) return null;
		const raw = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return parseTitleFrontmatter(raw);
	}

	private totalEpisodes(): number {
		return this.cachedSeasons.reduce((sum, s) => sum + s.episodes.length, 0);
	}

	private async loadDetail(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("marathoner-detail");

		const fm = this.getFrontmatter();
		if (!fm) {
			container.createEl("p", { text: "Could not load this title. The note may be malformed." });
			return;
		}
		this.currentFm = fm;

		const file = this.getFile();
		if (!file) return;

		// Everything here comes from the local cache - frontmatter (including
		// the synopsis, cast, and next-episode info) and, for TV, the episode
		// cache written at add time or by a refresh. Opening a note never
		// contacts TMDB by itself anymore; that only happens on the scheduled
		// automatic refresh (Settings) or when you hit "Refresh" below.
		this.headerContainerEl = container.createDiv();
		this.renderHeader(fm);

		if (fm.type !== "tv") return;

		this.currentWatched = { ...(fm.watched ?? {}) };
		this.cachedSeasons = await readEpisodesCache(this.app, file);

		const dynamicContainer = container.createDiv({ cls: "marathoner-detail-dynamic" });
		this.seasonsHostEl = dynamicContainer.createDiv();
		this.renderSeasonsFromCache();

		if (this.cachedSeasons.length === 0) {
			this.seasonsHostEl.createEl("p", {
				text: "No cached episode data yet for this show. Hit Refresh above to fetch it from TMDB - after that, it's fully available offline.",
				cls: "marathoner-empty-state",
			});
		}
	}

	private renderHeader(fm: TitleFrontmatter): void {
		const container = this.headerContainerEl!;
		container.empty();

		const header = container.createDiv({ cls: "marathoner-detail-header" });

		const posterUrl = resolveImageSrc(
			this.app,
			this.plugin.settings.storeImagesLocally,
			this.plugin.settings.imagesFolder,
			"title",
			fm.tmdb_id,
			fm.poster_path,
			"w342"
		);
		if (posterUrl) {
			header.createEl("img", { attr: { src: posterUrl }, cls: "marathoner-detail-poster" });
		}

		const info = header.createDiv({ cls: "marathoner-detail-info" });

		const titleRow = info.createDiv({ cls: "marathoner-detail-title-row" });
		titleRow.createEl("h2", { text: fm.year ? `${fm.title} (${fm.year})` : fm.title });

		const favoriteBtn = new ButtonComponent(titleRow)
			.setIcon("heart")
			.setTooltip(fm.favorite ? "Remove from favorites" : "Add to favorites")
			.onClick(async () => {
				const next = !fm.favorite;
				await this.updateFrontmatter((f) => {
					f.favorite = next;
				});
				favoriteBtn.buttonEl.toggleClass("marathoner-favorite-active", next);
			});
		favoriteBtn.buttonEl.addClass("marathoner-favorite-btn");
		favoriteBtn.buttonEl.toggleClass("marathoner-favorite-active", fm.favorite);

		if (fm.trailer_url) {
			new ButtonComponent(titleRow)
				.setIcon("circle-play")
				.setTooltip("Watch trailer")
				.onClick(() => window.open(fm.trailer_url!, "_blank"));
		}
		if (fm.imdb_url) {
			new ButtonComponent(titleRow)
				.setIcon("external-link")
				.setTooltip("Open on IMDb")
				.onClick(() => window.open(fm.imdb_url!, "_blank"));
		}

		this.renderSyncRow(info, fm);

		if (fm.studio.length > 0) {
			this.renderChipRow(info, fm.studio, "marathoner-studio-chip");
		}

		info.createEl("p", {
			text: fm.overview || "No synopsis cached yet - hit Refresh above to fetch it from TMDB.",
			cls: "marathoner-detail-overview",
		});

		if (fm.type === "tv" && fm.next_episode_label && fm.next_episode_air_date) {
			info.createEl("p", {
				cls: "marathoner-next-episode",
				text: `Next: ${fm.next_episode_label} - ${fm.next_episode_air_date}`,
			});
		}

		this.renderStatsRow(info, fm);

		const controls = info.createDiv({ cls: "marathoner-detail-controls" });

		const availableStatuses =
			fm.type === "tv"
				? STATUS_OPTIONS.filter((o) => o.value !== "completed" || fm.status === "completed")
				: STATUS_OPTIONS;

		const statusDropdown = new DropdownComponent(controls)
			.addOptions(Object.fromEntries(availableStatuses.map((o) => [o.value, o.label])))
			.setValue(fm.status)
			.onChange(async (value) => {
				await this.updateFrontmatter((f) => {
					f.status = value;
					f.date_completed = value === "completed" ? new Date().toISOString().slice(0, 10) : null;
				}, value === "completed");

				const label = availableStatuses.find((o) => o.value === value)?.label ?? value;
				await this.plugin.logAction(`"${fm.title}": status changed to ${label}.`);

				// The "Completed" date in the dates row, and (for TV) the disabled
				// state and "Completed automatically" hint right below this dropdown,
				// all depend on fm.status/date_completed - refresh now instead of
				// leaving them stale until the note is closed and reopened.
				if (this.currentFm) this.renderHeader(this.currentFm);
			});

		if (fm.type === "tv") {
			statusDropdown.setDisabled(fm.status === "completed");
			controls.createSpan({
				cls: "marathoner-status-hint",
				text: fm.status === "completed" ? "Completed automatically - watch a new episode to change this." : "",
			});
		}

		const ratingWrapper = controls.createDiv({ cls: "marathoner-rating-wrapper" });
		ratingWrapper.createSpan({ text: "Your rating", cls: "marathoner-rating-label" });
		this.renderStarRating(ratingWrapper, fm.rating);

		if (fm.community_rating !== null) {
			controls.createSpan({
				cls: "marathoner-community-rating",
				text: `TMDB ${fm.community_rating.toFixed(1)}${fm.community_votes ? ` (${formatVotes(fm.community_votes)})` : ""}`,
			});
		}

		new ButtonComponent(controls).setButtonText("Open note").onClick(() => {
			const file = this.getFile();
			if (file) this.app.workspace.getLeaf(false).openFile(file);
		});

		if (fm.director.length > 0) {
			this.renderPersonRow(info, "Director", fm.director, fm.director_ids);
		}
		if (fm.cast.length > 0) {
			this.renderPersonRow(info, "Cast", fm.cast, fm.cast_ids);
		}

		this.renderDatesRow(info, fm);
		this.renderNotesSection(container);
	}

	private renderChipRow(container: HTMLElement, values: string[], chipClass: string): void {
		const row = container.createDiv({ cls: "marathoner-chip-row" });
		for (const value of values) {
			row.createSpan({ text: value, cls: chipClass });
		}
	}

	/**
	 * "Last updated" timestamp + manual refresh button for this single note.
	 * Automatic refresh (Settings > Marathoner) still runs on its own schedule
	 * regardless of this - this is purely an on-demand top-up for when you
	 * want this one title current right now, without waiting for it.
	 */
	private renderSyncRow(container: HTMLElement, fm: TitleFrontmatter): void {
		const row = container.createDiv({ cls: "marathoner-sync-row" });
		const label = row.createSpan({ cls: "marathoner-sync-label", text: formatSyncedAt(fm.tmdb_synced_at) });

		const refreshBtn = new ButtonComponent(row)
			.setIcon("refresh-cw")
			.setTooltip("Refresh this title from TMDB")
			.onClick(async () => {
				const file = this.getFile();
				const latestFm = this.getFrontmatter();
				if (!file || !latestFm) return;

				refreshBtn.setDisabled(true);
				refreshBtn.buttonEl.addClass("marathoner-spin");
				label.setText("Refreshing...");

				try {
					await this.plugin.refreshOneTitle({ file, frontmatter: latestFm });
					new Notice(`Refreshed "${latestFm.title}" from TMDB.`);
					await this.loadDetail();
				} catch (err) {
					new Notice(`Refresh failed: ${(err as Error).message}`);
					refreshBtn.setDisabled(false);
					refreshBtn.buttonEl.removeClass("marathoner-spin");
					label.setText(formatSyncedAt(fm.tmdb_synced_at));
				}
			});
		refreshBtn.buttonEl.addClass("marathoner-sync-btn");
	}

	private renderPersonRow(container: HTMLElement, label: string, names: string[], ids: number[]): void {
		const row = container.createDiv({ cls: "marathoner-person-row" });
		row.createSpan({ text: `${label}: `, cls: "marathoner-person-label" });

		names.forEach((name, i) => {
			const nameEl = row.createSpan({ text: name, cls: "marathoner-person-link" });
			const personId = ids[i];
			if (personId !== undefined) {
				nameEl.addEventListener("click", () => {
					void openPersonDetail(this.app, this.plugin.tmdb, this.plugin.settings, personId, name);
				});
			}
			if (i < names.length - 1) row.createSpan({ text: ", " });
		});
	}

	private renderStatsRow(container: HTMLElement, fm: TitleFrontmatter): void {
		const stats = computeTitleStats(fm);
		const row = container.createDiv({ cls: "marathoner-stats-row" });

		if (fm.type === "tv") {
			this.renderStatChip(row, "Left", formatMinutes(stats.remainingMinutes));
			this.renderStatChip(row, "Watched", formatMinutes(stats.watchedMinutes));
			if (stats.episodesTotal !== null) {
				this.renderStatChip(row, "Episodes", `${stats.episodesWatched}/${stats.episodesTotal}`);
			}
			if (stats.progressPercent !== null) {
				this.renderStatChip(row, "Progress", `${stats.progressPercent}%`);
			}
		} else {
			this.renderStatChip(row, "Runtime", fm.runtime ? formatMinutes(fm.runtime) : "-");
			this.renderStatChip(row, "Watched", stats.progressPercent === 100 ? "Yes" : "No");
		}
	}

	private renderStarRating(container: HTMLElement, initialRating: number | null): void {
		let currentRating = initialRating;
		const starsRow = container.createDiv({ cls: "marathoner-star-rating" });
		const valueLabel = container.createSpan({
			cls: "marathoner-rating-value",
			text: currentRating !== null ? String(currentRating) : "-",
		});

		const stars: HTMLElement[] = [];
		const paint = (value: number) => {
			stars.forEach((star, i) => star.toggleClass("marathoner-star-filled", i < value));
		};

		for (let i = 1; i <= 10; i++) {
			const star = starsRow.createDiv({ cls: "marathoner-star", attr: { "aria-label": String(i) } });
			setIcon(star, "star");
			stars.push(star);

			star.addEventListener("mouseenter", () => paint(i));
			star.addEventListener("click", async () => {
				const next = currentRating === i ? null : i;
				currentRating = next;
				valueLabel.setText(next !== null ? String(next) : "-");
				paint(next ?? 0);
				await this.updateFrontmatter((f) => {
					f.rating = next;
				});
			});
		}

		starsRow.addEventListener("mouseleave", () => paint(currentRating ?? 0));
		paint(currentRating ?? 0);
	}

	private renderStatChip(container: HTMLElement, label: string, value: string): void {
		const chip = container.createDiv({ cls: "marathoner-stat-chip" });
		chip.createDiv({ cls: "marathoner-stat-chip-value", text: value });
		chip.createDiv({ cls: "marathoner-stat-chip-label", text: label });
	}

	private renderDatesRow(container: HTMLElement, fm: TitleFrontmatter): void {
		const row = container.createDiv({ cls: "marathoner-dates-row" });

		this.renderDateField(row, "Started", fm.date_started, async (value) => {
			await this.updateFrontmatter((f) => {
				f.date_started = value;
			});
			await this.plugin.logAction(`"${fm.title}": Started date set to ${value ?? "(cleared)"}.`);
		});

		this.renderDateField(row, "Completed", fm.date_completed, async (value) => {
			await this.updateFrontmatter((f) => {
				f.date_completed = value;
			});
			await this.plugin.logAction(`"${fm.title}": Completed date set to ${value ?? "(cleared)"}.`);
		});

		const releaseDate = fm.type === "movie" ? fm.release_date : fm.last_episode_air_date;
		if (releaseDate) {
			const field = row.createDiv({ cls: "marathoner-date-field" });
			field.createSpan({ text: fm.type === "movie" ? "Released" : "Last aired", cls: "marathoner-date-label" });
			field.createSpan({ text: releaseDate, cls: "marathoner-date-value-readonly" });
		}
	}

	private renderDateField(
		container: HTMLElement,
		label: string,
		value: string | null,
		onChange: (value: string | null) => void
	): void {
		const field = container.createDiv({ cls: "marathoner-date-field" });
		field.createSpan({ text: label, cls: "marathoner-date-label" });

		const input = field.createEl("input", { type: "date", cls: "marathoner-date-input" }) as HTMLInputElement;
		input.value = value ?? "";
		input.addEventListener("change", () => onChange(input.value || null));

		new ButtonComponent(field).setButtonText("Today").onClick(() => {
			const today = new Date().toISOString().slice(0, 10);
			input.value = today;
			onChange(today);
		});
	}

	private renderNotesSection(container: HTMLElement): void {
		const section = container.createDiv({ cls: "marathoner-notes-section" });
		section.createEl("h3", { text: "Notes", cls: "marathoner-section-heading" });

		const textarea = section.createEl("textarea", {
			cls: "marathoner-notes-textarea",
			attr: { placeholder: "Your thoughts, quotes, anything..." },
		}) as HTMLTextAreaElement;
		textarea.disabled = true;
		textarea.value = "Loading...";

		const file = this.getFile();
		if (!file) return;

		readNotesBody(this.app, file).then((text) => {
			textarea.value = text;
			textarea.disabled = false;
		});

		textarea.addEventListener("input", () => {
			this.saveNotesDebounced(textarea.value);
		});

		const deleteRow = container.createDiv({ cls: "marathoner-delete-row" });
		new ButtonComponent(deleteRow)
			.setButtonText("Delete title")
			.setWarning()
			.onClick(() => {
				const fm = this.getFrontmatter();
				new ConfirmModal(
					this.app,
					"Delete title?",
					`This moves "${fm?.title ?? "this title"}" and everything you've tracked for it (episodes watched, notes, rating) to the trash.`,
					"Delete",
					async () => {
						const f = this.getFile();
						if (!f) return;
						await this.app.fileManager.trashFile(f);

						const removedPeople = await pruneOrphanedPersonNotes(
							this.app,
							this.plugin.settings.libraryFolder,
							this.plugin.settings.peopleFolder
						);

						await this.plugin.logAction(
							`"${fm?.title ?? "title"}" deleted${removedPeople > 0 ? ` (${removedPeople} orphaned person note(s) also removed)` : ""}.`
						);

						new Notice(
							removedPeople > 0
								? `Deleted "${fm?.title ?? "title"}" and ${removedPeople} person note(s) no longer linked to anything in your library.`
								: `Deleted "${fm?.title ?? "title"}".`
						);
						await activateWatchlistView(this.app);
						this.leaf.detach();
					}
				).open();
			});
	}

	private renderSeasonsFromCache(): void {
		const host = this.seasonsHostEl;
		if (!host) return;
		host.empty();

		if (this.cachedSeasons.length === 0) return;

		const seasonsContainer = host.createDiv({ cls: "marathoner-seasons" });
		this.cachedSeasons.forEach((season, i) => {
			this.renderSeasonHeader(seasonsContainer, season, SEASON_ACCENTS[i % SEASON_ACCENTS.length]);
		});
	}

	private renderSeasonHeader(container: HTMLElement, season: CachedSeason, accentVar: string): void {
		const { seasonNumber, name: seasonName, episodes } = season;
		const episodeCount = episodes.length;

		const seasonEl = container.createDiv({ cls: "marathoner-season" });
		seasonEl.style.setProperty("--marathoner-season-accent", `var(--${accentVar})`);
		const headerEl = seasonEl.createDiv({ cls: "marathoner-season-header" });

		const watchedCount = this.currentWatched[seasonNumber]?.length ?? 0;
		const hasEpisodes = episodeCount > 0;
		// The ceiling for "mark season watched" is how many episodes have
		// actually aired, not the season's full eventual episode count -
		// otherwise a season with future episodes could be marked 100% watched.
		const airedCount = airedEpisodeCount(episodes);
		const canMarkSeason = airedCount > 0;
		const toggle = headerEl.createSpan({
			cls: "marathoner-season-toggle",
			text: this.expandedSeasons.has(seasonNumber) ? "\u25be" : "\u25b8",
		});
		const countLabel = headerEl.createSpan({
			text: hasEpisodes ? `${seasonName} (${watchedCount}/${episodeCount})` : `${seasonName} (not yet announced)`,
		});

		const updateCountLabel = (): void => {
			const count = this.currentWatched[seasonNumber]?.length ?? 0;
			countLabel.setText(hasEpisodes ? `${seasonName} (${count}/${episodeCount})` : `${seasonName} (not yet announced)`);
			markBtn.setButtonText(canMarkSeason && count === airedCount ? "Unmark season" : "Mark season watched");
			markBtn.setDisabled(!canMarkSeason);
		};

		const markBtn = new ButtonComponent(headerEl)
			.setButtonText(canMarkSeason && watchedCount === airedCount ? "Unmark season" : "Mark season watched")
			.setDisabled(!canMarkSeason)
			.onClick(async (evt) => {
				evt.stopPropagation();
				if (!canMarkSeason) return;
				const currentCount = this.currentWatched[seasonNumber]?.length ?? 0;
				const isMarking = currentCount !== airedCount;
				const nextWatched = isMarking
					? markSeasonWatched(this.currentWatched, seasonNumber, episodes)
					: unmarkSeasonWatched(this.currentWatched, seasonNumber);

				await this.updateFrontmatter((f) => {
					f.watched = nextWatched;
					applyTvCompletionRule(f, nextWatched, this.totalEpisodes());
				}, isMarking);

				const title = this.currentFm?.title ?? "title";
				await this.plugin.logAction(`"${title}": Season ${seasonNumber} marked ${isMarking ? "watched" : "unwatched"}.`);

				this.currentWatched = nextWatched;
				updateCountLabel();
				if (this.expandedSeasons.has(seasonNumber)) {
					this.renderEpisodes(episodesEl, season, updateCountLabel);
				}
				// Status, "Completed automatically" hint, and the stats row (progress,
				// episodes left/watched) all live in the header - refresh it now so
				// they never wait for the note to be closed and reopened.
				if (this.currentFm) this.renderHeader(this.currentFm);
			});
		markBtn.buttonEl.addClass("marathoner-season-mark-btn");

		const episodesEl = seasonEl.createDiv({ cls: "marathoner-episodes" });
		episodesEl.toggle(this.expandedSeasons.has(seasonNumber));
		if (this.expandedSeasons.has(seasonNumber)) {
			this.renderEpisodes(episodesEl, season, updateCountLabel);
		}

		headerEl.addEventListener("click", () => {
			if (this.expandedSeasons.has(seasonNumber)) {
				this.expandedSeasons.delete(seasonNumber);
				toggle.setText("\u25b8");
				episodesEl.toggle(false);
				return;
			}

			this.expandedSeasons.add(seasonNumber);
			toggle.setText("\u25be");
			episodesEl.toggle(true);

			if (!hasEpisodes) {
				episodesEl.empty();
				episodesEl.createEl("p", {
					text: "No episodes announced yet for this season.",
					cls: "marathoner-detail-loading",
				});
				return;
			}

			this.renderEpisodes(episodesEl, season, updateCountLabel);
		});
	}

	/** Fully synchronous now - episode data is already local, no TMDB call needed to expand a season. */
	private renderEpisodes(container: HTMLElement, season: CachedSeason, onWatchedChange: () => void): void {
		container.empty();
		const seasonNumber = season.seasonNumber;

		for (const episode of season.episodes) {
			const row = container.createDiv({ cls: "marathoner-episode-row" });
			const aired = isEpisodeAired(episode);
			let watched = this.currentWatched[seasonNumber]?.includes(episode.number) ?? false;

			const toggle = row.createDiv({ cls: "marathoner-episode-toggle" });
			const paintToggle = () => {
				setIcon(toggle, watched ? "circle-check-big" : "circle");
				toggle.toggleClass("marathoner-episode-toggle-active", watched);
			};
			paintToggle();

			row.createSpan({
				text: `E${pad(episode.number)} - ${episode.name}`,
				cls: "marathoner-episode-title",
			});
			if (episode.airDate) {
				row.createSpan({ text: episode.airDate, cls: "marathoner-episode-date" });
			}

			// Unaired episodes can't be marked watched - stop here, no click
			// handlers attached, so a click on a future episode does nothing.
			if (!aired) {
				row.addClass("marathoner-episode-future");
				row.createSpan({ text: "Not aired yet", cls: "marathoner-episode-future-badge" });
				continue;
			}

			const handleToggle = async () => {
				watched = !watched;
				paintToggle();

				const nextWatched = toggleEpisode(this.currentWatched, seasonNumber, episode.number);
				await this.updateFrontmatter((f) => {
					f.watched = nextWatched;
					applyTvCompletionRule(f, nextWatched, this.totalEpisodes());
				}, watched);

				const title = this.currentFm?.title ?? "title";
				await this.plugin.logAction(
					`"${title}": S${pad(seasonNumber)}E${pad(episode.number)} marked ${watched ? "watched" : "unwatched"}.`
				);

				this.currentWatched = nextWatched;
				onWatchedChange();
				// Same reasoning as the season button: refresh the header immediately
				// so status/"Completed automatically"/stats never look stuck.
				if (this.currentFm) this.renderHeader(this.currentFm);
			};

			// A single listener on the row (which contains the toggle icon and the
			// title text) - not one on the toggle AND one on the row. Two separate
			// listeners meant clicking the icon itself fired both (the icon's SVG
			// is a *child* of `toggle`, so it's never === toggle, so the row's old
			// "if evt.target !== toggle" guard never actually excluded it) - toggling
			// watched on, then immediately back off, in the same click. That's the
			// flash/"pisca" where it looked like nothing happened until reopening
			// the note.
			row.addEventListener("click", () => void handleToggle());
		}
	}

	private async updateFrontmatter(
		mutate: (fm: Record<string, unknown>) => void,
		isWatchActivity = false
	): Promise<void> {
		const file = this.getFile();
		if (!file) return;

		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				mutate(fm);
				fm.date_modified = new Date().toISOString();
				if (isWatchActivity) fm.date_last_watched = new Date().toISOString();
			});

			// Apply the exact same mutation to our local mirror so callers can
			// re-render immediately from `this.currentFm` instead of re-reading
			// metadataCache (which hasn't caught up yet at this point).
			if (this.currentFm) {
				const mirror = this.currentFm as unknown as Record<string, unknown>;
				mutate(mirror);
				mirror.date_modified = new Date().toISOString();
				if (isWatchActivity) mirror.date_last_watched = new Date().toISOString();
			}
		} catch (err) {
			new Notice(`Failed to update note: ${(err as Error).message}`);
		}
	}
}

function formatVotes(votes: number): string {
	return votes >= 1000 ? `${(votes / 1000).toFixed(1)}K` : String(votes);
}

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}
