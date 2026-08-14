import type { TitleFrontmatter } from "./models/title";
import { countWatchedEpisodes } from "./models/title";

export interface TitleStats {
	watchedMinutes: number;
	remainingMinutes: number;
	episodesWatched: number | null; // null for movies
	episodesTotal: number | null;
	progressPercent: number | null;
}

export function computeTitleStats(fm: TitleFrontmatter): TitleStats {
	if (fm.type === "movie") {
		const watchedMinutes = fm.status === "completed" && fm.runtime ? fm.runtime : 0;
		const remainingMinutes = fm.status !== "completed" && fm.runtime ? fm.runtime : 0;
		return {
			watchedMinutes,
			remainingMinutes,
			episodesWatched: null,
			episodesTotal: null,
			progressPercent: fm.status === "completed" ? 100 : 0,
		};
	}

	const watchedEpisodes = countWatchedEpisodes(fm.watched);
	const watchedMinutes = fm.runtime ? fm.runtime * watchedEpisodes : 0;

	let remainingMinutes = 0;
	if (fm.runtime && fm.total_episodes !== null) {
		remainingMinutes = fm.runtime * Math.max(0, fm.total_episodes - watchedEpisodes);
	}

	const progressPercent =
		fm.total_episodes && fm.total_episodes > 0 ? Math.round((watchedEpisodes / fm.total_episodes) * 100) : null;

	return {
		watchedMinutes,
		remainingMinutes,
		episodesWatched: watchedEpisodes,
		episodesTotal: fm.total_episodes,
		progressPercent,
	};
}
