import { App, Modal, DropdownComponent, ButtonComponent, Notice } from "obsidian";
import type MarathonerPlugin from "../main";
import type { ImportSource, ParsedImportItem, ParseResult } from "../migrate/types";
import { parseImdbExport } from "../migrate/sources/imdb";
import { parseLetterboxdExport } from "../migrate/sources/letterboxd";
import { parseSimklExport } from "../migrate/sources/simkl";
import { parseTraktZip } from "../migrate/sources/trakt";
import { parseRyotExport } from "../migrate/sources/ryot";
import { unzipToTextFiles } from "../migrate/zip";
import { runImport } from "../migrate/importer";
import { activateWatchlistView } from "../views/activate-watchlist-view";

interface SourceInfo {
	label: string;
	instructions: string;
	accept: string; // <input accept="...">
}

const SOURCES: Record<ImportSource, SourceInfo> = {
	trakt: {
		label: "Trakt",
		instructions:
			'Settings → Data → "Export All" → download the zip and pick it below as-is (no need to unzip it yourself - Marathoner reads it directly).',
		accept: ".zip",
	},
	letterboxd: {
		label: "Letterboxd",
		instructions:
			"Settings → Import & Export → Export Your Data. Unzip it, then pick watched.csv, ratings.csv, or diary.csv below.",
		accept: ".csv",
	},
	simkl: {
		label: "Simkl",
		instructions: "simkl.com/apps/backup → \"Download Backup (CSV Format)\" → pick the downloaded CSV below.",
		accept: ".csv",
	},
	imdb: {
		label: "IMDb",
		instructions: "Your Ratings (or Watchlist) page on IMDb → the ⋯ menu → Export → pick the downloaded CSV below.",
		accept: ".csv",
	},
	ryot: {
		label: "Ryot",
		instructions: "Imports and Exports settings → Export tab → run an export → download it, then pick the JSON file below.",
		accept: ".json",
	},
};

export class MigrateModal extends Modal {
	private source: ImportSource = "trakt";
	private parsedItems: ParsedImportItem[] = [];
	private running = false;

	private instructionsEl!: HTMLElement;
	private fileStatusEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private startBtn!: ButtonComponent;
	private progressEl!: HTMLElement;
	private resultsEl!: HTMLElement;

