export interface LogEntry {
	timestamp: string; // ISO datetime
	message: string;
}

/**
 * Kept bounded on purpose - an ever-growing log is exactly the kind of thing
 * that was making Library statistics unwieldy. Old entries just roll off the
 * end; this is a recent-activity feed, not a permanent audit trail.
 */
export const MAX_LOG_ENTRIES = 300;

/** Prepends a new entry (most-recent-first) and trims to MAX_LOG_ENTRIES, mutating the array in place. */
export function pushLogEntry(log: LogEntry[], message: string): void {
	log.unshift({ timestamp: new Date().toISOString(), message });
	if (log.length > MAX_LOG_ENTRIES) {
		log.length = MAX_LOG_ENTRIES;
	}
}
