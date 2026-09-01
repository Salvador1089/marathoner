import { App, TFile } from "obsidian";
import { VIEW_TYPE_DETAIL } from "./detail-view";

export async function openTitleDetail(app: App, file: TFile): Promise<void> {
	const leaf = app.workspace.getLeaf(false);
	await leaf.setViewState({ type: VIEW_TYPE_DETAIL, state: { filePath: file.path }, active: true });

	app.workspace.revealLeaf(leaf);
}
