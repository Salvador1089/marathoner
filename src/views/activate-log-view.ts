import { App, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_LOG } from "./log-view";

export async function activateLogView(app: App): Promise<void> {
	const existing = app.workspace.getLeavesOfType(VIEW_TYPE_LOG);
	if (existing.length > 0) {
		app.workspace.revealLeaf(existing[0]);
		return;
	}

	const leaf: WorkspaceLeaf = app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: VIEW_TYPE_LOG, active: true });
	app.workspace.revealLeaf(leaf);
}
