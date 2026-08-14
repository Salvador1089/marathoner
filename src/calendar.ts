/**
 * Deliberately the simplest possible calendar integration: no OAuth, no
 * account, no server. A "quick add" link just opens Google Calendar's own
 * add-event page pre-filled - the person still clicks "Save" there
 * themselves. Good enough for "remind me when this airs"; it does NOT keep
 * itself in sync if a date later changes (a real sync would need Google API
 * auth, which is a much bigger, more fragile thing to bolt onto a local
 * Obsidian plugin for comparatively little benefit).
 */
export function buildGoogleCalendarUrl(title: string, details: string, dateIso: string): string {
	const start = dateIso.replace(/-/g, "");
	const end = shiftDateIso(dateIso, 1).replace(/-/g, "");
	const params = new URLSearchParams({
		action: "TEMPLATE",
		text: title,
		dates: `${start}/${end}`,
		details,
	});
	return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export interface IcsEvent {
	uid: string;
	title: string;
	description: string;
	dateIso: string; // all-day event date
}

/**
 * Builds a minimal, valid .ics file with one all-day VEVENT per entry - the
 * "add several episodes at once" path. A single Google Calendar link can
 * only ever add one event, so batch adds go through a standard calendar
 * file instead: Google Calendar, Apple Calendar, and Outlook can all import
 * one directly.
 */
export function buildIcsFile(events: IcsEvent[]): string {
	const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Marathoner//Obsidian Plugin//EN", "CALSCALE:GREGORIAN"];

	for (const event of events) {
		const start = event.dateIso.replace(/-/g, "");
		const end = shiftDateIso(event.dateIso, 1).replace(/-/g, "");
		lines.push(
			"BEGIN:VEVENT",
			`UID:${event.uid}`,
			`DTSTAMP:${icsTimestamp()}`,
			`DTSTART;VALUE=DATE:${start}`,
			`DTEND;VALUE=DATE:${end}`,
			`SUMMARY:${escapeIcsText(event.title)}`,
			`DESCRIPTION:${escapeIcsText(event.description)}`,
			"END:VEVENT"
		);
	}

	lines.push("END:VCALENDAR");
	// .ics requires CRLF line endings.
	return lines.join("\r\n");
}

/** Triggers a browser-style file download - works fine inside Obsidian's Electron webview, same as any other web page. */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

function shiftDateIso(dateIso: string, days: number): string {
	const date = new Date(dateIso + "T00:00:00");
	date.setDate(date.getDate() + days);
	return date.toISOString().slice(0, 10);
}

function icsTimestamp(): string {
	return new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeIcsText(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
