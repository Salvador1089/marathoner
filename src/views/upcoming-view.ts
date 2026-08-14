import { ItemView, WorkspaceLeaf, ButtonComponent, ToggleComponent, setIcon, Notice } from "obsidian";
import type MarathonerPlugin from "../main";
import { getLibraryEntries, readEpisodesCache } from "../notes";
import { computeUpcoming, flattenEpisodes, UpcomingItem } from "../upcoming";
import { openTitleDetail } from "./open-title-detail";
import { resolveImageSrc } from "../image-cache";
import { renderTypeChip } from "../ui/type-badge";
import { activateDashboardView } from "./activate-dashboard-view";
import { activateWatchlistView } from "./activate-watchlist-view";
import { buildGoogleCalendarUrl, buildIcsFile, downloadTextFile } from "../calendar";

export const VIEW_TYPE_UPCOMING = "marathoner-upcoming";

export class UpcomingView extends ItemView {
	// View-local, resets each time the view is opened - these are quick
	// filters for the current session, not settings worth persisting.
	private onlyActivelyTracked = false;
	private searchQuery = "";
	private bodyEl!: HTMLElement;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: MarathonerPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_UPCOMING;
	}

	getDisplayText(): string {
		return "Upcoming";
	}

	getIcon(): string {
		return "calendar-clock";
	}

	async onOpen(): Promise<void> {
		this.render();
		this.registerEvent(this.app.vault.on("create", () => this.renderBody()));
		this.registerEvent(this.app.vault.on("delete", () => this.renderBody()));
		this.registerEvent(this.app.vault.on("rename", () => this.renderBody()));
		this.registerEvent(this.app.metadataCache.on("changed", () => this.renderBody()));
	}

	async onClose(): Promise<void> {}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("marathoner-upcoming");

		this.renderToolbar(container);
		this.bodyEl = container.createDiv({ cls: "marathoner-upcoming-body" });
		this.renderBody();
	}

	private async renderBody(): Promise<void> {
		this.bodyEl.empty();

		const entries = getLibraryEntries(this.app, this.plugin.settings.libraryFolder);
		let upcoming = await computeUpcoming(this.app, entries);

		if (this.onlyActivelyTracked) {
			upcoming = upcoming.filter(
				(item) => item.entry.frontmatter.status === "watching" || item.entry.frontmatter.status === "planned"
			);
		}

		const query = this.searchQuery.trim().toLowerCase();
		if (query) {
			upcoming = upcoming.filter((item) => item.entry.frontmatter.title.toLowerCase().includes(query));
		}

		if (upcoming.length === 0) {
			this.bodyEl.createEl("p", {
				text: query
					? `No upcoming titles match "${this.searchQuery.trim()}".`
					: this.onlyActivelyTracked
						? "Nothing scheduled for titles you're watching or planning to watch. Turn off the filter above to see everything else too."
						: "Nothing scheduled. Anything in your library with a known next-episode or release date will show up here as soon as TMDB knows it.",
				cls: "marathoner-empty-state",
			});
			return;
		}

		const groups = groupByMonth(upcoming);
		for (const group of groups) {
			const heading = this.bodyEl.createEl("h3", { cls: "marathoner-status-heading" });
			heading.createSpan({ text: group.label });
			heading.createSpan({ text: ` (${group.items.length})`, cls: "marathoner-upcoming-group-count" });

			const list = this.bodyEl.createDiv({ cls: "marathoner-upcoming-list" });
			for (const item of group.items) {
				this.renderRow(list, item);
			}
		}
	}

	private renderToolbar(container: HTMLElement): void {
		const toolbar = container.createDiv({ cls: "marathoner-toolbar" });

		const searchInput = toolbar.createEl("input", {
			type: "text",
			placeholder: "Search upcoming...",
			cls: "marathoner-search-input",
		});
		searchInput.value = this.searchQuery;
		searchInput.addEventListener("input", () => {
			this.searchQuery = searchInput.value;
			this.renderBody();
		});

		const filterRow = toolbar.createDiv({ cls: "marathoner-upcoming-filter" });
		filterRow.createSpan({ text: "Only watching & planned", cls: "marathoner-upcoming-filter-label" });
		new ToggleComponent(filterRow).setValue(this.onlyActivelyTracked).onChange((value) => {
			this.onlyActivelyTracked = value;
			this.renderBody();
		});

		toolbar.createDiv({ cls: "marathoner-toolbar-spacer" });

		new ButtonComponent(toolbar).setButtonText("Dashboard").onClick(() => {
			activateDashboardView(this.app);
		});
		new ButtonComponent(toolbar).setButtonText("Watchlist").onClick(() => {
			activateWatchlistView(this.app);
		});
	}

	private renderRow(container: HTMLElement, item: UpcomingItem): void {
		const { entry, daysUntil, cadence } = item;
		const fm = entry.frontmatter;

		const row = container.createDiv({ cls: "marathoner-upcoming-row" });
		row.addEventListener("click", () => openTitleDetail(this.app, entry.file));

		const posterUrl = resolveImageSrc(
			this.app,
			this.plugin.settings.storeImagesLocally,
			this.plugin.settings.imagesFolder,
			"title",
			fm.tmdb_id,
			fm.poster_path,
			"w200"
		);
		if (posterUrl) {
			row.createEl("img", { attr: { src: posterUrl, loading: "lazy" }, cls: "marathoner-upcoming-row-thumb" });
		} else {
			row.createDiv({ cls: "marathoner-upcoming-row-thumb marathoner-upcoming-row-thumb-placeholder" }).setText(
				fm.title.slice(0, 1)
			);
		}

		const info = row.createDiv({ cls: "marathoner-upcoming-row-info" });
		const titleLine = info.createDiv({ cls: "marathoner-upcoming-row-title-line" });
		titleLine.createSpan({ cls: "marathoner-upcoming-row-title", text: fm.title });

		const metaLine = info.createDiv({ cls: "marathoner-upcoming-row-meta" });
		renderTypeChip(metaLine, fm.type);
		if (cadence) {
			metaLine.createSpan({ text: cadence, cls: "marathoner-upcoming-row-meta-item" });
		}
		metaLine.createSpan({
			text: fm.type === "movie" ? `Release \u00b7 ${formatDate(item.date)}` : item.label,
			cls: "marathoner-upcoming-row-meta-item",
		});

		const countdown = row.createDiv({ cls: "marathoner-upcoming-row-countdown" });
		if (daysUntil === 0) {
			countdown.setText("Today");
		} else if (daysUntil === 1) {
			countdown.setText("Tomorrow");
		} else {
			countdown.createSpan({ text: String(daysUntil), cls: "marathoner-upcoming-row-countdown-days" });
			countdown.createSpan({ text: "days", cls: "marathoner-upcoming-row-countdown-unit" });
		}

		const actions = row.createDiv({ cls: "marathoner-upcoming-row-actions" });

		const gcalBtn = actions.createDiv({ cls: "marathoner-upcoming-row-action" });
		setIcon(gcalBtn, "calendar-plus");
		gcalBtn.setAttribute("aria-label", "Add to Google Calendar");
		gcalBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			const details = fm.type === "movie" ? "Movie release \u2014 added from Marathoner" : `${item.label} \u2014 added from Marathoner`;
			const url = buildGoogleCalendarUrl(fm.title, details, item.date);
			window.open(url, "_blank");
		});

		if (fm.type === "tv" && item.season != null) {
			const season = item.season;
			const seasonBtn = actions.createDiv({ cls: "marathoner-upcoming-row-action" });
			setIcon(seasonBtn, "calendar-range");
			seasonBtn.setAttribute("aria-label", `Add the rest of Season ${season} to calendar (.ics)`);
			seasonBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				void this.exportSeasonIcs(item, season);
			});
		}
	}

	/** Downloads a .ics file with every remaining, dated, unaired episode of the given season - one import covers the whole rest of the season instead of one Google Calendar link per episode. */
	private async exportSeasonIcs(item: UpcomingItem, season: number): Promise<void> {
		const fm = item.entry.frontmatter;
		const todayIso = new Date().toISOString().slice(0, 10);

		const seasons = await readEpisodesCache(this.app, item.entry.file);
		const remaining = flattenEpisodes(seasons).filter(
			(e) => e.season === season && e.airDate && e.airDate >= todayIso
		);

		if (remaining.length === 0) {
			new Notice("No remaining dated episodes found for this season.");
			return;
		}

		const ics = buildIcsFile(
			remaining.map((e) => ({
				uid: `marathoner-${fm.tmdb_id}-s${e.season}e${e.number}@marathoner`,
				title: fm.title,
				description: `S${String(e.season).padStart(2, "0")}E${String(e.number).padStart(2, "0")} - ${e.name} \u2014 added from Marathoner`,
				dateIso: e.airDate as string,
			}))
		);

		downloadTextFile(`${fm.title} - Season ${season}.ics`, ics, "text/calendar");
		new Notice(`Downloaded ${remaining.length} episode(s) for Season ${season}. Import the file into your calendar app.`);
	}
}

interface MonthGroup {
	label: string;
	items: UpcomingItem[];
}

function groupByMonth(items: UpcomingItem[]): MonthGroup[] {
	const groups: MonthGroup[] = [];
	let currentKey = "";
	let currentGroup: MonthGroup | null = null;

	for (const item of items) {
		const key = item.date.slice(0, 7); // YYYY-MM
		if (key !== currentKey) {
			currentKey = key;
			currentGroup = { label: monthLabel(item.date), items: [] };
			groups.push(currentGroup);
		}
		currentGroup!.items.push(item);
	}

	return groups;
}

function monthLabel(dateIso: string): string {
	const date = new Date(dateIso + "T00:00:00");
	return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatDate(dateIso: string): string {
	const date = new Date(dateIso + "T00:00:00");
	return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
