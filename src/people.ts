import { App, TFile, normalizePath } from "obsidian";
import { ensureFolderExists, migrateFileToFolder, waitForMetadataRefresh } from "./vault-helpers";
import { ensureImageCached } from "./image-cache";
import { extractSection, writeMarkdownSection, getLibraryEntries } from "./notes";
import type { MarathonerSettings } from "./settings";

/** The minimal shape ensurePersonNotesForTitle actually needs - satisfied by
 *  the full MarathonerSettings, but also by leaner option objects like
 *  RepairOptions, without forcing an unrelated full-settings dependency. */
export type PersonNoteSettings = Pick<
	MarathonerSettings,
	"peopleFolder" | "createDirectorNotes" | "createCastNotes" | "storeImagesLocally" | "imagesFolder"
>;
import { createDefaultPersonFrontmatter, PersonEnrichment, PersonFrontmatter, PERSON_SCHEMA_VERSION } from "./models/person";
import { TmdbClient } from "./tmdb/client";
import { enrichmentFromPerson } from "./tmdb/enrichment";
import type { TmdbCombinedCredits } from "./tmdb/types";

/** Looks up a person note by tmdb_id across the whole vault. Identity, not the filename. */
export function findExistingPersonNote(app: App, tmdbId: number): TFile | null {
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm && fm.marathoner_person_id === tmdbId) {
			return file;
		}
	}
	return null;
}

/**
 * Deletes (moves to trash) any person note that's no longer referenced as a
 * director or cast member by anything left in the library. Meant to run
 * right after a title is deleted, so directors/cast exclusive to that title
 * don't linger forever as orphaned notes nobody links to anymore. A person
 * who appears in more than one title is left alone as long as at least one
 * of those titles remains.
 */
export async function pruneOrphanedPersonNotes(app: App, libraryFolder: string, peopleFolder: string): Promise<number> {
	const referenced = new Set<number>();
	for (const { frontmatter } of getLibraryEntries(app, libraryFolder)) {
		frontmatter.director_ids.forEach((id) => referenced.add(id));
		frontmatter.cast_ids.forEach((id) => referenced.add(id));
	}

	const folder = resolvePersonFolder(peopleFolder);
	let removed = 0;

	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.parent?.path.startsWith(folder)) continue;

		const raw = app.metadataCache.getFileCache(file)?.frontmatter;
		const fm = parsePersonFrontmatter(raw);
		if (!fm || referenced.has(fm.tmdb_id)) continue;

		await app.fileManager.trashFile(file);
		removed++;
	}

	return removed;
}

/** All person notes live in one folder - a person can be a director on one
 *  title and cast on another, so splitting by role would be an artificial,
 *  shifting categorization rather than a stable one. */
export function resolvePersonFolder(peopleFolder: string): string {
	return peopleFolder.replace(/\/+$/, "");
}

