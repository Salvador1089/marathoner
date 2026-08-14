import type { TmdbMovieDetails, TmdbTvDetails, TmdbCredits, TmdbVideosResponse, TmdbPersonDetails } from "./types";
import type { TitleEnrichment } from "../models/title";
import type { PersonEnrichment } from "../models/person";

const MAX_CAST = 10;

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

function extractCast(credits: TmdbCredits | undefined): { names: string[]; ids: number[] } {
	if (!credits) return { names: [], ids: [] };
	const sorted = [...credits.cast].sort((a, b) => a.order - b.order).slice(0, MAX_CAST);
	return { names: sorted.map((c) => c.name), ids: sorted.map((c) => c.id) };
}

function extractTrailerUrl(videos: TmdbVideosResponse | undefined): string | null {
	if (!videos) return null;
	const trailer =
		videos.results.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official) ??
		videos.results.find((v) => v.site === "YouTube" && v.type === "Trailer");
	return trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null;
}

export function enrichmentFromMovie(details: TmdbMovieDetails): TitleEnrichment {
	const directors = (details.credits?.crew ?? []).filter((c) => c.job === "Director");
	const cast = extractCast(details.credits);

	return {
		title: details.title,
		year: details.release_date ? details.release_date.slice(0, 4) : null,
		posterPath: details.poster_path,
		overview: details.overview || null,
		releaseDate: details.release_date || null,
		lastEpisodeAirDate: null,
		nextEpisodeAirDate: null,
		nextEpisodeLabel: null,
		nextEpisodeSeason: null,
		nextEpisodeNumber: null,
		director: directors.map((c) => c.name),
		directorIds: directors.map((c) => c.id),
		cast: cast.names,
		castIds: cast.ids,
		studio: details.production_companies.map((c) => c.name),
		runtime: details.runtime,
		totalEpisodes: null,
		communityRating: details.vote_average,
		communityVotes: details.vote_count,
		trailerUrl: extractTrailerUrl(details.videos),
		imdbUrl: details.external_ids?.imdb_id ? `https://www.imdb.com/title/${details.external_ids.imdb_id}` : null,
	};
}

export function enrichmentFromTv(details: TmdbTvDetails): TitleEnrichment {
	// episode_run_time at series level is deprecated by TMDB and is often empty
	// unless every episode has the exact same duration. Fall back to the runtime
	// on the most recently aired (or next) episode, which is populated per-episode.
	const runtime =
		details.episode_run_time[0] ?? details.last_episode_to_air?.runtime ?? details.next_episode_to_air?.runtime ?? null;
	const cast = extractCast(details.credits);
	const next = details.next_episode_to_air;

	// details.number_of_episodes from TMDB includes "Season 0: Specials", which
	// the UI deliberately never shows for marking watched. Using that raw total
	// would make 100% completion mathematically impossible for shows with
	// specials. Sum only the seasons actually trackable in the UI instead.
	const totalEpisodes = details.seasons
		.filter((s) => s.season_number !== 0)
		.reduce((sum, s) => sum + s.episode_count, 0);

	return {
		title: details.name,
		year: details.first_air_date ? details.first_air_date.slice(0, 4) : null,
		posterPath: details.poster_path,
		overview: details.overview || null,
		releaseDate: null,
		lastEpisodeAirDate: details.last_episode_to_air?.air_date || null,
		nextEpisodeAirDate: next?.air_date || null,
		nextEpisodeLabel: next ? `S${pad2(next.season_number)}E${pad2(next.episode_number)} - ${next.name}` : null,
		nextEpisodeSeason: next?.season_number ?? null,
		nextEpisodeNumber: next?.episode_number ?? null,
		director: details.created_by.map((c) => c.name), // "director" here means the show's creator(s)
		directorIds: details.created_by.map((c) => c.id),
		cast: cast.names,
		castIds: cast.ids,
		studio: details.networks.map((n) => n.name),
		runtime,
		totalEpisodes,
		communityRating: details.vote_average,
		communityVotes: details.vote_count,
		trailerUrl: extractTrailerUrl(details.videos),
		imdbUrl: details.external_ids?.imdb_id ? `https://www.imdb.com/title/${details.external_ids.imdb_id}` : null,
	};
}

export function enrichmentFromPerson(details: TmdbPersonDetails): PersonEnrichment {
	return {
		name: details.name,
		birthday: details.birthday,
		deathday: details.deathday,
		placeOfBirth: details.place_of_birth,
		profilePath: details.profile_path,
		knownForDepartment: details.known_for_department,
		alsoKnownAs: details.also_known_as,
		gender: genderLabel(details.gender),
		imdbUrl: details.external_ids?.imdb_id ? `https://www.imdb.com/name/${details.external_ids.imdb_id}` : null,
		biography: details.biography,
	};
}

function genderLabel(gender: number | undefined): string | null {
	switch (gender) {
		case 1:
			return "Female";
		case 2:
			return "Male";
		case 3:
			return "Non-binary";
		default:
			return null; // 0 or missing - TMDB has no data for this person
	}
}
