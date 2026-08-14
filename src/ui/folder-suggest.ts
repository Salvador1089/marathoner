import { AbstractInputSuggest, App, TFolder } from "obsidian";

/**
 * Autocomplete for existing vault folders, for use with a settings TextComponent.
 * Does not prevent typing a folder path that doesn't exist yet - it only
 * assists in selecting an existing one.
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private inputEl: HTMLInputElement,
		private onFolderPicked: (path: string) => void
	) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		const folders: TFolder[] = [];

		for (const file of this.app.vault.getAllLoadedFiles()) {
			if (file instanceof TFolder && file.path.toLowerCase().contains(q)) {
				folders.push(file);
			}
		}

		return folders.sort((a, b) => a.path.localeCompare(b.path));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path === "/" ? "/ (vault root)" : folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.inputEl.value = folder.path;
		this.inputEl.trigger("input"); // ensures the TextComponent's onChange fires
		this.onFolderPicked(folder.path);
		this.close();
	}
}
