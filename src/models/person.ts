export const PERSON_SCHEMA_VERSION = 3;

export interface PersonFrontmatter {
	schema_version: number;
	tmdb_id: number;
	name: string;
	birthday: string | null;
	deathday: string | null;
	place_of_birth: string | null;
	profile_path: string | null;
	known_for_department: string | null;
	also_known_as: string[];
	gender: string | null;
	imdb_url: string | null;
	date_added: string;
	tmdb_synced_at: string | null; // ISO datetime of the last successful TMDB fetch for this note
}

export interface PersonEnrichment {
	name: string;
	birthday: string | null;
	deathday: string | null;
	placeOfBirth: string | null;
	profilePath: string | null;
	knownForDepartment: string | null;
	alsoKnownAs: string[];
	gender: string | null;
	imdbUrl: string | null;
	biography: string;
}

export function createDefaultPersonFrontmatter(tmdbId: number, enrichment: PersonEnrichment): PersonFrontmatter {
	return {
		schema_version: PERSON_SCHEMA_VERSION,
		tmdb_id: tmdbId,
		name: enrichment.name,
		birthday: enrichment.birthday,
		deathday: enrichment.deathday,
		place_of_birth: enrichment.placeOfBirth,
		profile_path: enrichment.profilePath,
		known_for_department: enrichment.knownForDepartment,
		also_known_as: enrichment.alsoKnownAs,
		gender: enrichment.gender,
		imdb_url: enrichment.imdbUrl,
		date_added: new Date().toISOString().slice(0, 10),
		tmdb_synced_at: new Date().toISOString(),
	};
}
