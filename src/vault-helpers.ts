import { Vault, TFolder, App, TFile, normalizePath } from "obsidian";

/**
 * Waits for Obsidian's metadataCache to re-index a file after we just wrote
 * to it. `processFrontMatter`/`vault.modify` resolve once the write hits
 * disk, but the cache updates asynchronously afterwards - reading
 * `metadataCache.getFileCache()` right after a write can briefly return
 * stale or missing frontmatter. Callers that immediately re-read frontmatter
 * after a refresh (e.g. to re-render a Detail view) should await this first,
 * or they can flash a "malformed note" error for one frame.
 */
export async function waitForMetadataRefresh(app: App, file: TFile, timeoutMs = 2000): Promise<void> {
	await new Promise<void>((resolve) => {
		const timeout = window.setTimeout(() => {
			cleanup();
			resolve();
		}, timeoutMs);

		const ref = app.metadataCache.on("changed", (changedFile) => {
			if (changedFile.path === file.path) {
				cleanup();
				resolve();
			}
		});

		function cleanup() {
			window.clearTimeout(timeout);
			app.metadataCache.offref(ref);
		}
	});
}

/**
 * Ensures a folder exists in the vault, creating it (and parent folders)
 * if necessary. Call this before writing a new note, not at settings time,
 * since the user may configure a path before the folder exists.
 */
export async function ensureFolderExists(vault: Vault, path: string): Promise<void> {
	const normalized = path.replace(/^\/+|\/+$/g, "");
	if (!normalized) return; // vault root, always exists

	const existing = vault.getAbstractFileByPath(normalized);
	if (existing instanceof TFolder) return;

	await vault.createFolder(normalized);
}

/**
 * Moves a file into the target folder if it isn't already there, using
 * Obsidian's own rename API so internal links are updated automatically.
 * Used by Repair to reorganize notes created before the folder-per-type
 * structure existed. No-op if the file is already in the right place.
 */
export async function migrateFileToFolder(app: App, file: TFile, targetFolder: string): Promise<TFile> {
	const normalizedTarget = targetFolder.replace(/^\/+|\/+$/g, "");
	const currentFolder = file.parent?.path ?? "";
	if (currentFolder === normalizedTarget) return file;

	await ensureFolderExists(app.vault, normalizedTarget);

	let newPath = normalizePath(`${normalizedTarget}/${file.name}`);
	if (app.vault.getAbstractFileByPath(newPath)) {
		newPath = normalizePath(`${normalizedTarget}/${file.basename}-${Date.now()}.${file.extension}`);
	}

	await app.fileManager.renameFile(file, newPath);
	const moved = app.vault.getAbstractFileByPath(newPath);
	return moved instanceof TFile ? moved : file;
}
