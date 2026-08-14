import { App, TFile } from "obsidian";
import { VIEW_TYPE_DETAIL, DetailView } from "./detail-view";

export async function openTitleDetail(app: App, file: TFile): Promise<void> {
	const leaf = app.workspace.getLeaf(false);
	await leaf.setViewState({ type: VIEW_TYPE_DETAIL, active: true });

	const view = leaf.view;
	if (view instanceof DetailView) {
		await view.setFile(file);
	}

	app.workspace.revealLeaf(leaf);
}
