/**
 * A small, dependency-free CSV parser - Marathoner has no runtime
 * dependencies today, and every source we import from (Trakt, Letterboxd,
 * Simkl, IMDb) exports plain, well-formed CSV, so a full RFC-4180 tokenizer
 * (quoted fields, embedded commas/newlines, escaped quotes) is all that's
 * needed here.
 */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
	const table = tokenizeCsv(text);
	if (table.length === 0) return { headers: [], rows: [] };

	const headers = table[0].map((h) => h.trim());
	const rows = table.slice(1).map((cols) => {
		const row: Record<string, string> = {};
		headers.forEach((h, i) => {
			row[h] = (cols[i] ?? "").trim();
		});
		return row;
	});

	return { headers, rows };
}

function tokenizeCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

	for (let i = 0; i < normalized.length; i++) {
		const c = normalized[i];

		if (inQuotes) {
			if (c === '"') {
				if (normalized[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += c;
			}
			continue;
		}

		if (c === '"') {
			inQuotes = true;
		} else if (c === ",") {
			row.push(field);
			field = "";
		} else if (c === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += c;
		}
	}

	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	// Drop fully-blank trailing/interstitial lines (a single empty field).
	return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * Finds a header by trying exact (case-insensitive) matches first, then
 * falling back to "contains". Different export tools for the same service
 * often use slightly different header names (e.g. "tmdb" vs "tmdb_id" vs
 * "ids.tmdb") - this keeps parsers resilient to that instead of requiring
 * one exact, brittle header set.
 */
export function findColumn(headers: string[], ...candidates: string[]): string | null {
	const lower = headers.map((h) => h.toLowerCase());

	for (const candidate of candidates) {
		const idx = lower.findIndex((h) => h === candidate.toLowerCase());
		if (idx !== -1) return headers[idx];
	}
	for (const candidate of candidates) {
		const idx = lower.findIndex((h) => h.includes(candidate.toLowerCase()));
		if (idx !== -1) return headers[idx];
	}
	return null;
}

/** Clamps and rounds a rating to Marathoner's 0-10 integer scale. */
export function clampRating(value: number): number | null {
	if (!isFinite(value)) return null;
	return Math.max(0, Math.min(10, Math.round(value)));
}

/** Best-effort "whatever date format this source used" -> YYYY-MM-DD. */
export function normalizeDate(raw: string | undefined): string | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;

	const date = new Date(trimmed);
	if (isNaN(date.getTime())) return null;

	return date.toISOString().slice(0, 10);
}
