import { ItemView, WorkspaceLeaf, TFile, ButtonComponent, Notice, ViewStateResult } from "obsidian";
import type MarathonerPlugin from "../main";
import { resolveImageSrc } from "../image-cache";
import { parsePersonFrontmatter, readBiography, readFilmographyCache } from "../people";
import type { PersonFrontmatter } from "../models/person";
import { getLibraryEntries } from "../notes";
import { openTitleDetail } from "./open-title-detail";
import { addTitleFromTmdb } from "../add-title";
import type { MediaType } from "../models/title";
import type { TmdbCombinedCreditCast, TmdbCombinedCreditCrew } from "../tmdb/types";
import { formatSyncedAt } from "../stats";

export const VIEW_TYPE_PERSON_DETAIL = "marathoner-person-detail";

interface FilmographyItem {
	tmdbId: number;
	type: MediaType;
	title: string;
	posterPath: string | null;
	year: string | null;
	roleLabel: string;
}

export class PersonDetailView extends ItemView {
	private filePath: string | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: MarathonerPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PERSON_DETAIL;
	}

	getDisplayText(): string {
		return "Person details";
	}

	getIcon(): string {
		return "user-round";
	}

	async onOpen(): Promise<void> {
		if (!this.filePath) {
			this.renderNoPersonSelected();
		}
	}

	getState(): Record<string, unknown> {
		return this.filePath ? { filePath: this.filePath } : {};
	}

	async setState(state: unknown, _result: ViewStateResult): Promise<void> {
		const filePath =
			state && typeof state === "object" && "filePath" in state && typeof state.filePath === "string"
				? state.filePath
				: null;
		this.filePath = filePath;
		if (filePath) {
			await this.render();
		} else {
			this.renderNoPersonSelected();
		}
	}

	async setFile(file: TFile): Promise<void> {
		this.filePath = file.path;
		await this.render();
	}

	private renderNoPersonSelected(): void {
		this.contentEl.empty();
		this.contentEl.createEl("p", { text: "No person selected." });
	}

	async onClose(): Promise<void> {}

	private getFile(): TFile | null {
		if (!this.filePath) return null;
		const file = this.app.vault.getAbstractFileByPath(this.filePath);
		return file instanceof TFile ? file : null;
	}

	private async render(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("marathoner-detail");

		const file = this.getFile();
		if (!file) {
			container.createEl("p", { text: "Could not load this person." });
			return;
		}

		const raw = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const fm = parsePersonFrontmatter(raw);
		if (!fm) {
			container.createEl("p", { text: "Could not load this person. The note may be malformed." });
			return;
		}

		const layout = container.createDiv({ cls: "marathoner-person-layout" });

		// --- Sidebar: photo + a TMDB-style "Personal Info" fact list ---
		const sidebar = layout.createDiv({ cls: "marathoner-person-sidebar" });

		const photoUrl = resolveImageSrc(
			this.app,
			this.plugin.settings.storeImagesLocally,
			this.plugin.settings.imagesFolder,
			"person",
			fm.tmdb_id,
			fm.profile_path,
			"w342"
		);
		if (photoUrl) {
			sidebar.createEl("img", { attr: { src: photoUrl }, cls: "marathoner-person-photo-large" });
		} else {
			sidebar.createDiv({ cls: "marathoner-person-photo-placeholder" }).setText(fm.name.slice(0, 1));
		}

		this.renderSyncRow(sidebar, fm, file);

		if (fm.imdb_url) {
			new ButtonComponent(sidebar)
				.setButtonText("Open on IMDb")
				.setIcon("external-link")
				.onClick(() => window.open(fm.imdb_url!, "_blank"));
		}

		const facts = sidebar.createDiv({ cls: "marathoner-person-facts-list" });
		this.renderFact(facts, "Known For", fm.known_for_department);
		this.renderFact(facts, "Gender", fm.gender);

		if (fm.deathday) {
			const ageAtDeath = fm.birthday ? computeAgeAtDeath(fm.birthday, fm.deathday) : null;
			this.renderFact(
				facts,
				"Birthday",
				fm.birthday ? `${fm.birthday}${ageAtDeath !== null ? ` (age ${ageAtDeath})` : ""}` : null
			);
			this.renderFact(facts, "Day of Death", fm.deathday);
		} else {
			const age = fm.birthday ? computeAge(fm.birthday) : null;
			this.renderFact(facts, "Birthday", fm.birthday ? `${fm.birthday}${age !== null ? ` (age ${age})` : ""}` : null);
		}

		this.renderFact(facts, "Place of Birth", fm.place_of_birth);

		if (fm.also_known_as.length > 0) {
			this.renderFact(facts, "Also Known As", null, fm.also_known_as);
		}

		// --- Main column: name, biography, filmography ---
		const main = layout.createDiv({ cls: "marathoner-person-main" });
		main.createEl("h1", { text: fm.name, cls: "marathoner-person-name" });

		const bioEl = main.createEl("p", { cls: "marathoner-detail-overview marathoner-person-bio", text: "Loading biography..." });
		readBiography(this.app, file).then((text) => {
			bioEl.setText(text || "No biography available.");
		});

		const filmographyContainer = main.createDiv();

		// Offline-first, same principle as the title Detail view: filmography is
		// cached at creation/refresh time and read straight from the note, no
		// network call just for opening the note.
		const cachedCredits = await readFilmographyCache(this.app, file);
		if (cachedCredits) {
			this.renderFilmography(filmographyContainer, cachedCredits.cast, cachedCredits.crew);
		} else {
			filmographyContainer.createEl("p", {
				text: "No cached filmography yet. Hit Refresh above to fetch it from TMDB.",
				cls: "marathoner-empty-state",
			});
		}
	}

	/** One "label above value" fact, TMDB Personal-Info-box style. Renders nothing if there's no value to show. */
	private renderFact(container: HTMLElement, label: string, value: string | null, list?: string[]): void {
		if (!value && (!list || list.length === 0)) return;

		const fact = container.createDiv({ cls: "marathoner-person-fact" });
		fact.createDiv({ cls: "marathoner-person-fact-label", text: label });
		if (list) {
			fact.createDiv({ cls: "marathoner-person-fact-value", text: list.join(", ") });
		} else {
			fact.createDiv({ cls: "marathoner-person-fact-value", text: value! });
		}
	}

	/** "Last updated" timestamp + manual refresh button - same pattern as the title Detail view. */
	private renderSyncRow(container: HTMLElement, fm: PersonFrontmatter, file: TFile): void {
		const row = container.createDiv({ cls: "marathoner-sync-row" });
		const label = row.createSpan({ cls: "marathoner-sync-label", text: formatSyncedAt(fm.tmdb_synced_at) });

		const refreshBtn = new ButtonComponent(row)
			.setIcon("refresh-cw")
			.setTooltip("Refresh this person from TMDB")
			.onClick(async () => {
				refreshBtn.setDisabled(true);
				refreshBtn.buttonEl.addClass("marathoner-spin");
				label.setText("Refreshing...");

				try {
					await this.plugin.refreshOnePersonNote(file, fm.tmdb_id);
					new Notice(`Refreshed "${fm.name}" from TMDB.`);
					await this.render();
				} catch (err) {
					new Notice(`Refresh failed: ${(err as Error).message}`);
					refreshBtn.setDisabled(false);
					refreshBtn.buttonEl.removeClass("marathoner-spin");
					label.setText(formatSyncedAt(fm.tmdb_synced_at));
				}
			});
		refreshBtn.buttonEl.addClass("marathoner-sync-btn");
	}

	private renderFilmography(
		container: HTMLElement,
		cast: TmdbCombinedCreditCast[],
		crew: TmdbCombinedCreditCrew[]
	): void {
		const libraryMap = new Map<string, TFile>();
		for (const entry of getLibraryEntries(this.app, this.plugin.settings.libraryFolder)) {
			libraryMap.set(`${entry.frontmatter.type}-${entry.frontmatter.tmdb_id}`, entry.file);
		}

		const actingItems = dedupeByKey(
			cast.map((c) => toFilmographyItem(c, c.character || "Actor")),
			(i) => `${i.type}-${i.tmdbId}`
		);

		const crewByDepartment = new Map<string, FilmographyItem[]>();
		for (const c of crew) {
			const item = toFilmographyItem(c, c.job || c.department);
			const list = crewByDepartment.get(c.department) ?? [];
			list.push(item);
			crewByDepartment.set(c.department, list);
		}

		const departments = Array.from(crewByDepartment.keys()).sort((a, b) => a.localeCompare(b));
		if (actingItems.length === 0 && departments.length === 0) {
			container.createEl("p", { text: "No filmography found on TMDB.", cls: "marathoner-empty-state" });
			return;
		}

		container.createEl("h2", { text: "Filmography", cls: "marathoner-person-filmography-heading" });

		if (actingItems.length > 0) {
			this.renderFilmographyShelf(container, "Acting", actingItems, libraryMap);
		}

		for (const department of departments) {
			const items = dedupeByKey(crewByDepartment.get(department)!, (i) => `${i.type}-${i.tmdbId}`);
			this.renderFilmographyShelf(container, department, items, libraryMap);
		}
	}

	private renderFilmographyShelf(
		container: HTMLElement,
		heading: string,
		items: FilmographyItem[],
		libraryMap: Map<string, TFile>
	): void {
		const sorted = [...items].sort((a, b) => (b.year ?? "").localeCompare(a.year ?? ""));

		container.createEl("h3", { text: heading, cls: "marathoner-section-heading" });
		const shelf = container.createDiv({ cls: "marathoner-shelf" });

		for (const item of sorted) {
			const existingFile = libraryMap.get(`${item.type}-${item.tmdbId}`);
			this.renderFilmographyCard(shelf, item, existingFile);
		}
	}

	private renderFilmographyCard(container: HTMLElement, item: FilmographyItem, existingFile?: TFile): void {
		const card = container.createDiv({ cls: "marathoner-card marathoner-card-shelf" });

		card.addEventListener("click", async () => {
			if (existingFile) {
				await openTitleDetail(this.app, existingFile);
				return;
			}

			const notice = new Notice(`Adding "${item.title}"...`, 0);
			try {
				const file = await addTitleFromTmdb(this.app, this.plugin, item.tmdbId, item.type);
				notice.hide();
				await openTitleDetail(this.app, file);
			} catch (err) {
				notice.hide();
				new Notice(`Could not add "${item.title}": ${(err as Error).message}`);
			}
		});

		const posterWrap = card.createDiv({ cls: "marathoner-card-poster-wrap" });
		const posterUrl = resolveImageSrc(
			this.app,
			this.plugin.settings.storeImagesLocally,
			this.plugin.settings.imagesFolder,
			"title",
			item.tmdbId,
			item.posterPath,
			"w342"
		);
		if (posterUrl) {
			posterWrap.createEl("img", { attr: { src: posterUrl, loading: "lazy" }, cls: "marathoner-card-poster" });
		} else {
			posterWrap.createDiv({ cls: "marathoner-card-poster-placeholder" }).setText(item.title.slice(0, 1));
		}

		if (!existingFile) {
			posterWrap.createDiv({ cls: "marathoner-filmography-add-badge", text: "+ Add" });
		}

		const cardInfo = card.createDiv({ cls: "marathoner-card-info" });
		cardInfo.createDiv({
			cls: "marathoner-card-title",
			text: item.year ? `${item.title} (${item.year})` : item.title,
		});
		cardInfo.createDiv({ cls: "marathoner-filmography-role", text: item.roleLabel });
	}
}

