import { App, Modal, Setting } from "obsidian";
import type MarathonerPlugin from "../main";
import type { MarathonerSettings } from "../settings";

const CURATED_SHELF_OPTIONS: { key: keyof MarathonerSettings["visibleShelves"]; label: string; desc: string }[] = [
	{ key: "favorites", label: "Favorites", desc: "Titles you've marked with the heart icon." },
	{ key: "recentlyAdded", label: "Recently added", desc: "The newest titles in your library." },
	{
		key: "recentlyWatched",
		label: "Recently watched",
		desc: "Titles with episodes checked off, or movies completed, most recently.",
	},
	{
		key: "recentlyReleased",
		label: "Recently released",
		desc: "Titles you're watching or planning to watch that have new episodes or a release out.",
	},
];

const STATUS_SHELF_OPTIONS: { key: keyof MarathonerSettings["visibleShelves"]; label: string; desc: string }[] = [
	{ key: "statusWatching", label: "Watching", desc: "The status grid section for titles you're currently watching." },
	{ key: "statusPlanned", label: "Planned", desc: "The status grid section for titles you're planning to watch." },
	{ key: "statusPaused", label: "Paused", desc: "The status grid section for titles you've paused." },
	{ key: "statusCompleted", label: "Completed", desc: "The status grid section for titles you've finished." },
	{ key: "statusDropped", label: "Dropped", desc: "The status grid section for titles you've dropped." },
];

export class ShelfSettingsModal extends Modal {
	constructor(
		app: App,
		private plugin: MarathonerPlugin,
		private onChange: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Watchlist shelves" });
		contentEl.createEl("p", {
			text: "Choose which shelves and status sections appear in your watchlist.",
			cls: "setting-item-description",
		});

		contentEl.createEl("h3", { text: "Curated shelves", cls: "marathoner-status-heading" });
		for (const option of CURATED_SHELF_OPTIONS) {
			this.renderToggle(contentEl, option);
		}

		contentEl.createEl("h3", { text: "Status sections", cls: "marathoner-status-heading" });
		contentEl.createEl("p", {
			text: "These are the grid sections below the shelves, grouped by status.",
			cls: "setting-item-description",
		});
		for (const option of STATUS_SHELF_OPTIONS) {
			this.renderToggle(contentEl, option);
		}
	}

	private renderToggle(
		container: HTMLElement,
		option: { key: keyof MarathonerSettings["visibleShelves"]; label: string; desc: string }
	): void {
		new Setting(container)
			.setName(option.label)
			.setDesc(option.desc)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.visibleShelves[option.key]).onChange(async (value) => {
					this.plugin.settings.visibleShelves[option.key] = value;
					await this.plugin.saveSettings();
					this.onChange();
				})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
