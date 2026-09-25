/** Version stored with every chunk so chunking changes create a new projection. */
export const SEMANTIC_CHUNKER_VERSION = "structure-overlap-v1";
export const SEMANTIC_CHUNK_MAX_CHARS = 1_800;
export const SEMANTIC_CHUNK_OVERLAP_CHARS = 180;
export const SEMANTIC_CREDIT_CHARS = 1_000;

export function normalizeSemanticProjection(item: {
	title?: string | null;
	body?: string | null;
	articleText?: string | null;
}): string {
	return normalizeSemanticText([item.title, item.body, item.articleText]);
}

export interface SemanticTextChunk {
	index: number;
	text: string;
	startOffset: number;
	endOffset: number;
}

/** The hosted/local semantic projection deliberately excludes raw payload and metadata. */
export function normalizeSemanticText(parts: Array<string | null | undefined>): string {
	return parts
		.filter((part): part is string => Boolean(part?.trim()))
		.map((part) => part.replace(/\r\n?/g, "\n"))
		.join("\n\n")
	.split(/\n{2,}/)
	.map((paragraph) =>
		paragraph
			.split("\n")
			.map((line) => line.replace(/[\t ]+/g, " ").trim())
			.join("\n")
			.trim(),
	)
	.filter(Boolean)
	.join("\n\n")
	.trim();
}

function lastBoundary(text: string, start: number, end: number): number {
	const window = text.slice(start, end);
	const minimum = Math.floor(window.length * 0.55);
	const paragraph = window.lastIndexOf("\n\n");
	if (paragraph >= minimum) return start + paragraph;

	let sentence = -1;
	for (const match of window.matchAll(/[.!?][\"'”’)]*\s+/g)) {
		const position = match.index ?? -1;
		if (position >= minimum) sentence = position + match[0].length;
	}
	if (sentence >= 0) return start + sentence;

	const line = window.lastIndexOf("\n");
	if (line >= minimum) return start + line + 1;
	const space = window.lastIndexOf(" ");
	if (space >= minimum) return start + space;
	return end;
}

/**
 * Split normalized user-visible text on paragraph/sentence boundaries where
 * possible, with a hard character cap and a small overlap for boundary context.
 */
export function chunkSemanticText(value: string): SemanticTextChunk[] {
	const text = normalizeSemanticText([value]);
	const chunks: SemanticTextChunk[] = [];
	let start = 0;

	while (start < text.length) {
		const hardEnd = Math.min(start + SEMANTIC_CHUNK_MAX_CHARS, text.length);
		const end = hardEnd < text.length ? lastBoundary(text, start, hardEnd) : hardEnd;
		const raw = text.slice(start, end);
		const leading = raw.length - raw.trimStart().length;
		const chunkText = raw.trim();
		if (chunkText) {
			const chunkStart = start + leading;
			chunks.push({
				index: chunks.length,
				text: chunkText,
				startOffset: chunkStart,
				endOffset: chunkStart + chunkText.length,
			});
		}
		if (end >= text.length) break;
		const nextStart = Math.max(start + 1, end - SEMANTIC_CHUNK_OVERLAP_CHARS);
		start = nextStart;
		while (start < text.length && /\s/.test(text[start]!)) start += 1;
	}

	return chunks;
}

/** Count app-defined workload credits; this is not a provider invoice estimate. */
export function semanticCreditsForText(value: string): number {
	return Math.max(1, Math.ceil(value.length / SEMANTIC_CREDIT_CHARS));
}