function toFilmographyItem(credit: TmdbCombinedCreditCast | TmdbCombinedCreditCrew, roleLabel: string): FilmographyItem {
	const date = credit.release_date ?? credit.first_air_date;
	return {
		tmdbId: credit.id,
		type: credit.media_type,
		title: credit.title ?? credit.name ?? "Untitled",
		posterPath: credit.poster_path,
		year: date ? date.slice(0, 4) : null,
		roleLabel,
	};
}

function dedupeByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
	const seen = new Map<string, T>();
	for (const item of items) {
		if (!seen.has(keyFn(item))) seen.set(keyFn(item), item);
	}
	return Array.from(seen.values());
}

function computeAge(birthday: string): number | null {
	const birth = new Date(birthday);
	if (isNaN(birth.getTime())) return null;
	const now = new Date();
	let age = now.getFullYear() - birth.getFullYear();
	const monthDiff = now.getMonth() - birth.getMonth();
	if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age--;
	return age;
}

function computeAgeAtDeath(birthday: string, deathday: string): number | null {
	const birth = new Date(birthday);
	const death = new Date(deathday);
	if (isNaN(birth.getTime()) || isNaN(death.getTime())) return null;
	let age = death.getFullYear() - birth.getFullYear();
	const monthDiff = death.getMonth() - birth.getMonth();
	if (monthDiff < 0 || (monthDiff === 0 && death.getDate() < birth.getDate())) age--;
	return age;
}
