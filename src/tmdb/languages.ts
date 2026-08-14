/**
 * A curated subset of TMDB-supported language codes (ISO 639-1 + region).
 * TMDB supports many more; this list covers the common cases for the
 * dropdown without overwhelming the settings UI.
 */
export const TMDB_LANGUAGES: { code: string; label: string }[] = [
	{ code: "en-US", label: "English (US)" },
	{ code: "en-GB", label: "English (UK)" },
	{ code: "pt-PT", label: "Portuguese (Portugal)" },
	{ code: "pt-BR", label: "Portuguese (Brazil)" },
	{ code: "es-ES", label: "Spanish (Spain)" },
	{ code: "fr-FR", label: "French (France)" },
	{ code: "de-DE", label: "German (Germany)" },
	{ code: "it-IT", label: "Italian (Italy)" },
	{ code: "nl-NL", label: "Dutch (Netherlands)" },
	{ code: "ja-JP", label: "Japanese (Japan)" },
];

export const DEFAULT_TMDB_LANGUAGE = "en-US";
