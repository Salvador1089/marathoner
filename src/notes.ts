import { App, TFile, normalizePath } from "obsidian";
import { ensureFolderExists, waitForMetadataRefresh } from "./vault-helpers";
import {
	createDefaultFrontmatter,
	MediaType,
	TitleFrontmatter,
	TitleEnrichment,
	WatchStatus,
	WatchedMap,
	EpisodeRatingMap,
	CachedSeason,
} from "./models/title";

const INVALID_FILENAME_CHARS = /[/\\*?"<>|]/g;

/** Movies and TV shows are kept in separate subfolders, not dumped together. */
export function resolveTitleFolder(libraryFolder: string, type: MediaType): string {
	const base = libraryFolder.replace(/\/+$/, "");
	return `${base}/${type === "movie" ? "Movies" : "TV Shows"}`;
}

function sanitizeFilenamePart(part: string): string {
	return part
		.replace(/:/g, " -") // preserve subtitle separation, e.g. "Title: Subtitle" -> "Title - Subtitle"
		.replace(INVALID_FILENAME_CHARS, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Looks up a title note by tmdb_id across the whole vault. This is the real identity, not the filename. */
export function findExistingTitleNote(app: App, tmdbId: number, type: MediaType): TFile | null {
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm && fm.tmdb_id === tmdbId && fm.type === type) {
			return file;
		}
	}
	return null;
}

async function resolveUniqueFilePath(
	app: App,
	folder: string,
	title: string,
	year: string | null,
	tmdbId: number
): Promise<string> {
	const safeTitle = sanitizeFilenamePart(title) || `untitled-${tmdbId}`;
	const base = year ? `${safeTitle} (${year})` : safeTitle;

	const candidate = normalizePath(`${folder}/${base}.md`);
	if (!app.vault.getAbstractFileByPath(candidate)) {
		return candidate;
	}

	// Filename collision with a different title (different tmdb_id) - disambiguate.
	return normalizePath(`${folder}/${base} - ${tmdbId}.md`);
}

export interface CreateTitleNoteParams {
	app: App;
	libraryFolder: string;
	tmdbId: number;
	type: MediaType;
	enrichment: TitleEnrichment;
}

/**
 * Creates the title note if it doesn't exist yet, or returns the existing one.
 * Identity is always tmdb_id + type - the filename is cosmetic only.
 */
export async function createOrOpenTitleNote(params: CreateTitleNoteParams): Promise<TFile> {
	const { app, libraryFolder, tmdbId, type, enrichment } = params;

	const existing = findExistingTitleNote(app, tmdbId, type);
	if (existing) return existing;

	const targetFolder = resolveTitleFolder(libraryFolder, type);
	await ensureFolderExists(app.vault, targetFolder);

	const path = await resolveUniqueFilePath(app, targetFolder, enrichment.title, enrichment.year, tmdbId);
	const frontmatter = createDefaultFrontmatter(tmdbId, type, enrichment);
	const content = renderNoteContent(frontmatter);

	const file = await app.vault.create(path, content);
	await waitForFrontmatterIndexed(app, file);
	return file;
}

/**
 * Obsidian indexes frontmatter into metadataCache asynchronously after a file
 * is created. Callers that immediately read frontmatter via metadataCache
 * (e.g. opening the Detail view right after creation) would otherwise hit a
 * race condition and see no frontmatter yet. This waits for indexing to catch up.
 */
async function waitForFrontmatterIndexed(app: App, file: TFile, timeoutMs = 2000): Promise<void> {
	if (app.metadataCache.getFileCache(file)?.frontmatter) return;

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

function yamlString(value: string): string {
	// Escape backslashes and quotes, and collapse any embedded newlines - YAML
	// double-quoted scalars must stay on one line. Overviews from TMDB are
	// normally single-paragraph, but this keeps a stray one from corrupting
	// the frontmatter block instead of just looking a bit odd.
	const safe = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
	return `"${safe}"`;
}

function yamlStringList(values: string[]): string {
	if (values.length === 0) return "[]";
	return `[${values.map(yamlString).join(", ")}]`;
}

function yamlNumberList(values: number[]): string {
	return `[${values.join(", ")}]`;
}

function yamlNullableNumber(value: number | null): string {
	return value === null ? "null" : String(value);
}

function yamlNullableString(value: string | null): string {
	return value === null ? "null" : yamlString(value);
}

function renderNoteContent(fm: TitleFrontmatter): string {
	const yaml = [
		"---",
		`schema_version: ${fm.schema_version}`,
		`tmdb_id: ${fm.tmdb_id}`,
		`type: ${fm.type}`,
		`title: ${yamlString(fm.title)}`,
		`year: ${fm.year ?? "null"}`,
		`poster_path: ${yamlNullableString(fm.poster_path)}`,
		`overview: ${yamlNullableString(fm.overview)}`,
		`release_date: ${yamlNullableString(fm.release_date)}`,
		`last_episode_air_date: ${yamlNullableString(fm.last_episode_air_date)}`,
		`next_episode_air_date: ${yamlNullableString(fm.next_episode_air_date)}`,
		`next_episode_label: ${yamlNullableString(fm.next_episode_label)}`,
		`next_episode_season: ${fm.next_episode_season ?? "null"}`,
		`next_episode_number: ${fm.next_episode_number ?? "null"}`,
		`tmdb_synced_at: ${fm.tmdb_synced_at ? yamlString(fm.tmdb_synced_at) : "null"}`,
		`status: ${fm.status}`,
		`rating: ${yamlNullableNumber(fm.rating)}`,
		`favorite: ${fm.favorite}`,
		`date_added: ${fm.date_added}`,
		`date_modified: ${yamlString(fm.date_modified)}`,
		`date_last_watched: ${fm.date_last_watched ? yamlString(fm.date_last_watched) : "null"}`,
		`date_started: ${fm.date_started ?? "null"}`,
		`date_completed: ${fm.date_completed ?? "null"}`,
		...(fm.type === "tv" ? ["watched: {}", "episode_ratings: {}"] : []),
		`director: ${yamlStringList(fm.director)}`,
		`director_ids: ${yamlNumberList(fm.director_ids)}`,
		`cast: ${yamlStringList(fm.cast)}`,
		`cast_ids: ${yamlNumberList(fm.cast_ids)}`,
		`studio: ${yamlStringList(fm.studio)}`,
		`runtime: ${yamlNullableNumber(fm.runtime)}`,
		`total_episodes: ${yamlNullableNumber(fm.total_episodes)}`,
		`community_rating: ${yamlNullableNumber(fm.community_rating)}`,
		`community_votes: ${yamlNullableNumber(fm.community_votes)}`,
		`trailer_url: ${yamlNullableString(fm.trailer_url)}`,
		`imdb_url: ${yamlNullableString(fm.imdb_url)}`,
		"---",
		"",
		...(fm.type === "tv" ? ["## Episodes", "", "```json", "[]", "```", ""] : []),
		"## Notes",
		"",
	];
	return yaml.join("\n");
}

const VALID_STATUSES: WatchStatus[] = ["watching", "completed", "planned", "paused", "dropped"];

function toStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function toNumberArray(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

/** Sanitizes hand-edited YAML and older notes into valid 1-10 episode ratings. */
function toEpisodeRatingMap(value: unknown): EpisodeRatingMap {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};

	const ratings: EpisodeRatingMap = {};
	for (const [seasonKey, rawSeason] of Object.entries(value)) {
		const season = Number(seasonKey);
		if (!Number.isInteger(season) || season < 0 || !rawSeason || typeof rawSeason !== "object" || Array.isArray(rawSeason)) {
			continue;
		}

		const seasonRatings: Record<number, number> = {};
		for (const [episodeKey, rawRating] of Object.entries(rawSeason)) {
			const episode = Number(episodeKey);
			if (
				Number.isInteger(episode) &&
				episode >= 0 &&
				typeof rawRating === "number" &&
				Number.isInteger(rawRating) &&
				rawRating >= 1 &&
				rawRating <= 10
			) {
				seasonRatings[episode] = rawRating;
			}
		}

		if (Object.keys(seasonRatings).length > 0) ratings[season] = seasonRatings;
	}

	return ratings;
}

/**
 * Parses raw frontmatter (as returned by Obsidian's metadata cache) into a
 * typed TitleFrontmatter, or null if it doesn't look like a Marathoner note.
 * Defensive by design: notes can be hand-edited and end up malformed, and
 * notes created before a schema change won't have every field.
 */
export function parseTitleFrontmatter(raw: Record<string, unknown> | undefined): TitleFrontmatter | null {
	if (!raw || typeof raw.tmdb_id !== "number" || (raw.type !== "movie" && raw.type !== "tv")) {
		return null;
	}

	const status = VALID_STATUSES.includes(raw.status as WatchStatus) ? (raw.status as WatchStatus) : "planned";

	return {
		schema_version: typeof raw.schema_version === "number" ? raw.schema_version : 1,
		tmdb_id: raw.tmdb_id,
		type: raw.type,
		status,
		rating: typeof raw.rating === "number" ? raw.rating : null,
		date_added: typeof raw.date_added === "string" ? raw.date_added : "",
		date_modified: typeof raw.date_modified === "string" ? raw.date_modified : (typeof raw.date_added === "string" ? raw.date_added : ""),
		date_started: typeof raw.date_started === "string" ? raw.date_started : null,
		date_completed: typeof raw.date_completed === "string" ? raw.date_completed : null,
		watched: (raw.watched as WatchedMap | undefined) ?? (raw.type === "tv" ? {} : undefined),
		episode_ratings: raw.type === "tv" ? toEpisodeRatingMap(raw.episode_ratings) : undefined,
		title: typeof raw.title === "string" ? raw.title : "Untitled",
		year: typeof raw.year === "string" || typeof raw.year === "number" ? String(raw.year) : null,
		poster_path: typeof raw.poster_path === "string" ? raw.poster_path : null,
		overview: typeof raw.overview === "string" ? raw.overview : null,
		release_date: typeof raw.release_date === "string" ? raw.release_date : null,
		last_episode_air_date: typeof raw.last_episode_air_date === "string" ? raw.last_episode_air_date : null,
		next_episode_air_date: typeof raw.next_episode_air_date === "string" ? raw.next_episode_air_date : null,
		next_episode_label: typeof raw.next_episode_label === "string" ? raw.next_episode_label : null,
		next_episode_season: typeof raw.next_episode_season === "number" ? raw.next_episode_season : null,
		next_episode_number: typeof raw.next_episode_number === "number" ? raw.next_episode_number : null,
		tmdb_synced_at: typeof raw.tmdb_synced_at === "string" ? raw.tmdb_synced_at : null,
		favorite: raw.favorite === true,
		date_last_watched: typeof raw.date_last_watched === "string" ? raw.date_last_watched : null,
		director: toStringArray(raw.director),
		director_ids: toNumberArray(raw.director_ids),
		cast: toStringArray(raw.cast),
		cast_ids: toNumberArray(raw.cast_ids),
		studio: toStringArray(raw.studio),
		runtime: typeof raw.runtime === "number" ? raw.runtime : null,
		total_episodes: typeof raw.total_episodes === "number" ? raw.total_episodes : null,
		community_rating: typeof raw.community_rating === "number" ? raw.community_rating : null,
		community_votes: typeof raw.community_votes === "number" ? raw.community_votes : null,
		trailer_url: typeof raw.trailer_url === "string" ? raw.trailer_url : null,
		imdb_url: typeof raw.imdb_url === "string" ? raw.imdb_url : null,
	};
}

const NOTES_HEADING = "## Notes";
const EPISODES_HEADING = "## Episodes";

/** Finds the text of a "## Heading" section (up to the next "## " heading or end of file). */
export function extractSection(content: string, heading: string): { start: number; end: number; body: string } | null {
	const start = content.indexOf(heading);
	if (start === -1) return null;

	const afterHeading = start + heading.length;
	const nextHeadingMatch = content.slice(afterHeading).match(/\n## /);
	const end = nextHeadingMatch ? afterHeading + (nextHeadingMatch.index ?? 0) : content.length;

	return { start, end, body: content.slice(afterHeading, end) };
}

/**
 * Generic "write (or insert) a ## section" used for any cached, non-user-edited
 * block in a note's body - synopsis-adjacent content like a person's biography
 * or filmography, cached the same way episodes are. If the heading already
 * exists, its content is replaced in place; otherwise it's inserted right
 * before `insertBeforeHeading` (if given and present), or appended at the end.
 */
export async function writeMarkdownSection(
	app: App,
	file: TFile,
	heading: string,
	body: string,
	insertBeforeHeading?: string
): Promise<void> {
	const content = await app.vault.read(file);
	const block = `${heading}\n\n${body}\n\n`;

	const existing = extractSection(content, heading);
	if (existing) {
		const newContent = content.slice(0, existing.start) + block + content.slice(existing.end).replace(/^\n+/, "\n");
		await app.vault.modify(file, newContent);
		return;
	}

	if (insertBeforeHeading) {
		const idx = content.indexOf(insertBeforeHeading);
		if (idx !== -1) {
			const newContent = content.slice(0, idx) + block + content.slice(idx);
			await app.vault.modify(file, newContent);
			return;
		}
	}

	const separator = content.endsWith("\n") ? "" : "\n";
	await app.vault.modify(file, `${content}${separator}\n${block}`);
}

/** Reads the cached season/episode structure written when the title was added or last repaired. */
export async function readEpisodesCache(app: App, file: TFile): Promise<CachedSeason[]> {
	const content = await app.vault.read(file);
	const section = extractSection(content, EPISODES_HEADING);
	if (!section) return [];

	const jsonMatch = section.body.match(/```json\n([\s\S]*?)\n```/);
	if (!jsonMatch) return [];

	try {
		const parsed = JSON.parse(jsonMatch[1]);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * Writes the full season/episode structure as a JSON block under "## Episodes".
 * Placed before "## Notes" so the person's own free-form notes always stay
 * last and easy to find. This is what makes a show fully usable offline
 * immediately after being added - not just its top-level metadata.
 */
export async function writeEpisodesCache(app: App, file: TFile, seasons: CachedSeason[]): Promise<void> {
	const content = await app.vault.read(file);
	const block = `${EPISODES_HEADING}\n\n\`\`\`json\n${JSON.stringify(seasons)}\n\`\`\`\n\n`;

	const existing = extractSection(content, EPISODES_HEADING);
	let newContent: string;
	if (existing) {
		newContent = content.slice(0, existing.start) + block + content.slice(existing.end).replace(/^\n+/, "\n");
	} else {
		const notesIdx = content.indexOf(NOTES_HEADING);
		if (notesIdx !== -1) {
			newContent = content.slice(0, notesIdx) + block + content.slice(notesIdx);
		} else {
			const separator = content.endsWith("\n") ? "" : "\n";
			newContent = `${content}${separator}\n${block}`;
		}
	}

	// Subscribe before writing so a very fast metadata-cache event cannot be
	// missed between vault.modify() resolving and the listener being attached.
	// DetailView reads this cache immediately after a title is added.
	const metadataRefresh = waitForMetadataRefresh(app, file);
	await app.vault.modify(file, newContent);
	await metadataRefresh;
}

/** Reads the free-form text after the "## Notes" heading in a title note's body. */
export async function readNotesBody(app: App, file: TFile): Promise<string> {
	const content = await app.vault.read(file);
	const idx = content.indexOf(NOTES_HEADING);
	if (idx === -1) return "";
	return content.slice(idx + NOTES_HEADING.length).replace(/^\n+/, "");
}

/** Replaces the free-form text after "## Notes", preserving frontmatter and the heading itself. */
export async function writeNotesBody(app: App, file: TFile, text: string): Promise<void> {
	const content = await app.vault.read(file);
	const idx = content.indexOf(NOTES_HEADING);

	if (idx === -1) {
		// Defensive: a hand-edited note might have lost the heading. Re-append it.
		const separator = content.endsWith("\n") ? "" : "\n";
		await app.vault.modify(file, `${content}${separator}\n${NOTES_HEADING}\n\n${text}\n`);
		return;
	}

	const before = content.slice(0, idx + NOTES_HEADING.length);
	await app.vault.modify(file, `${before}\n\n${text}\n`);
}

export interface LibraryEntry {
	file: TFile;
	frontmatter: TitleFrontmatter;
}

/** Reads all valid Marathoner title notes within the configured library folder. */
export function getLibraryEntries(app: App, libraryFolder: string): LibraryEntry[] {
	const normalizedFolder = normalizePath(libraryFolder);
	const entries: LibraryEntry[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(normalizedFolder + "/")) continue;

		const raw = app.metadataCache.getFileCache(file)?.frontmatter;
		const frontmatter = parseTitleFrontmatter(raw);
		if (frontmatter) {
			entries.push({ file, frontmatter });
		}
	}

	return entries;
}
