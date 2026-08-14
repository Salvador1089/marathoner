import { ItemView, WorkspaceLeaf, ButtonComponent, Notice } from "obsidian";
import type MarathonerPlugin from "../main";
import { getLibraryEntries, LibraryEntry } from "../notes";
import { computeLibraryStats, formatMinutes, NameCount } from "../stats";
import { resolveImageSrc } from "../image-cache";
import { AddTitleModal } from "../modals/add-title-modal";
import { openTitleDetail } from "./open-title-detail";
import { openPersonDetail } from "./open-person-detail";
import { activateWatchlistView } from "./activate-watchlist-view";
import { activateUpcomingView } from "./activate-upcoming-view";
import { renderTypeBadge } from "../ui/type-badge";
import { activateLogView } from "./activate-log-view";

export const VIEW_TYPE_DASHBOARD = "marathoner-dashboard";

export class DashboardView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private plugin: MarathonerPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_DASHBOARD;
	}

	getDisplayText(): string {
		return "Dashboard";
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	async onOpen(): Promise<void> {
		this.render();
		this.registerEvent(this.app.vault.on("create", () => this.render()));
		this.registerEvent(this.app.vault.on("delete", () => this.render()));
		this.registerEvent(this.app.vault.on("rename", () => this.render()));
		this.registerEvent(this.app.metadataCache.on("changed", () => this.render()));
	}

	async onClose(): Promise<void> {}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("marathoner-dashboard");

		this.renderToolbar(container);

		const entries = getLibraryEntries(this.app, this.plugin.settings.libraryFolder);

		if (entries.length === 0) {
			container.createEl("p", {
				text: 'No titles yet. Click "Add title" above to get started.',
				cls: "marathoner-empty-state",
			});
			return;
		}

		const stats = computeLibraryStats(entries);

		this.renderSummaryCards(container, stats);
		this.renderByTypeCards(container, stats);
		this.renderRecentSection(container, "Recently added", stats.recentlyAdded);
		this.renderRecentSection(container, "Recently updated", stats.recentlyUpdated);
		this.renderNerdStats(container, stats);
	}

	private renderToolbar(container: HTMLElement): void {
		const toolbar = container.createDiv({ cls: "marathoner-toolbar" });
		toolbar.createDiv({ cls: "marathoner-toolbar-spacer" });

		new ButtonComponent(toolbar).setButtonText("Watchlist").onClick(() => {
			activateWatchlistView(this.app);
		});

		new ButtonComponent(toolbar).setButtonText("Upcoming").onClick(() => {
			activateUpcomingView(this.app);
		});

		new ButtonComponent(toolbar)
			.setIcon("scroll-text")
			.setTooltip("Activity log")
			.onClick(() => {
				activateLogView(this.app);
			});

		const refreshBtn = new ButtonComponent(toolbar)
			.setIcon("refresh-cw")
			.setTooltip("Refresh library metadata from TMDB")
			.onClick(async () => {
				refreshBtn.setDisabled(true);
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
					new Notice(`Refresh complete: ${result.repaired} updated, ${result.moved} moved, ${result.failed} failed.`);
				}
				refreshBtn.setDisabled(false);
			});

		new ButtonComponent(toolbar)
			.setButtonText("Add title")
			.setCta()
			.onClick(() => {
				new AddTitleModal(this.app, this.plugin).open();
			});
	}

	private renderSummaryCards(container: HTMLElement, stats: ReturnType<typeof computeLibraryStats>): void {
		const grid = container.createDiv({ cls: "marathoner-summary-grid" });

		this.renderStatCard(
			grid,
			"Total titles",
			String(stats.totalTitles),
			`${stats.movieCount} movies, ${stats.tvCount} TV shows`
		);
		this.renderStatCard(grid, "Watching", String(stats.watchingCount));
		this.renderStatCard(grid, "Completed", String(stats.completedCount));
		this.renderStatCard(grid, "Time watched", formatMinutes(stats.timeWatchedMinutes));
		this.renderStatCard(grid, "Time remaining", formatMinutes(stats.timeRemainingMinutes));
	}

	private renderByTypeCards(container: HTMLElement, stats: ReturnType<typeof computeLibraryStats>): void {
		container.createEl("h3", { text: "By type", cls: "marathoner-section-heading" });
		const grid = container.createDiv({ cls: "marathoner-summary-grid" });

		this.renderTypeCard(
			grid,
			"Movies",
			stats.movieCount,
			stats.movieCompletedCount,
			stats.movieWatchedMinutes,
			stats.movieRemainingMinutes,
			stats.moviePercentWatched
		);
		this.renderTypeCard(
			grid,
			"TV shows",
			stats.tvCount,
			stats.tvCompletedCount,
			stats.tvWatchedMinutes,
			stats.tvRemainingMinutes,
			stats.tvPercentWatched
		);
	}

	private renderTypeCard(
		container: HTMLElement,
		label: string,
		count: number,
		completedCount: number,
		watchedMinutes: number,
		remainingMinutes: number,
		percentWatched: number | null
	): void {
		const card = container.createDiv({ cls: "marathoner-stat-card" });
		card.createDiv({ cls: "marathoner-stat-label", text: label });
		card.createDiv({ cls: "marathoner-stat-value", text: percentWatched !== null ? `${percentWatched}%` : "-" });
		card.createDiv({
			cls: "marathoner-stat-subtext",
			text: `${count} total, ${completedCount} completed`,
		});
		card.createDiv({
			cls: "marathoner-stat-subtext",
			text: `${formatMinutes(watchedMinutes)} watched, ${formatMinutes(remainingMinutes)} left`,
		});
	}

	private renderStatCard(container: HTMLElement, label: string, value: string, subtext?: string): void {
		const card = container.createDiv({ cls: "marathoner-stat-card" });
		card.createDiv({ cls: "marathoner-stat-label", text: label });
		card.createDiv({ cls: "marathoner-stat-value", text: value });
		if (subtext) card.createDiv({ cls: "marathoner-stat-subtext", text: subtext });
	}

	private renderRecentSection(container: HTMLElement, heading: string, entries: LibraryEntry[]): void {
		if (entries.length === 0) return;

		container.createEl("h3", { text: heading, cls: "marathoner-section-heading" });
		const row = container.createDiv({ cls: "marathoner-recent-row" });

		for (const entry of entries) {
			const item = row.createDiv({ cls: "marathoner-recent-item" });
			item.addEventListener("click", () => openTitleDetail(this.app, entry.file));

			const posterWrap = item.createDiv({ cls: "marathoner-recent-poster-wrap" });
			const posterUrl = resolveImageSrc(
				this.app,
				this.plugin.settings.storeImagesLocally,
				this.plugin.settings.imagesFolder,
				"title",
				entry.frontmatter.tmdb_id,
				entry.frontmatter.poster_path,
				"w200"
			);
			if (posterUrl) {
				posterWrap.createEl("img", { attr: { src: posterUrl, loading: "lazy" }, cls: "marathoner-recent-poster" });
			}
			renderTypeBadge(posterWrap, entry.frontmatter.type);
			item.createDiv({ cls: "marathoner-recent-title", text: entry.frontmatter.title });
		}
	}

	private renderNerdStats(container: HTMLElement, stats: ReturnType<typeof computeLibraryStats>): void {
		container.createEl("h3", { text: "Library statistics", cls: "marathoner-section-heading" });

		const grid = container.createDiv({ cls: "marathoner-nerd-grid" });

		this.renderNerdTable(grid, "By year", stats.byYear);
		this.renderNerdTable(grid, "Top actors", stats.topActors);
		this.renderNerdTable(grid, "Top directors", stats.topDirectors);
		this.renderNerdTable(grid, "Top studios", stats.topStudios);
	}

	private renderNerdTable(container: HTMLElement, title: string, rows: NameCount[]): void {
		const box = container.createDiv({ cls: "marathoner-nerd-box" });
		box.createDiv({ cls: "marathoner-nerd-box-title", text: title });

		if (rows.length === 0) {
			box.createDiv({ cls: "marathoner-nerd-empty", text: "No data yet" });
			return;
		}

		for (const row of rows) {
			const rowEl = box.createDiv({ cls: "marathoner-nerd-row" });
			const nameEl = rowEl.createSpan({ text: row.name, cls: "marathoner-nerd-row-name" });
			if (row.tmdbId != null) {
				nameEl.addClass("marathoner-person-link");
				nameEl.addEventListener("click", () => {
					void openPersonDetail(this.app, this.plugin.tmdb, this.plugin.settings, row.tmdbId!, row.name);
				});
			}
			rowEl.createSpan({ text: String(row.count), cls: "marathoner-nerd-row-count" });
		}
	}
}
