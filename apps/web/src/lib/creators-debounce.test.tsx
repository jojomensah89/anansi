import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CreatorPage, CreatorQuery } from "./api.ts";
import { useCreatorsQuery } from "./creators-query.ts";
import { installDom } from "./test-dom.ts";

const NO_SOURCES: string[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("typing in the author filter sends one request after typing stops", async () => {
	const { restore } = installDom();
	const requests: CreatorQuery[] = [];
	const aborted: string[] = [];
	const loader = async (options: CreatorQuery, signal: AbortSignal): Promise<CreatorPage> => {
		requests.push(options);
		signal.addEventListener("abort", () => aborted.push(options.query ?? ""));
		return { creators: [], nextCursor: null, total: 0, singleSaveCount: 0, topTenSaves: 0 };
	};
	let type: (value: string) => void = () => {};
	let shown = "";
	function Harness() {
		const [text, setText] = useState("");
		type = setText;
		shown = text;
		useCreatorsQuery(text, NO_SOURCES, { debounceMs: 250, loader });
		return null;
	}
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const root = createRoot(document.getElementById("root")!);
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<Harness />
				</QueryClientProvider>,
			),
		);
		await act(async () => wait(20));
		expect(requests.map((r) => r.query)).toEqual([""]);

		for (const value of ["a", "an", "ana", "anan", "anansi"]) {
			await act(async () => {
				type(value);
				await wait(40);
			});
			// The input keeps every keystroke; nothing is asked for yet.
			expect(shown).toBe(value);
		}
		expect(requests.map((r) => r.query)).toEqual([""]);

		await act(async () => wait(320));
		expect(requests.map((r) => r.query)).toEqual(["", "anansi"]);
	} finally {
		await act(async () => root.unmount());
		client.clear();
		// Let React Query's batched notifications drain before the DOM goes.
		await wait(20);
		restore();
	}
});