	constructor(
		app: App,
		private plugin: MarathonerPlugin
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("marathoner-migrate-modal");

		contentEl.createEl("h2", { text: "Import from another app" });
		contentEl.createEl("p", {
			text: "Matches each entry to TMDB and adds it to your library, filling in status, rating, and watched dates/episodes where the source provides them. Titles already in your library are updated, not duplicated.",
			cls: "marathoner-migrate-intro",
		});

		const sourceRow = contentEl.createDiv({ cls: "marathoner-migrate-row" });
		sourceRow.createSpan({ text: "Source", cls: "marathoner-migrate-label" });
		const sourceDropdown = new DropdownComponent(sourceRow)
			.addOptions(Object.fromEntries((Object.keys(SOURCES) as ImportSource[]).map((s) => [s, SOURCES[s].label])))
			.setValue(this.source)
			.onChange((value) => {
				this.source = value as ImportSource;
				this.resetFile(fileInput);
				this.renderSourceDetails(fileInput);
			});

		this.instructionsEl = contentEl.createEl("p", { cls: "marathoner-migrate-instructions" });

		const fileRow = contentEl.createDiv({ cls: "marathoner-migrate-row" });
		const fileInput = fileRow.createEl("input", { type: "file" });
		fileInput.addEventListener("change", () => this.handleFileChosen(fileInput.files?.[0] ?? null));
		this.fileStatusEl = fileRow.createSpan({ cls: "marathoner-migrate-file-status" });

		this.summaryEl = contentEl.createDiv({ cls: "marathoner-migrate-summary" });
		this.progressEl = contentEl.createDiv({ cls: "marathoner-migrate-progress" });
		this.resultsEl = contentEl.createDiv({ cls: "marathoner-migrate-results" });

		const buttons = contentEl.createDiv({ cls: "marathoner-confirm-buttons" });
		new ButtonComponent(buttons).setButtonText("Close").onClick(() => this.close());
		this.startBtn = new ButtonComponent(buttons)
			.setButtonText("Start import")
			.setCta()
			.setDisabled(true)
			.onClick(() => this.startImport());

		sourceDropdown.selectEl.focus();
		this.renderSourceDetails(fileInput);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderSourceDetails(fileInput: HTMLInputElement): void {
		const info = SOURCES[this.source];
		this.instructionsEl.setText(info.instructions);
		fileInput.setAttribute("accept", info.accept);
	}

	private resetFile(fileInput: HTMLInputElement): void {
		fileInput.value = "";
		this.parsedItems = [];
		this.fileStatusEl.setText("");
		this.summaryEl.empty();
		this.resultsEl.empty();
		this.startBtn.setDisabled(true);
	}

	private async handleFileChosen(file: File | null): Promise<void> {
		this.summaryEl.empty();
		this.resultsEl.empty();
		this.startBtn.setDisabled(true);

		if (!file) {
			this.fileStatusEl.setText("");
			return;
		}

		this.fileStatusEl.setText(`${file.name} - parsing...`);

		let result: ParseResult;
		try {
			result = await this.parse(file);
		} catch (err) {
			this.fileStatusEl.setText(file.name);
			this.summaryEl.createEl("p", {
				text: `Couldn't read this file: ${(err as Error).message}`,
				cls: "marathoner-offline-notice",
			});
			return;
		}

		this.fileStatusEl.setText(file.name);
		this.renderParseSummary(result);

		this.parsedItems = result.items;
		this.startBtn.setDisabled(result.items.length === 0);
	}

	private async parse(file: File): Promise<ParseResult> {
		if (this.source === "trakt") {
			const files = await unzipToTextFiles(file);
			return parseTraktZip(files);
		}

		const text = await file.text();
		switch (this.source) {
			case "imdb":
				return parseImdbExport(text);
			case "letterboxd":
				return parseLetterboxdExport(text);
			case "simkl":
				return parseSimklExport(text);
			case "ryot":
				return parseRyotExport(text);
		}
	}

	private renderParseSummary(result: ParseResult): void {
		this.summaryEl.empty();

		const movies = result.items.filter((i) => i.type === "movie").length;
		const shows = result.items.filter((i) => i.type === "tv").length;

		if (result.items.length === 0) {
			this.summaryEl.createEl("p", {
				text: "Nothing usable found in this file.",
				cls: "marathoner-empty-state",
			});
		} else {
			this.summaryEl.createEl("p", {
				text: `Found ${movies} movie(s) and ${shows} TV show(s)${result.skipped > 0 ? `, ${result.skipped} row(s) skipped` : ""}.`,
			});
		}

		for (const warning of result.warnings) {
			this.summaryEl.createEl("p", { text: warning, cls: "marathoner-offline-notice" });
		}
	}

	private async startImport(): Promise<void> {
		if (this.running || this.parsedItems.length === 0) return;
		this.running = true;
		this.startBtn.setDisabled(true);
		this.resultsEl.empty();

		if (!this.plugin.settings.tmdbApiKey) {
			new Notice("Set a TMDB API key in Settings > Marathoner before importing.");
			this.running = false;
			this.startBtn.setDisabled(false);
			return;
		}

		const total = this.parsedItems.length;
		this.progressEl.setText(`Starting import of ${total} item(s)...`);

		const summary = await runImport(this.app, this.plugin, this.parsedItems, this.source, (done, doneTotal, title) => {
			this.progressEl.setText(done < doneTotal ? `Importing ${done + 1}/${doneTotal}: ${title}` : `Done - ${doneTotal} processed.`);
		});

		this.running = false;
		this.renderResults(summary);
		await activateWatchlistView(this.app);
	}

	private renderResults(summary: { total: number; matched: number; unmatched: { title: string; reason: string }[] }): void {
		this.resultsEl.empty();
		this.resultsEl.createEl("p", {
			text: `Imported ${summary.matched} of ${summary.total} title(s).`,
			cls: "marathoner-migrate-result-summary",
		});

		if (summary.unmatched.length > 0) {
			this.resultsEl.createEl("p", {
				text: `${summary.unmatched.length} couldn't be matched automatically - add these manually if you want them:`,
			});
			const list = this.resultsEl.createDiv({ cls: "marathoner-migrate-unmatched-list" });
			for (const item of summary.unmatched) {
				list.createDiv({ cls: "marathoner-migrate-unmatched-row", text: `${item.title} - ${item.reason}` });
			}
		}

		new Notice(`Import finished: ${summary.matched}/${summary.total} title(s) added.`);
	}
}
