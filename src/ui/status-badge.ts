import type { WatchStatus } from "../models/title";

const STATUS_LABELS: Record<WatchStatus, string> = {
	watching: "Watching",
	planned: "Planned",
	paused: "Paused",
	completed: "Completed",
	dropped: "Dropped",
};

/** Renders a colored status badge. Caller must position the wrapper as relative. */
export function renderStatusBadge(wrapper: HTMLElement, status: WatchStatus): void {
	wrapper.createDiv({
		cls: `marathoner-status-badge marathoner-status-badge-${status}`,
		text: STATUS_LABELS[status],
	});
}
