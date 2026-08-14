// Subset of the TMDB response fields Marathoner actually consumes.
// This intentionally does not model the full TMDB response shape.

export interface TmdbSearchResult {
	id: number;
	media_type?: "movie" | "tv";
	title?: string; // movies
	name?: string; // TV shows
	release_date?: string; // movies
	first_air_date?: string; // TV shows
	poster_path: string | null;
	overview: string;
}

export interface TmdbSearchResponse {
	page: number;
	results: TmdbSearchResult[];
	total_pages: number;
	total_results: number;
}

/** Response shape of GET /find/{external_id} - movie_results items lack media_type (it's implied by the array). */
export interface TmdbFindResponse {
	movie_results: Omit<TmdbSearchResult, "media_type">[];
	tv_results: Omit<TmdbSearchResult, "media_type">[];
}

export interface TmdbCastMember {
	id: number;
	name: string;
	character: string;
	order: number;
}

export interface TmdbCrewMember {
	id: number;
	name: string;
	job: string;
	department: string;
}

export interface TmdbCredits {
	cast: TmdbCastMember[];
	crew: TmdbCrewMember[];
}

export interface TmdbExternalIds {
	imdb_id: string | null;
}

export interface TmdbVideo {
	key: string;
	site: string; // "YouTube" | "Vimeo" | ...
	type: string; // "Trailer" | "Teaser" | ...
	official: boolean;
}

export interface TmdbVideosResponse {
	results: TmdbVideo[];
}

export interface TmdbProductionCompany {
	id: number;
	name: string;
}

export interface TmdbNetwork {
	id: number;
	name: string;
}

export interface TmdbCreator {
	id: number;
	name: string;
}

export interface TmdbMovieDetails {
	id: number;
	title: string;
	overview: string;
	release_date: string;
	runtime: number | null;
	poster_path: string | null;
	genres: { id: number; name: string }[];
	vote_average: number;
	vote_count: number;
	production_companies: TmdbProductionCompany[];
	credits?: TmdbCredits;
	external_ids?: TmdbExternalIds;
	videos?: TmdbVideosResponse;
}

export interface TmdbNextEpisodeToAir {
	id: number;
	name: string;
	air_date: string;
	episode_number: number;
	season_number: number;
	runtime: number | null;
}

export interface TmdbTvDetails {
	id: number;
	name: string;
	overview: string;
	first_air_date: string;
	status: "Returning Series" | "Ended" | "Canceled" | "In Production" | "Planned" | "Pilot";
	poster_path: string | null;
	genres: { id: number; name: string }[];
	vote_average: number;
	vote_count: number;
	number_of_seasons: number;
	number_of_episodes: number;
	episode_run_time: number[];
	next_episode_to_air: TmdbNextEpisodeToAir | null;
	last_episode_to_air: TmdbNextEpisodeToAir | null;
	seasons: TmdbSeasonSummary[];
	networks: TmdbNetwork[];
	created_by: TmdbCreator[];
	credits?: TmdbCredits;
	external_ids?: TmdbExternalIds;
	videos?: TmdbVideosResponse;
}

export interface TmdbSeasonSummary {
	id: number;
	season_number: number;
	episode_count: number;
	name: string;
	air_date: string | null;
}

export interface TmdbEpisode {
	id: number;
	episode_number: number;
	season_number: number;
	name: string;
	overview: string;
	air_date: string | null;
	runtime: number | null;
}

export interface TmdbPersonDetails {
	id: number;
	name: string;
	biography: string;
	birthday: string | null;
	deathday: string | null;
	place_of_birth: string | null;
	profile_path: string | null;
	known_for_department: string | null;
	also_known_as: string[];
	gender?: number; // 0 = not specified, 1 = female, 2 = male, 3 = non-binary
	popularity?: number;
	external_ids?: TmdbExternalIds;
}

export interface TmdbCombinedCreditCast {
	id: number;
	media_type: "movie" | "tv";
	title?: string;
	name?: string;
	poster_path: string | null;
	release_date?: string;
	first_air_date?: string;
	character: string;
}

export interface TmdbCombinedCreditCrew {
	id: number;
	media_type: "movie" | "tv";
	title?: string;
	name?: string;
	poster_path: string | null;
	release_date?: string;
	first_air_date?: string;
	department: string;
	job: string;
}

export interface TmdbCombinedCredits {
	cast: TmdbCombinedCreditCast[];
	crew: TmdbCombinedCreditCrew[];
}

export interface TmdbSeasonDetails {
	id: number;
	season_number: number;
	name: string;
	episodes: TmdbEpisode[];
}
