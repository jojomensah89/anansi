import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type SourceRow, type SourcesResponse } from "./api.ts";
import { frameKeys } from "./frame-status.ts";

/**
 * The Sources page's data, through react-query like the rest of the app.
 *
 * One request answers two questions: the platforms and the extension's
 * health. The top bar's dot reads the extension half from its own query, so a
 * load here writes that half into the frame's cache and both agree.
 */

export const sourceKeys = {
	list: ["sources"] as const,
};

export function useSources() {
	const client = useQueryClient();
	return useQuery({
		queryKey: sourceKeys.list,
		queryFn: async ({ signal }) => {
			const result = await api.sources(signal);
			client.setQueryData(frameKeys.extension, result.extension);
			return result;
		},
		staleTime: 4_000,
		retry: 1,
	});
}

function withEnabled(data: SourcesResponse | undefined, source: string, enabled: boolean): SourcesResponse | undefined {
	return data && { ...data, sources: data.sources.map((row) => (row.source === source ? { ...row, enabled } : row)) };
}

/** Drawn at once, confirmed after; a failure puts the switch back and says so. */
export function useToggleSource() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({ row, enabled }: { row: SourceRow; enabled: boolean }) => api.toggleSource(row.source, enabled),
		onMutate: async ({ row, enabled }) => {
			await client.cancelQueries({ queryKey: sourceKeys.list });
			client.setQueryData<SourcesResponse>(sourceKeys.list, (data) => withEnabled(data, row.source, enabled));
		},
		onError: (error, { row, enabled }) => {
			client.setQueryData<SourcesResponse>(sourceKeys.list, (data) => withEnabled(data, row.source, !enabled));
			toast.error(`Couldn't turn ${enabled ? "on" : "off"} ${row.name}`, { description: error instanceof Error && error.message ? error.message : undefined });
		},
	});
}
