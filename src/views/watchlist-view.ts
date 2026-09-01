import { ItemView, WorkspaceLeaf, ButtonComponent, DropdownComponent, debounce, normalizePath, setIcon } from "obsidian";
import type MarathonerPlugin from "../main";
import { getLibraryEntries, LibraryEntry, resolveTitleFolder } from "../notes";
import { computeWatchlistSections } from "../watchlist-sections";
import { resolveImageSrc } from "../image-cache";
import { countWatchedEpisodes, type WatchStatus, type MediaType } from "../models/title";
import { AddTitleModal } from "../modals/add-title-modal";
import { openTitleDetail } from "./open-title-detail";
import { activateDashboardView } from "./activate-dashboard-view";
import { activateUpcomingView } from "./activate-upcoming-view";
import { renderTypeChip } from "../ui/type-badge";
import { renderStatusBadge } from "../ui/status-badge";
import { ShelfSettingsModal } from "../modals/shelf-settings-modal";
import type { MarathonerSettings } from "../settings";

export const VIEW_TYPE_WATCHLIST = "marathoner-watchlist";

const STATUS_ORDER: WatchStatus[] = ["watching", "planned", "paused", "completed", "dropped"];
const MAX_POSTER_PREFETCHES = 8;

const STATUS_LABELS: Record<WatchStatus, string> = {
	watching: "Watching",
	planned: "Planned",
	paused: "Paused",
	completed: "Completed",
	dropped: "Dropped",
};

/** Maps each status to its toggle key in settings.visibleShelves - see shelf-settings-modal.ts. */
const STATUS_SHELF_KEY: Record<WatchStatus, keyof MarathonerSettings["visibleShelves"]> = {
	watching: "statusWatching",
	planned: "statusPlanned",
	paused: "statusPaused",
	completed: "statusCompleted",
	dropped: "statusDropped",
};

