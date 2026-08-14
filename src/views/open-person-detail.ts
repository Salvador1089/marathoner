import { App, TFile } from "obsidian";
import { VIEW_TYPE_PERSON_DETAIL, PersonDetailView } from "./person-detail-view";
import { createOrOpenPersonNote, findExistingPersonNote, backfillPersonNoteIfIncomplete } from "../people";
import { TmdbClient } from "../tmdb/client";
import type { MarathonerSettings } from "../settings";
import { ConfirmModal } from "../ui/confirm-modal";

async function showInView(app: App, file: TFile): Promise<void> {
	const leaf = app.workspace.getLeaf(false);
	await leaf.setViewState({ type: VIEW_TYPE_PERSON_DETAIL, active: true });

	const view = leaf.view;
	if (view instanceof PersonDetailView) {
		await view.setFile(file);
	}

	app.workspace.revealLeaf(leaf);
}

/**
 * Opens a person's detail view, creating their note on the fly if it doesn't
 * exist yet. This works regardless of the "auto-create" settings toggles -
 * those only control bulk creation when adding/repairing titles. Clicking a
 * name should always be able to show the person.
 *
 * If neither auto-create toggle is on (the person hasn't opted into bulk
 * downloading), a confirmation is shown before fetching - a single click
 * shouldn't silently start hitting the network and writing a new note.
 */
export async function openPersonDetail(
	app: App,
	tmdb: TmdbClient,
	settings: MarathonerSettings,
	personTmdbId: number,
	personName?: string
): Promise<void> {
	const existing = findExistingPersonNote(app, personTmdbId);
	if (existing) {
		// Same top-up as when a title is added: an existing note might predate
		// filmography caching or tmdb_synced_at, and clicking a name shouldn't
		// require a manual Refresh just to see complete info.
		await backfillPersonNoteIfIncomplete(
			app,
			tmdb,
			existing,
			personTmdbId,
			settings.storeImagesLocally,
			settings.imagesFolder
		);
		await showInView(app, existing);
		return;
	}

	const autoCreateEnabled = settings.createDirectorNotes || settings.createCastNotes;

	if (autoCreateEnabled) {
		const file = await createOrOpenPersonNote(app, tmdb, settings.peopleFolder, personTmdbId, settings.storeImagesLocally, settings.imagesFolder);
		await showInView(app, file);
		return;
	}

	new ConfirmModal(
		app,
		"Download person info?",
		`Fetch biography, photo, and filmography for ${personName ?? "this person"} from TMDB and save it as a note?`,
		"Download",
		async () => {
			const file = await createOrOpenPersonNote(app, tmdb, settings.peopleFolder, personTmdbId, settings.storeImagesLocally, settings.imagesFolder);
			await showInView(app, file);
		}
	).open();
}