const INVALID_FILENAME_CHARS = /[/\\*?"<>|]/g;

function sanitizeFilenamePart(part: string): string {
	return part
		.replace(/:/g, " -")
		.replace(INVALID_FILENAME_CHARS, "")
		.replace(/\s+/g, " ")
		.trim();
}

async function resolveUniquePersonPath(app: App, folder: string, name: string, tmdbId: number): Promise<string> {
	const safeName = sanitizeFilenamePart(name) || `person-${tmdbId}`;
	const candidate = normalizePath(`${folder}/${safeName}.md`);
	if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
	return normalizePath(`${folder}/${safeName} - ${tmdbId}.md`);
}

function yamlString(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}

function yamlNullableString(value: string | null): string {
	return value === null ? "null" : yamlString(value);
}

function yamlStringList(values: string[]): string {
	if (values.length === 0) return "[]";
	return `[${values.map(yamlString).join(", ")}]`;
}

function renderPersonNoteContent(fm: PersonFrontmatter, biography: string): string {
	const yaml = [
		"---",
		`schema_version: ${fm.schema_version}`,
		`marathoner_person_id: ${fm.tmdb_id}`,
		`name: ${yamlString(fm.name)}`,
		`birthday: ${fm.birthday ?? "null"}`,
		`deathday: ${fm.deathday ?? "null"}`,
		`place_of_birth: ${yamlNullableString(fm.place_of_birth)}`,
		`profile_path: ${yamlNullableString(fm.profile_path)}`,
		`known_for_department: ${yamlNullableString(fm.known_for_department)}`,
		`also_known_as: ${yamlStringList(fm.also_known_as)}`,
		`gender: ${yamlNullableString(fm.gender)}`,
		`imdb_url: ${yamlNullableString(fm.imdb_url)}`,
		`date_added: ${fm.date_added}`,
		`tmdb_synced_at: ${fm.tmdb_synced_at ? yamlString(fm.tmdb_synced_at) : "null"}`,
		"---",
		"",
		"## Biography",
		"",
		biography || "_No biography available on TMDB._",
		"",
	];
	return yaml.join("\n");
}

/**
 * Creates the person note if it doesn't exist yet (fetching from TMDB), or
 * returns the existing one without any network call. Identity is tmdb_id,
 * same principle as title notes - the filename is cosmetic only.
 */
export async function createOrOpenPersonNote(
	app: App,
	tmdb: TmdbClient,
	peopleFolder: string,
	tmdbId: number,
	storeImagesLocally: boolean,
	imagesFolder: string
): Promise<TFile> {
	const existing = findExistingPersonNote(app, tmdbId);
	if (existing) {
		// The note might predate this version of the plugin (no cached
		// filmography/tmdb_synced_at yet) - top it up now instead of leaving it
		// incomplete until someone happens to open it and hit Refresh manually.
		await backfillPersonNoteIfIncomplete(app, tmdb, existing, tmdbId, storeImagesLocally, imagesFolder);
		return existing;
	}

	const details = await tmdb.getPerson(tmdbId);
	const enrichment: PersonEnrichment = enrichmentFromPerson(details);

	const targetFolder = resolvePersonFolder(peopleFolder);
	await ensureFolderExists(app.vault, targetFolder);
	const path = await resolveUniquePersonPath(app, targetFolder, enrichment.name, tmdbId);
	const frontmatter = createDefaultPersonFrontmatter(tmdbId, enrichment);
	const content = renderPersonNoteContent(frontmatter, enrichment.biography);

	const file = await app.vault.create(path, content);
	await waitForFrontmatterIndexed(app, file);
	await ensureImageCached(app, storeImagesLocally, imagesFolder, "person", tmdbId, enrichment.profilePath);

	// Cache filmography too, so the person note is fully usable offline right
	// after creation - the same "cache everything up front" principle already
	// used for TV episodes. A failure here shouldn't block note creation; it
	// just means filmography stays empty until the next refresh.
	try {
		const credits = await tmdb.getPersonCombinedCredits(tmdbId);
		await writeFilmographyCache(app, file, credits);
	} catch {
		// Ignored - see comment above.
	}

	return file;
}

/**
 * Tops up a pre-existing person note that's missing data this version of the
 * plugin expects to have cached (filmography, tmdb_synced_at) - e.g. a note
 * created before either feature existed. No-op, and cheap, if it's already
 * complete. Failures are swallowed: the note stays exactly as good as it
 * was, and the manual Refresh button on the Person detail view remains
 * available as a fallback.
 */
export async function backfillPersonNoteIfIncomplete(
	app: App,
	tmdb: TmdbClient,
	file: TFile,
	tmdbId: number,
	storeImagesLocally: boolean,
	imagesFolder: string
): Promise<void> {
	const raw = app.metadataCache.getFileCache(file)?.frontmatter;
	const fm = parsePersonFrontmatter(raw);
	const hasFilmography = (await readFilmographyCache(app, file)) !== null;

	if (fm?.tmdb_synced_at && hasFilmography) return;

	try {
		await refreshOnePerson(app, tmdb, file, tmdbId, storeImagesLocally, imagesFolder);
	} catch {
		// Ignored - see comment above.
	}
}

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

/** Defensive parse, same principle as parseTitleFrontmatter - notes can be hand-edited. */
export function parsePersonFrontmatter(raw: Record<string, unknown> | undefined): PersonFrontmatter | null {
	if (!raw || typeof raw.marathoner_person_id !== "number") return null;

	return {
		schema_version: typeof raw.schema_version === "number" ? raw.schema_version : 1,
		tmdb_id: raw.marathoner_person_id,
		name: typeof raw.name === "string" ? raw.name : "Unknown",
		birthday: typeof raw.birthday === "string" ? raw.birthday : null,
		deathday: typeof raw.deathday === "string" ? raw.deathday : null,
		place_of_birth: typeof raw.place_of_birth === "string" ? raw.place_of_birth : null,
		profile_path: typeof raw.profile_path === "string" ? raw.profile_path : null,
		known_for_department: typeof raw.known_for_department === "string" ? raw.known_for_department : null,
		also_known_as: Array.isArray(raw.also_known_as) ? raw.also_known_as.filter((v): v is string => typeof v === "string") : [],
		gender: typeof raw.gender === "string" ? raw.gender : null,
		imdb_url: typeof raw.imdb_url === "string" ? raw.imdb_url : null,
		date_added: typeof raw.date_added === "string" ? raw.date_added : "",
		tmdb_synced_at: typeof raw.tmdb_synced_at === "string" ? raw.tmdb_synced_at : null,
	};
}

const BIOGRAPHY_HEADING = "## Biography";
const FILMOGRAPHY_HEADING = "## Filmography";

/** Reads the biography text (static TMDB content, not user-edited) from a person note's body. */
export async function readBiography(app: App, file: TFile): Promise<string> {
	const content = await app.vault.read(file);
	const section = extractSection(content, BIOGRAPHY_HEADING);
	return section ? section.body.trim() : "";
}

/** Overwrites the biography section, e.g. after a manual/automatic refresh. */
export async function writeBiography(app: App, file: TFile, biography: string): Promise<void> {
	await writeMarkdownSection(app, file, BIOGRAPHY_HEADING, biography || "_No biography available on TMDB._");
}

/** Reads the cached filmography (raw TMDB combined credits) written at creation or refresh. */
export async function readFilmographyCache(app: App, file: TFile): Promise<TmdbCombinedCredits | null> {
	const content = await app.vault.read(file);
	const section = extractSection(content, FILMOGRAPHY_HEADING);
	if (!section) return null;

	const jsonMatch = section.body.match(/```json\n([\s\S]*?)\n```/);
	if (!jsonMatch) return null;

	try {
		const parsed = JSON.parse(jsonMatch[1]);
		return parsed && Array.isArray(parsed.cast) && Array.isArray(parsed.crew) ? parsed : null;
	} catch {
		return null;
	}
}

/** Caches the full combined-credits payload as JSON under "## Filmography", placed after Biography. */
export async function writeFilmographyCache(app: App, file: TFile, credits: TmdbCombinedCredits): Promise<void> {
	await writeMarkdownSection(app, file, FILMOGRAPHY_HEADING, `\`\`\`json\n${JSON.stringify(credits)}\n\`\`\``);
}

/**
 * Re-fetches a single person's biography, facts, photo, and filmography from
 * TMDB and writes them back - the per-note counterpart to the title refresh
 * in repair.ts. Used both by the "Refresh" button on a person note and by the
 * full-library bulk refresh.
 */
export async function refreshOnePerson(
	app: App,
	tmdb: TmdbClient,
	file: TFile,
	tmdbId: number,
	storeImagesLocally: boolean,
	imagesFolder: string
): Promise<void> {
	const details = await tmdb.getPerson(tmdbId);
	const enrichment = enrichmentFromPerson(details);
	const credits = await tmdb.getPersonCombinedCredits(tmdbId);

	await app.fileManager.processFrontMatter(file, (fm) => {
		fm.schema_version = PERSON_SCHEMA_VERSION;
		fm.name = enrichment.name;
		fm.birthday = enrichment.birthday;
		fm.deathday = enrichment.deathday;
		fm.place_of_birth = enrichment.placeOfBirth;
		fm.profile_path = enrichment.profilePath;
		fm.known_for_department = enrichment.knownForDepartment;
		fm.also_known_as = enrichment.alsoKnownAs;
		fm.gender = enrichment.gender;
		fm.imdb_url = enrichment.imdbUrl;
		fm.tmdb_synced_at = new Date().toISOString();
	});

	// The caller (Person detail view) re-reads frontmatter from metadataCache
	// right after this resolves, to re-render - wait for the cache to actually
	// catch up first, or it can briefly see stale/missing frontmatter and show
	// a false "malformed note" error.
	await waitForMetadataRefresh(app, file);

	await writeBiography(app, file, enrichment.biography);
	await writeFilmographyCache(app, file, credits);
	await ensureImageCached(app, storeImagesLocally, imagesFolder, "person", tmdbId, enrichment.profilePath);
}

export interface PersonAppearance {
	file: TFile;
	title: string;
	posterPath: string | null;
	year: string | null;
}

/**
 * Scans the whole library for titles this person appears in (as director or
 * cast), computed dynamically so it never goes stale as new titles are added.
 */
export function findPersonAppearances(app: App, libraryFolder: string, personTmdbId: number): PersonAppearance[] {
	const results: PersonAppearance[] = [];
	const normalizedFolder = libraryFolder.replace(/^\/+|\/+$/g, "");

	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(normalizedFolder + "/")) continue;

		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;

		const directorIds: unknown = fm.director_ids;
		const castIds: unknown = fm.cast_ids;
		const isDirector = Array.isArray(directorIds) && directorIds.includes(personTmdbId);
		const isCast = Array.isArray(castIds) && castIds.includes(personTmdbId);

		if (isDirector || isCast) {
			results.push({
				file,
				title: typeof fm.title === "string" ? fm.title : file.basename,
				posterPath: typeof fm.poster_path === "string" ? fm.poster_path : null,
				year: fm.year ? String(fm.year) : null,
			});
		}
	}

	return results.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Moves any existing person note that isn't in its correct Directors/Cast
 * subfolder there. Run as part of Repair, not on every single lookup - this
 * is a whole-vault sweep, not a per-title operation.
 */
