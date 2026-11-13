import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, type AiSettingsResponse, type ExtensionHealth } from "./api.ts";

/**
 * What the app frame watches on every page: the extension's connection and
 * any background work (an import, AI tagging, the search index).
 *
 * Both poll slowly while nothing is happening and quickly while something is,
 * and neither polls a hidden tab. A failed request leaves the frame quiet
 * rather than showing an error; the pages that own these areas report them.
 */
export const frameKeys = {
	extension: ["frame", "extension"] as const,
	ai: ["frame", "ai"] as const,
};

function importing(extension: ExtensionHealth | null | undefined): boolean {
	return Object.values(extension?.sources ?? {}).some((runtime) => runtime?.phase === "running");
}

export function useExtensionHealth() {
	const query = useQuery({
		queryKey: frameKeys.extension,
		queryFn: ({ signal }) => api.sources(signal).then((result) => result.extension),
		refetchInterval: (state) => (importing(state.state.data) ? 5_000 : 30_000),
		refetchIntervalInBackground: false,
		retry: 1,
		staleTime: 4_000,
	});
	const { refetch } = query;
	useEffect(() => {
		const update = () => void refetch();
		window.addEventListener("anansi-connection-updated", update);
		return () => window.removeEventListener("anansi-connection-updated", update);
	}, [refetch]);
	return query;
}

export function useAiBacklog() {
	return useQuery({
		queryKey: frameKeys.ai,
		queryFn: ({ signal }) => api.ai(signal),
		refetchInterval: (state) => (aiJobs(state.state.data).length > 0 ? 8_000 : 60_000),
		refetchIntervalInBackground: false,
		retry: 1,
		staleTime: 4_000,
	});
}

export interface BackgroundJob {
	id: "import" | "tagging" | "indexing";
	/** Sentence-case, present tense, without the trailing ellipsis. */
	label: string;
	/** What the job is and where its detail lives, for the info tooltip. */
	detail: string;
	/** Where the detail lives. */
	href: "/sources" | "/settings";
	hash?: string;
}

const PLATFORM: Record<string, string> = { x: "X", github: "GitHub", reddit: "Reddit", tiktok: "TikTok", web: "web" };

function count(n: number): string {
	return n.toLocaleString("en-GB");
}

function list(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function importJobs(extension: ExtensionHealth | null | undefined): BackgroundJob[] {
	if (!extension || extension.connection !== "connected") return [];
	const running = Object.entries(extension.sources ?? {}).filter(([, runtime]) => runtime?.phase === "running");
	if (running.length === 0) return [];
	const names = running.map(([source]) => PLATFORM[source] ?? source);
	const waiting = running.reduce((sum, [, runtime]) => sum + (runtime?.queued ?? 0) + (runtime?.uploading ?? 0), 0);
	return [{
		id: "import",
		label: waiting > 0 ? `Importing ${count(waiting)} ${names.length === 1 ? `${names[0]} ` : ""}${waiting === 1 ? "save" : "saves"}` : `Importing from ${list(names)}`,
		detail: "The extension is sending your history in the background. Sources shows each platform",
		href: "/sources",
	}];
}

export function aiJobs(ai: AiSettingsResponse | null | undefined): BackgroundJob[] {
	if (!ai?.available) return [];
	const jobs: BackgroundJob[] = [];
	const tagging = ai.taggingProgress.pending;
	if (ai.settings.autoTaggingEnabled === 1 && ai.capabilities?.autoTagging !== false && tagging > 0) {
		jobs.push({
			id: "tagging",
			label: `Tagging ${count(tagging)} ${tagging === 1 ? "save" : "saves"}`,
			detail: "New saves are filed under topics in the background. Your own tags are never changed",
			href: "/settings",
			hash: "ai",
		});
	}
	const indexing = ai.semanticIndex.pending;
	if (ai.settings.semanticSearchEnabled === 1 && ai.settings.semanticIndexPaused !== 1 && ai.capabilities?.semanticSearch !== false && indexing > 0) {
		jobs.push({
			id: "indexing",
			label: `Indexing ${count(indexing)} ${indexing === 1 ? "save" : "saves"} for search`,
			detail: "Search by meaning covers each save once it is indexed. Keyword search works meanwhile",
			href: "/settings",
			hash: "ai",
		});
	}
	return jobs;
}

/** Extension tooltip copy: what the dot means, with the version when connected. */
export function extensionTitle(extension: ExtensionHealth | null | undefined, fallback: string): string {
	if (extension?.connection === "connected") {
		return `Extension connected${extension.extensionVersion ? ` · v${extension.extensionVersion}` : ""}`;
	}
	return fallback;
}
