import { App, TFile } from "obsidian";
import type MarathonerPlugin from "../main";
import { addTitleFromTmdb } from "../add-title";
import { matchImportItem } from "./match";
import type { ParsedImportItem, ImportSource } from "./types";
import type { WatchedMap, MediaType, WatchStatus } from "../models/title";
import { applyTvCompletionRule } from "../models/title";

export interface ImportSummary {
	total: number;
	matched: number;
	unmatched: { title: string; reason: string }[];
}

export type ImportProgressCallback = (done: number, total: number, currentTitle: string) => void;

/**
 * Runs a full import: for each parsed item, resolve it to a TMDB id/type
 * (match.ts), add or reuse the title note (addTitleFromTmdb - already safe
 * to call on a title that's already in the library), then layer the
 * imported status/rating/dates/watched-episodes on top without clobbering
 * anything the note already had. Sequential on purpose - large libraries
 * mean many TMDB calls, and this keeps things simple, rate-limit-friendly,
 * and easy to show progress for.
 */
export async function runImport(
	app: App,
	plugin: MarathonerPlugin,
	items: ParsedImportItem[],
	source: ImportSource,
	onProgress?: ImportProgressCallback
): Promise<ImportSummary> {
	const summary: ImportSummary = { total: items.length, matched: 0, unmatched: [] };

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		onProgress?.(i, items.length, item.title);

		try {
			const match = await matchImportItem(plugin.tmdb, item);
			if (!match) {
				summary.unmatched.push({ title: item.title, reason: "No confident TMDB match found" });
				continue;
			}

			const file = await addTitleFromTmdb(app, plugin, match.tmdbId, match.type);
			await applyImportedMetadata(app, file, item, match.type);
			summary.matched++;
		} catch (err) {
			summary.unmatched.push({ title: item.title, reason: (err as Error).message });
		}
	}

	onProgress?.(items.length, items.length, "");

	await plugin.logAction(`Imported from ${sourceLabel(source)}: ${summary.matched}/${summary.total} title(s) matched and added.`);

	return summary;
}

async function applyImportedMetadata(app: App, file: TFile, item: ParsedImportItem, type: MediaType): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm) => {
		// Imports only fill in what's missing or still at its default - they
		// never downgrade a note you've already been tracking yourself. So
		// re-running an import, or importing from two sources, is always safe.
		if (item.status && (!fm.status || fm.status === "planned")) {
			fm.status = mapImportStatus(item.status);
		}
		if (item.rating != null && (fm.rating == null || fm.rating === 0)) {
			fm.rating = item.rating;
		}
		if (item.watchedAt) {
			if (!fm.date_started) fm.date_started = item.watchedAt;
			if (item.status === "completed" && !fm.date_completed) fm.date_completed = item.watchedAt;
		}

		if (type === "tv" && item.episodes && item.episodes.length > 0) {
			const merged: WatchedMap = { ...((fm.watched as WatchedMap) ?? {}) };
			for (const { season, episode } of item.episodes) {
				const existing = new Set(merged[season] ?? []);
				existing.add(episode);
				merged[season] = Array.from(existing).sort((a, b) => a - b);
			}
			fm.watched = merged;
			applyTvCompletionRule(fm, merged, (fm.total_episodes as number) ?? 0);
		}
	});
}

function mapImportStatus(status: NonNullable<ParsedImportItem["status"]>): WatchStatus {
	switch (status) {
		case "watching":
			return "watching";
		case "completed":
			return "completed";
		case "dropped":
			return "dropped";
		case "on_hold":
			return "paused";
		case "planned":
		default:
			return "planned";
	}
}

function sourceLabel(source: ImportSource): string {
	switch (source) {
		case "trakt":
			return "Trakt";
		case "letterboxd":
			return "Letterboxd";
		case "simkl":
			return "Simkl";
		case "imdb":
			return "IMDb";
		case "ryot":
			return "Ryot";
	}
}