export async function migratePersonNotes(app: App, peopleFolder: string): Promise<number> {
	let moved = 0;

	for (const file of app.vault.getMarkdownFiles()) {
		const raw = app.metadataCache.getFileCache(file)?.frontmatter;
		const fm = parsePersonFrontmatter(raw);
		if (!fm) continue;

		const targetFolder = resolvePersonFolder(peopleFolder);
		const before = file.parent?.path ?? "";
		if (before === targetFolder) continue;

		await migrateFileToFolder(app, file, targetFolder);
		moved++;
	}

	return moved;
}

/**
 * Downloads photos for existing person notes that don't have one cached yet.
 * Complements createOrOpenPersonNote, which only fetches an image when the
 * note is first created - this covers people who already had a note before
 * "Store images locally" was turned on.
 */
export async function backfillPersonImages(
	app: App,
	peopleFolder: string,
	storeImagesLocally: boolean,
	imagesFolder: string
): Promise<void> {
	if (!storeImagesLocally) return;

	for (const file of app.vault.getMarkdownFiles()) {
		const raw = app.metadataCache.getFileCache(file)?.frontmatter;
		const fm = parsePersonFrontmatter(raw);
		if (!fm || !fm.profile_path) continue;
		if (!file.parent?.path.startsWith(resolvePersonFolder(peopleFolder))) continue;

		await ensureImageCached(app, storeImagesLocally, imagesFolder, "person", fm.tmdb_id, fm.profile_path);
	}
}

export async function ensurePersonNotesForTitle(
	app: App,
	tmdb: TmdbClient,
	settings: PersonNoteSettings,
	directorIds: number[],
	castIds: number[]
): Promise<void> {
	const ids = new Set<number>();
	if (settings.createDirectorNotes) directorIds.forEach((id) => ids.add(id));
	if (settings.createCastNotes) castIds.forEach((id) => ids.add(id));

	for (const id of ids) {
		try {
			await createOrOpenPersonNote(
				app,
				tmdb,
				settings.peopleFolder,
				id,
				settings.storeImagesLocally,
				settings.imagesFolder
			);
		} catch {
			// A single person failing (transient network, deleted TMDB id) shouldn't block the rest.
		}
	}
}
