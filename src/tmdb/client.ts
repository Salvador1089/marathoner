import { requestUrl } from "obsidian";
import type {
	TmdbSearchResponse,
	TmdbFindResponse,
	TmdbMovieDetails,
	TmdbTvDetails,
	TmdbSeasonDetails,
	TmdbPersonDetails,
	TmdbCombinedCredits,
} from "./types";

const BASE_URL = "https://api.themoviedb.org/3";

export class TmdbClient {
	constructor(
		private apiKey: string,
		private language: string = "en-US"
	) {}

	private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
		if (!this.apiKey) {
			throw new Error("TMDB API key is not configured. Set it in Settings > Marathoner.");
		}

		const query = new URLSearchParams({
			language: this.language,
			...params,
		}).toString();

		const response = await requestUrl({
			url: `${BASE_URL}${path}?${query}`,
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
		});

		if (response.status !== 200) {
			throw new Error(`TMDB request failed (${response.status}): ${path}`);
		}

		return response.json as T;
	}

	/** Multi search across movies and TV shows. */
	async search(query: string): Promise<TmdbSearchResponse> {
		return this.get<TmdbSearchResponse>("/search/multi", { query });
	}

	/** Resolves an external id (typically an IMDb id, "tt1234567") to TMDB movie/TV results. Used by the import-from-other-apps flow. */
	async findByExternalId(externalId: string, source: "imdb_id" = "imdb_id"): Promise<TmdbFindResponse> {
		return this.get<TmdbFindResponse>(`/find/${externalId}`, { external_source: source });
	}

	async getMovie(id: number): Promise<TmdbMovieDetails> {
		return this.get<TmdbMovieDetails>(`/movie/${id}`, {
			append_to_response: "credits,external_ids,videos",
		});
	}

	async getTvShow(id: number): Promise<TmdbTvDetails> {
		return this.get<TmdbTvDetails>(`/tv/${id}`, {
			append_to_response: "credits,external_ids,videos",
		});
	}

	async getSeason(tvId: number, seasonNumber: number): Promise<TmdbSeasonDetails> {
		return this.get<TmdbSeasonDetails>(`/tv/${tvId}/season/${seasonNumber}`);
	}

	async getPerson(id: number): Promise<TmdbPersonDetails> {
		return this.get<TmdbPersonDetails>(`/person/${id}`, { append_to_response: "external_ids" });
	}

	async getPersonCombinedCredits(id: number): Promise<TmdbCombinedCredits> {
		return this.get<TmdbCombinedCredits>(`/person/${id}/combined_credits`);
	}

	/** Verifies the configured API key. Used by the settings "Test" button. */
	async testConnection(): Promise<boolean> {
		try {
			await this.get("/configuration");
			return true;
		} catch {
			return false;
		}
	}

	static posterUrl(posterPath: string | null, size: "w200" | "w342" | "w500" = "w342"): string | null {
		if (!posterPath) return null;
		return `https://image.tmdb.org/t/p/${size}${posterPath}`;
	}
}
