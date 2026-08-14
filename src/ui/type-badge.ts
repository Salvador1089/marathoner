import type { MediaType } from "../models/title";

/** Renders a small "Movie" / "TV Show" badge. Caller must position the wrapper as relative. */
export function renderTypeBadge(wrapper: HTMLElement, type: MediaType): void {
	wrapper.createDiv({
		cls: `marathoner-type-badge marathoner-type-badge-${type}`,
		text: type === "movie" ? "Movie" : "TV Show",
	});
}

/** Inline (non-overlay) variant, for use below a poster instead of on top of it.
 *  Colored text only, no fill - distinct from renderTypeBadge's solid pill. */
export function renderTypeChip(container: HTMLElement, type: MediaType): void {
	container.createSpan({
		cls: `marathoner-type-chip marathoner-type-chip-${type}`,
		text: type === "movie" ? "Movie" : "TV Show",
	});
}