export class WatchlistView extends ItemView {
	private bodyEl!: HTMLElement;
	private searchQuery = "";
	// View-local, resets each time the view is opened - quick filters for the
	// current session, not settings worth persisting. They apply everywhere:
	// the curated shelves above AND the status-grouped grid below, since both
	// are computed from the same (filtered) entry list.
	private filterType: MediaType | "all" = "all";
	private filterStatus: WatchStatus | "all" = "all";
	private filterMinRating = 0;
	private filterFavoritesOnly = false;
	private posterVisibleObserver: IntersectionObserver | null = null;
	private posterPrefetchObserver: IntersectionObserver | null = null;
	private posterPrefetchQueue: HTMLImageElement[] = [];
	private activePosterPrefetches = 0;
	private posterRenderGeneration = 0;
	private loadedPosterSources = new Set<string>();
	private renderGridDebounced = debounce(() => this.renderGrid(), 120, true);

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: MarathonerPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_WATCHLIST;
	}

	getDisplayText(): string {
		return "Watchlist";
	}

	getIcon(): string {
		return "clapperboard";
	}

	async onOpen(): Promise<void> {
		this.createPosterObserver();
		this.render();

		// Keep the grid in sync with vault changes made outside the plugin
		// (renames, manual edits, deletions of title notes). Ignore person notes,
		// assets, and unrelated vault files: rebuilding hundreds of poster cards
		// for each of those changes made already-loaded images appear to reload.
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (this.isTitleNotePath(file.path)) this.renderGridDebounced();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (this.isTitleNotePath(file.path)) this.renderGridDebounced();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (this.isTitleNotePath(file.path) || this.isTitleNotePath(oldPath)) this.renderGridDebounced();
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (this.isTitleNotePath(file.path)) this.renderGridDebounced();
			})
		);
	}

	async onClose(): Promise<void> {
		this.renderGridDebounced.cancel();
		this.resetPosterLoading();
		this.posterVisibleObserver = null;
		this.posterPrefetchObserver = null;
	}

	private isTitleNotePath(path: string): boolean {
		if (!path.toLowerCase().endsWith(".md")) return false;
		const normalized = normalizePath(path);
		const movieFolder = normalizePath(resolveTitleFolder(this.plugin.settings.libraryFolder, "movie"));
		const tvFolder = normalizePath(resolveTitleFolder(this.plugin.settings.libraryFolder, "tv"));
		return normalized.startsWith(`${movieFolder}/`) || normalized.startsWith(`${tvFolder}/`);
	}

	private createPosterObserver(): void {
		if (typeof IntersectionObserver === "undefined") return;

		// Visible cards always jump ahead of speculative prefetches. The root is
		// the actual Obsidian view scroller, rather than the whole Electron window.
		this.posterVisibleObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					this.loadVisiblePoster(entry.target as HTMLImageElement);
				}
			},
			{ root: this.contentEl, threshold: 0 }
		);

		this.posterPrefetchObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					this.enqueuePosterPrefetch(entry.target as HTMLImageElement);
				}
			},
			// A few rows are enough lead time. The queue below caps concurrent
			// requests so a wide grid cannot launch 100+ downloads at once.
			{ root: this.contentEl, rootMargin: "900px 300px", threshold: 0 }
		);
	}

	private renderPoster(container: HTMLElement, src: string): void {
		const image = container.createEl("img", {
			attr: { decoding: "async", alt: "" },
			cls: "marathoner-card-poster",
		}) as HTMLImageElement;

		if (this.loadedPosterSources.has(src)) {
			image.src = src;
			return;
		}

		if (!this.posterVisibleObserver || !this.posterPrefetchObserver) {
			image.addEventListener("load", () => this.loadedPosterSources.add(src), { once: true });
			image.src = src;
			return;
		}

		image.dataset.posterSrc = src;
		image.dataset.posterGeneration = String(this.posterRenderGeneration);
		this.posterVisibleObserver.observe(image);
		this.posterPrefetchObserver.observe(image);
	}

	private loadVisiblePoster(image: HTMLImageElement): void {
		this.posterVisibleObserver?.unobserve(image);
		this.posterPrefetchObserver?.unobserve(image);
		image.setAttribute("fetchpriority", "high");

		if (image.dataset.posterQueued === "true") {
			this.posterPrefetchQueue = this.posterPrefetchQueue.filter((queued) => queued !== image);
			delete image.dataset.posterQueued;
		}

		const src = image.dataset.posterSrc;
		if (!src) return; // Already being prefetched; raising its priority is enough.
		delete image.dataset.posterSrc;
		image.addEventListener("load", () => this.loadedPosterSources.add(src), { once: true });
		image.src = src;
	}

	private enqueuePosterPrefetch(image: HTMLImageElement): void {
		this.posterPrefetchObserver?.unobserve(image);
		if (!image.dataset.posterSrc || image.dataset.posterQueued === "true") return;

		image.dataset.posterQueued = "true";
		this.posterPrefetchQueue.push(image);
		this.pumpPosterPrefetchQueue();
	}

	private pumpPosterPrefetchQueue(): void {
		while (this.activePosterPrefetches < MAX_POSTER_PREFETCHES && this.posterPrefetchQueue.length > 0) {
			const image = this.posterPrefetchQueue.shift()!;
			delete image.dataset.posterQueued;
			const src = image.dataset.posterSrc;
			const generation = Number(image.dataset.posterGeneration);
			if (!src || !image.isConnected || generation !== this.posterRenderGeneration) continue;

			delete image.dataset.posterSrc;
			image.setAttribute("fetchpriority", "low");
			this.activePosterPrefetches += 1;

			const finish = (): void => {
				if (generation !== this.posterRenderGeneration) return;
				this.activePosterPrefetches = Math.max(0, this.activePosterPrefetches - 1);
				this.pumpPosterPrefetchQueue();
			};
			image.addEventListener(
				"load",
				() => {
					this.loadedPosterSources.add(src);
					finish();
				},
				{ once: true }
			);
			image.addEventListener("error", finish, { once: true });
			image.src = src;
		}
	}

	private resetPosterLoading(): void {
		this.posterRenderGeneration += 1;
		this.posterVisibleObserver?.disconnect();
		this.posterPrefetchObserver?.disconnect();
		this.posterPrefetchQueue = [];
		this.activePosterPrefetches = 0;
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("marathoner-watchlist");

		this.renderToolbar(container);
		this.bodyEl = container.createDiv({ cls: "marathoner-watchlist-body" });
		this.renderGrid();
	}

	private renderToolbar(container: HTMLElement): void {
		const toolbar = container.createDiv({ cls: "marathoner-toolbar" });

		const searchInput = toolbar.createEl("input", {
			type: "text",
			placeholder: "Search title, cast, director, year...",
			cls: "marathoner-search-input",
		});
		searchInput.value = this.searchQuery;
		searchInput.addEventListener("input", () => {
			this.searchQuery = searchInput.value;
			this.renderGridDebounced();
		});

		toolbar.createDiv({ cls: "marathoner-toolbar-spacer" });

		new ButtonComponent(toolbar)
			.setIcon("sliders-horizontal")
			.setTooltip("Choose visible shelves")
			.onClick(() => {
				new ShelfSettingsModal(this.app, this.plugin, () => this.renderGrid()).open();
			});

		new ButtonComponent(toolbar).setButtonText("Dashboard").onClick(() => {
			activateDashboardView(this.app);
		});

		new ButtonComponent(toolbar).setButtonText("Upcoming").onClick(() => {
			activateUpcomingView(this.app);
		});

		new ButtonComponent(toolbar)
			.setButtonText("Add title")
			.setCta()
			.onClick(() => {
				new AddTitleModal(this.app, this.plugin).open();
			});

		this.renderFilterRow(container);
	}

	private renderFilterRow(container: HTMLElement): void {
		const row = container.createDiv({ cls: "marathoner-filter-row" });

		new DropdownComponent(row)
			.addOptions({ all: "All types", movie: "Movies", tv: "TV shows" })
			.setValue(this.filterType)
			.onChange((value) => {
				this.filterType = value as MediaType | "all";
				this.renderGrid();
			});

		new DropdownComponent(row)
			.addOptions({
				all: "All statuses",
				watching: STATUS_LABELS.watching,
				planned: STATUS_LABELS.planned,
				paused: STATUS_LABELS.paused,
				completed: STATUS_LABELS.completed,
				dropped: STATUS_LABELS.dropped,
			})
			.setValue(this.filterStatus)
			.onChange((value) => {
				this.filterStatus = value as WatchStatus | "all";
				this.renderGrid();
			});

		new DropdownComponent(row)
			.addOptions({ "0": "Any rating", "7": "\u2605 7+", "8": "\u2605 8+", "9": "\u2605 9+" })
			.setValue(String(this.filterMinRating))
			.onChange((value) => {
				this.filterMinRating = Number(value);
				this.renderGrid();
			});

		const favToggle = row.createDiv({ cls: "marathoner-filter-toggle" });
		const favIcon = favToggle.createSpan({ cls: "marathoner-filter-toggle-icon" });
		setIcon(favIcon, "heart");
		favToggle.createSpan({ text: "Favorites only" });
		favToggle.toggleClass("marathoner-filter-toggle-active", this.filterFavoritesOnly);
		favToggle.addEventListener("click", () => {
			this.filterFavoritesOnly = !this.filterFavoritesOnly;
			favToggle.toggleClass("marathoner-filter-toggle-active", this.filterFavoritesOnly);
			this.renderGrid();
		});

		if (this.hasActiveFilters()) {
			new ButtonComponent(row).setButtonText("Clear filters").onClick(() => {
				this.filterType = "all";
				this.filterStatus = "all";
				this.filterMinRating = 0;
				this.filterFavoritesOnly = false;
				this.renderToolbarAndGrid(container);
			});
		}
	}

	/** Re-renders the whole toolbar (so the filter dropdowns reset visually) plus the grid - used after "Clear filters". */
	private renderToolbarAndGrid(container: HTMLElement): void {
		container.empty();
		this.renderToolbar(container);
		this.bodyEl = container.createDiv({ cls: "marathoner-watchlist-body" });
		this.renderGrid();
	}

	private hasActiveFilters(): boolean {
		return (
			this.filterType !== "all" || this.filterStatus !== "all" || this.filterMinRating > 0 || this.filterFavoritesOnly
		);
	}

	private matchesFilters(entry: LibraryEntry): boolean {
		const fm = entry.frontmatter;
		if (this.filterType !== "all" && fm.type !== this.filterType) return false;
		if (this.filterStatus !== "all" && fm.status !== this.filterStatus) return false;
		if (this.filterMinRating > 0 && (fm.rating ?? 0) < this.filterMinRating) return false;
		if (this.filterFavoritesOnly && !fm.favorite) return false;
		return true;
	}

	private matchesSearch(entry: LibraryEntry, query: string): boolean {
		if (!query) return true;
		const fm = entry.frontmatter;
		const haystack = [fm.title, fm.year ?? "", ...fm.director, ...fm.cast, ...fm.studio].join(" ").toLowerCase();
		return haystack.includes(query);
	}

	private renderGrid(): void {
		// Drop observations for cards that are about to leave the DOM. New cards
		// are registered as they are rendered below.
		this.resetPosterLoading();
		this.bodyEl.empty();

		const allEntries = getLibraryEntries(this.app, this.plugin.settings.libraryFolder);

		if (allEntries.length === 0) {
			this.bodyEl.createEl("p", {
				text: 'No titles yet. Click "Add title" above to get started.',
				cls: "marathoner-empty-state",
			});
			return;
		}

		const query = this.searchQuery.trim().toLowerCase();
		const entries = allEntries.filter((e) => this.matchesFilters(e) && this.matchesSearch(e, query));

		if (entries.length === 0) {
			this.bodyEl.createEl("p", {
				text: query
					? `No titles match "${this.searchQuery.trim()}".`
					: "No titles match the current filters.",
				cls: "marathoner-empty-state",
			});
			return;
		}

		// Shelves are only meaningful without an active search filter - once the
		// person is searching, they want the flat filtered result, not curated rows.
		// Type/status/rating/favorites filters, on the other hand, apply to the
		// shelves too - they're drawn from this same filtered entry list.
		if (!query) {
			const sections = computeWatchlistSections(entries);
			const visible = this.plugin.settings.visibleShelves;
			if (visible.favorites) this.renderShelf("Favorites", sections.favorites);
			if (visible.recentlyAdded) this.renderShelf("Recently added", sections.recentlyAdded);
			if (visible.recentlyWatched) this.renderShelf("Recently watched", sections.recentlyWatched);
			if (visible.recentlyReleased) this.renderShelf("Recently released", sections.recentlyReleased);
		}

		const grouped = groupByStatus(entries);
		const visibleStatuses = this.plugin.settings.visibleShelves;

		for (const status of STATUS_ORDER) {
			if (!visibleStatuses[STATUS_SHELF_KEY[status]]) continue;

			const group = grouped[status];
			if (!group || group.length === 0) continue;

			this.bodyEl.createEl("h3", { text: STATUS_LABELS[status], cls: "marathoner-status-heading" });

			const grid = this.bodyEl.createDiv({ cls: "marathoner-grid" });
			for (const entry of group) {
				this.renderCard(grid, entry);
			}
		}
	}

	private renderShelf(heading: string, entries: LibraryEntry[]): void {
		if (entries.length === 0) return;

		this.bodyEl.createEl("h3", { text: heading, cls: "marathoner-status-heading" });
		const shelf = this.bodyEl.createDiv({ cls: "marathoner-shelf" });
		for (const entry of entries) {
			this.renderCard(shelf, entry, true);
		}
	}

	private renderCard(container: HTMLElement, entry: LibraryEntry, inShelf = false): void {
		const { file, frontmatter } = entry;

		const card = container.createDiv({ cls: inShelf ? "marathoner-card marathoner-card-shelf" : "marathoner-card" });
		card.addEventListener("click", () => {
			openTitleDetail(this.app, file);
		});

		const posterWrap = card.createDiv({ cls: "marathoner-card-poster-wrap" });
		const posterUrl = resolveImageSrc(
			this.app,
			this.plugin.settings.storeImagesLocally,
			this.plugin.settings.imagesFolder,
			"title",
			frontmatter.tmdb_id,
			frontmatter.poster_path,
			// Cards are roughly 160px wide; w200 cuts remote transfer/decode cost
			// substantially while retaining enough detail at this display size.
			"w200"
		);
		const placeholder = posterWrap.createDiv({ cls: "marathoner-card-poster-placeholder" });
		placeholder.setText(frontmatter.title.slice(0, 1));
		if (posterUrl) {
			this.renderPoster(posterWrap, posterUrl);
		}

		renderStatusBadge(card, frontmatter.status);

		const favoriteBtn = card.createDiv({
			cls: `marathoner-card-favorite ${frontmatter.favorite ? "marathoner-card-favorite-active" : ""}`,
		});
		setIcon(favoriteBtn, "heart");
		favoriteBtn.addEventListener("click", async (evt) => {
			evt.stopPropagation();
			const next = !frontmatter.favorite;
			try {
				await this.app.fileManager.processFrontMatter(file, (fm) => {
					fm.favorite = next;
					fm.date_modified = new Date().toISOString();
				});
			} catch {
				// Silently ignore - metadata cache change event will re-render and reflect the true state.
			}
		});

		const info = card.createDiv({ cls: "marathoner-card-info" });
		info.createDiv({ cls: "marathoner-card-title", text: frontmatter.title });

		const meta = info.createDiv({ cls: "marathoner-card-meta" });
		renderTypeChip(meta, frontmatter.type);
		if (frontmatter.year) {
			meta.createSpan({ cls: "marathoner-card-year", text: frontmatter.year });
		}
		if (frontmatter.rating !== null) {
			meta.createSpan({ cls: "marathoner-card-rating", text: `\u2605 ${frontmatter.rating}` });
		}

		if (frontmatter.type === "tv" && frontmatter.total_episodes) {
			const watched = Math.min(countWatchedEpisodes(frontmatter.watched), frontmatter.total_episodes);
			const percent = Math.round((watched / frontmatter.total_episodes) * 100);

			const progressWrap = info.createDiv({ cls: "marathoner-card-progress-wrap" });
			progressWrap.createDiv({ cls: "marathoner-card-progress-track" });
			const bar = progressWrap.createDiv({ cls: "marathoner-card-progress-bar" });
			bar.style.width = `${percent}%`;
			info.createDiv({
				cls: "marathoner-card-progress-label",
				text: `${watched}/${frontmatter.total_episodes}`,
			});
		}
	}
}

function groupByStatus(entries: LibraryEntry[]): Partial<Record<WatchStatus, LibraryEntry[]>> {
	const grouped: Partial<Record<WatchStatus, LibraryEntry[]>> = {};
	for (const entry of entries) {
		const status = entry.frontmatter.status;
		if (!grouped[status]) grouped[status] = [];
		grouped[status]!.push(entry);
	}
	for (const group of Object.values(grouped)) {
		group.sort((a, b) => a.frontmatter.title.localeCompare(b.frontmatter.title));
	}
	return grouped;
}
