import { App, TFile, normalizePath, requestUrl } from "obsidian";
import { ensureFolderExists } from "./vault-helpers";
import { TmdbClient } from "./tmdb/client";
import type { MediaType } from "./models/title";

export type ImageKind = "title" | "person";

// Local copies are cached at one fixed resolution - good enough even when
// displayed smaller (thumbnails), and avoids storing multiple sizes of the
// same image. Remote mode still requests whatever size fits the context.
const LOCAL_CACHE_SIZE = "w500";
const MAX_CUSTOM_COVER_BYTES = 20 * 1024 * 1024;
const CUSTOM_COVER_EXTENSIONS: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
};

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

/** Resolves a title's custom vault cover first, then falls back to the normal cached/TMDB poster. */
export function resolveTitleImageSrc(
	app: App,
	storeImagesLocally: boolean,
	imagesFolder: string,
	tmdbId: number,
	posterPath: string | null,
	customPosterPath: string | null,
	remoteSize: "w200" | "w342" | "w500" = "w342"
): string | null {
	if (customPosterPath) {
		const customFile = app.vault.getAbstractFileByPath(normalizePath(customPosterPath));
		if (customFile instanceof TFile) return app.vault.getResourcePath(customFile);
	}

	return resolveImageSrc(app, storeImagesLocally, imagesFolder, "title", tmdbId, posterPath, remoteSize);
}

/** Copies a user-selected raster image into Marathoner's managed assets folder. */
export async function saveCustomTitleCover(
	app: App,
	imagesFolder: string,
	type: MediaType,
	tmdbId: number,
	source: File
): Promise<string> {
	if (source.size > MAX_CUSTOM_COVER_BYTES) {
		throw new Error("The selected image is larger than 20 MB.");
	}

	const nameExtension = source.name.split(".").pop()?.toLowerCase();
	const allowedNameExtension = nameExtension && ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(nameExtension)
		? nameExtension === "jpeg" ? "jpg" : nameExtension
		: null;
	const extension = CUSTOM_COVER_EXTENSIONS[source.type] ?? allowedNameExtension;
	if (!extension) {
		throw new Error("Choose a JPG, PNG, WebP, GIF, or AVIF image.");
	}

	await ensureFolderExists(app.vault, imagesFolder);
	const base = imagesFolder.replace(/\/+$/, "");
	// A unique filename also acts as a cache-buster when replacing a cover with
	// another image of the same format; Chromium cannot reuse the old resource.
	const path = normalizePath(`${base}/custom-title-${type}-${tmdbId}-${Date.now()}.${extension}`);
	const data = await source.arrayBuffer();
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modifyBinary(existing, data);
	} else {
		await app.vault.createBinary(path, data);
	}
	return path;
}

/** Trashes only covers created by saveCustomTitleCover; arbitrary vault images are never removed. */
export async function removeManagedCustomTitleCover(
	app: App,
	path: string | null,
	type: MediaType,
	tmdbId: number
): Promise<void> {
	if (!path) return;
	const file = app.vault.getAbstractFileByPath(normalizePath(path));
	const managedPrefix = `custom-title-${type}-${tmdbId}`;
	if (
		!(file instanceof TFile) ||
		(!file.name.startsWith(`${managedPrefix}-`) && !file.name.startsWith(`${managedPrefix}.`))
	) return;
	try {
		await app.fileManager.trashFile(file);
	} catch {
		// Best-effort cleanup. The frontmatter already points at the new/fallback
		// cover, so an orphaned old asset must not make the UI action fail.
	}
}
