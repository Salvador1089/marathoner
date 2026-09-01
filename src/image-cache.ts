import { App, TFile, normalizePath, requestUrl } from "obsidian";
import { ensureFolderExists } from "./vault-helpers";
import { TmdbClient } from "./tmdb/client";

export type ImageKind = "title" | "person";

// Local copies are cached at one fixed resolution - good enough even when
// displayed smaller (thumbnails), and avoids storing multiple sizes of the
// same image. Remote mode still requests whatever size fits the context.
const LOCAL_CACHE_SIZE = "w500";

function localImagePath(imagesFolder: string, kind: ImageKind, tmdbId: number, posterPath: string): string {
	const ext = posterPath.split(".").pop() || "jpg";
	const base = imagesFolder.replace(/\/+$/, "");
	return normalizePath(`${base}/${kind}-${tmdbId}.${ext}`);
}

/** True when the requested poster/photo already exists in the local vault cache. */
export function isImageCached(
	app: App,
	imagesFolder: string,
	kind: ImageKind,
	tmdbId: number,
	posterPath: string | null
): boolean {
	if (!posterPath) return false;
	return app.vault.getAbstractFileByPath(localImagePath(imagesFolder, kind, tmdbId, posterPath)) instanceof TFile;
}

/**
 * Downloads and saves a poster/photo into the vault if it isn't already
 * cached. Safe to call unconditionally - no-ops if storing locally is off,
 * there's no image, or it's already been downloaded.
 */
export async function ensureImageCached(
	app: App,
	storeImagesLocally: boolean,
	imagesFolder: string,
	kind: ImageKind,
	tmdbId: number,
	posterPath: string | null
): Promise<boolean> {
	if (!storeImagesLocally || !posterPath) return false;

	const path = localImagePath(imagesFolder, kind, tmdbId, posterPath);
	if (app.vault.getAbstractFileByPath(path)) return true;

	const remoteUrl = TmdbClient.posterUrl(posterPath, LOCAL_CACHE_SIZE);
	if (!remoteUrl) return false;

	try {
		const response = await requestUrl({ url: remoteUrl });
		await ensureFolderExists(app.vault, imagesFolder);
		await app.vault.createBinary(path, response.arrayBuffer);
		return true;
	} catch {
		// Best-effort - rendering falls back to the remote URL if this failed.
		return false;
	}
}

/**
 * Resolves what to put in an <img src>: the local cached file if storing
 * locally is on and it's already been downloaded, otherwise the remote TMDB
 * URL. Never triggers a download itself - that's ensureImageCached's job -
 * so this stays synchronous and safe to call during rendering.
 */
export function resolveImageSrc(
	app: App,
	storeImagesLocally: boolean,
	imagesFolder: string,
	kind: ImageKind,
	tmdbId: number,
	posterPath: string | null,
	remoteSize: "w200" | "w342" | "w500" = "w342"
): string | null {
	if (!posterPath) return null;

	if (storeImagesLocally) {
		const path = localImagePath(imagesFolder, kind, tmdbId, posterPath);
		const file = app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return app.vault.getResourcePath(file);
		}
	}

	return TmdbClient.posterUrl(posterPath, remoteSize);
}
