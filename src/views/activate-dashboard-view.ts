import { App, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_DASHBOARD } from "./dashboard-view";

export async function activateDashboardView(app: App): Promise<void> {
	const existing = app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD);
	if (existing.length > 0) {
		app.workspace.revealLeaf(existing[0]);
		return;
	}

	const leaf: WorkspaceLeaf = app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: VIEW_TYPE_DASHBOARD, active: true });
	app.workspace.revealLeaf(leaf);
}
