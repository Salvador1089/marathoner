import { App, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_WATCHLIST } from "./watchlist-view";

export async function activateWatchlistView(app: App): Promise<void> {
	const existing = app.workspace.getLeavesOfType(VIEW_TYPE_WATCHLIST);
	if (existing.length > 0) {
		app.workspace.revealLeaf(existing[0]);
		return;
	}

	const leaf: WorkspaceLeaf = app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: VIEW_TYPE_WATCHLIST, active: true });
	app.workspace.revealLeaf(leaf);
}
