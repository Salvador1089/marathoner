import { unzipSync, strFromU8 } from "fflate";

/** Extracts every file in a zip archive into a filename -> text-content map. Binary/non-JSON entries decode as best-effort UTF-8 text; callers only read the .json ones. */
export async function unzipToTextFiles(file: File): Promise<Record<string, string>> {
	const buffer = new Uint8Array(await file.arrayBuffer());
	const entries = unzipSync(buffer);

	const files: Record<string, string> = {};
	for (const [path, data] of Object.entries(entries)) {
		if (path.endsWith("/")) continue; // directory entry
		const name = path.split("/").pop() ?? path;
		files[name] = strFromU8(data);
	}
	return files;
}
