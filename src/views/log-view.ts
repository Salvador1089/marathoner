import { ItemView, WorkspaceLeaf, ButtonComponent } from "obsidian";
import type MarathonerPlugin from "../main";
import { activateDashboardView } from "./activate-dashboard-view";
import { activateWatchlistView } from "./activate-watchlist-view";
import { ConfirmModal } from "../ui/confirm-modal";
import type { LogEntry } from "../activity-log";

export const VIEW_TYPE_LOG = "marathoner-log";

export class LogView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private plugin: MarathonerPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_LOG;
	}

	getDisplayText(): string {
		return "Activity log";
	}

	getIcon(): string {
		return "scroll-text";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("marathoner-log-view");

		this.renderToolbar(container);

		const entries = this.plugin.settings.activityLog;
		if (entries.length === 0) {
			container.createEl("p", {
				text: "Nothing logged yet. Every add, delete, watch, and status/date change you make shows up here.",
				cls: "marathoner-empty-state",
			});
			return;
		}

		const groups = groupByDay(entries);
		for (const group of groups) {
			container.createEl("h3", { text: group.label, cls: "marathoner-status-heading" });
			const list = container.createDiv({ cls: "marathoner-log-list" });
			for (const entry of group.entries) {
				const row = list.createDiv({ cls: "marathoner-log-row" });
				row.createSpan({ cls: "marathoner-log-time", text: formatTime(entry.timestamp) });
				row.createSpan({ cls: "marathoner-log-message", text: entry.message });
			}
		}
	}

	private renderToolbar(container: HTMLElement): void {
		const toolbar = container.createDiv({ cls: "marathoner-toolbar" });
		toolbar.createDiv({ cls: "marathoner-toolbar-spacer" });

		new ButtonComponent(toolbar).setButtonText("Dashboard").onClick(() => {
			activateDashboardView(this.app);
		});
		new ButtonComponent(toolbar).setButtonText("Watchlist").onClick(() => {
			activateWatchlistView(this.app);
		});

		new ButtonComponent(toolbar)
			.setButtonText("Clear log")
			.setWarning()
			.onClick(() => {
				new ConfirmModal(
					this.app,
					"Clear activity log?",
					"This removes every entry currently in the log. It doesn't affect your titles, ratings, or watched episodes - only this history.",
					"Clear",
					async () => {
						this.plugin.settings.activityLog = [];
						await this.plugin.saveSettings();
						this.render();
					}
				).open();
			});
	}
}

interface DayGroup {
	label: string;
	entries: LogEntry[];
}

function groupByDay(entries: LogEntry[]): DayGroup[] {
	const groups: DayGroup[] = [];
	let currentKey = "";
	let currentGroup: DayGroup | null = null;

	for (const entry of entries) {
		const key = entry.timestamp.slice(0, 10);
		if (key !== currentKey) {
			currentKey = key;
			currentGroup = { label: dayLabel(key), entries: [] };
			groups.push(currentGroup);
		}
		currentGroup!.entries.push(entry);
	}

	return groups;
}

function dayLabel(dateIso: string): string {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const target = new Date(dateIso + "T00:00:00");
	const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));

	if (diffDays === 0) return "Today";
	if (diffDays === 1) return "Yesterday";
	if (diffDays > 1 && diffDays < 7) return target.toLocaleDateString(undefined, { weekday: "long" });
	return target.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function formatTime(iso: string): string {
	const date = new Date(iso);
	if (isNaN(date.getTime())) return "";
	return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
