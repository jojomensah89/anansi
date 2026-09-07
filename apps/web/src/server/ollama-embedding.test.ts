import { describe, expect, test } from "bun:test";
import { AiProviderError } from "./ai.ts";
import {
	createOllamaEmbeddingProvider,
	OllamaEmbeddingProvider,
	type OllamaFetch,
} from "./ollama-embedding.ts";

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function bodyOf(call: FetchCall): Record<string, unknown> {
	return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

describe("Ollama embedding provider", () => {
	test("posts the documented single-input shape and discovers model/dimensions", async () => {
		const calls: FetchCall[] = [];
		const fetcher: OllamaFetch = async (input, init) => {
			calls.push({ input, init });
			return jsonResponse({ model: "embeddinggemma", embeddings: [[1, 2, 3]] });
		};
		const provider = createOllamaEmbeddingProvider({
			model: "embeddinggemma",
			fetch: fetcher,
		});

		await expect(provider.embed("a bookmark")).resolves.toEqual([1, 2, 3]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("http://127.0.0.1:11434/api/embed");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(calls[0]?.init?.headers).toEqual({
			"content-type": "application/json",
		});
		const firstCall = calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) throw new Error("fake fetch did not receive a request");
		expect(bodyOf(firstCall)).toEqual({
			model: "embeddinggemma",
			input: "a bookmark",
		});
		expect(provider.model).toBe("embeddinggemma");
		expect(provider.dimensions).toBe(3);
		expect(provider.observedDimensions).toBe(3);
	});

	test("uses bounded array inputs and preserves order across requests", async () => {
		const calls: FetchCall[] = [];
		const fetcher: OllamaFetch = async (input, init) => {
			const call = { input, init };
			calls.push(call);
			const body = bodyOf(call);
			const inputTexts = Array.isArray(body.input) ? body.input : [body.input];
			return jsonResponse({
				model: "model",
				embeddings: inputTexts.map((value) => [String(value).length, 0]),
			});
		};
		const provider = new OllamaEmbeddingProvider({
			model: "model",
			batchSize: 2,
			fetch: fetcher,
		});

		await expect(
			provider.embedBatch(["one", "two", "three", "four", "five"]),
		).resolves.toEqual([
			[3, 0],
			[3, 0],
			[5, 0],
			[4, 0],
			[4, 0],
		]);
		expect(calls).toHaveLength(3);
		expect(calls.map(bodyOf)).toEqual([
			{ model: "model", input: ["one", "two"] },
			{ model: "model", input: ["three", "four"] },
			{ model: "model", input: "five" },
		]);
	});

	test("bounds text sent to the local daemon and rejects credential-bearing URLs", async () => {
		let received = "";
		const provider = new OllamaEmbeddingProvider({
			model: "model",
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as { input: string };
				received = body.input;
				return jsonResponse({ model: "model", embeddings: [[1, 0]] });
			},
		});
		await provider.embed("x".repeat(20_000));
		expect(received).toHaveLength(12_000);
		expect(
			() =>
				new OllamaEmbeddingProvider({
					model: "model",
					baseUrl: "http://user:secret@127.0.0.1:11434",
				}),
		).toThrow(AiProviderError);
	});

	test("does not call Ollama for an empty batch", async () => {
		let calls = 0;
		const fetcher: OllamaFetch = async () => {
			calls += 1;
			return jsonResponse({ model: "model", embeddings: [] });
		};
		const provider = new OllamaEmbeddingProvider({
			model: "model",
			fetch: fetcher,
		});

		await expect(provider.embedBatch([])).resolves.toEqual([]);
		expect(calls).toBe(0);
	});

	test("accepts an expected dimension and rejects a mismatched response", async () => {
		const fetcher: OllamaFetch = async () =>
			jsonResponse({ model: "model", embeddings: [[1, 2]] });
		const provider = new OllamaEmbeddingProvider({
			model: "model",
			dimensions: 3,
			fetch: fetcher,
		});

		expect(provider.dimensions).toBe(3);
		await expect(provider.embed("text")).rejects.toMatchObject({
			code: "dimension",
		});
		expect(provider.observedDimensions).toBeUndefined();
	});

	test("rejects malformed, non-finite, and inconsistent vectors with typed errors", async () => {
		const malformed = new OllamaEmbeddingProvider({
			model: "model",
			fetch: async () =>
				jsonResponse({ model: "model", embeddings: [{ nope: true }] }),
		});
		await expect(malformed.embed("text")).rejects.toMatchObject({
			code: "malformed",
		});

		const nonFinite = new OllamaEmbeddingProvider({
			model: "model",
			fetch: async () =>
				jsonResponse({ model: "model", embeddings: [[1, Number.NaN]] }),
		});
		await expect(nonFinite.embed("text")).rejects.toMatchObject({
			code: "malformed",
		});

		const inconsistent = new OllamaEmbeddingProvider({
			model: "model",
			fetch: async () =>
				jsonResponse({ model: "model", embeddings: [[1, 2], [1]] }),
		});
		await expect(inconsistent.embedBatch(["one", "two"])).rejects.toMatchObject(
			{ code: "dimension" },
		);
	});

	test("rejects malformed JSON and missing embeddings without retaining the body", async () => {
		const malformedJson = new OllamaEmbeddingProvider({
			model: "model",
			fetch: async () => new Response("provider secret", { status: 200 }),
		});
		const malformedJsonError = await malformedJson
			.embed("text")
			.catch((error: unknown) => error);
		expect(malformedJsonError).toBeInstanceOf(AiProviderError);
		expect(malformedJsonError).toMatchObject({ code: "malformed" });
		expect((malformedJsonError as Error).message).not.toContain(
			"provider secret",
		);

		const missingEmbeddings = new OllamaEmbeddingProvider({
			model: "model",
			fetch: async () => jsonResponse({ model: "model" }),
		});
		await expect(missingEmbeddings.embed("text")).rejects.toMatchObject({
			code: "malformed",
		});
	});

	test("classifies missing model/server and quota responses", async () => {
		const missingModel = new OllamaEmbeddingProvider({
			model: "missing-model",
			fetch: async () => new Response("model not found", { status: 404 }),
		});
		await expect(missingModel.embed("text")).rejects.toMatchObject({
			code: "unavailable",
		});

		const quota = new OllamaEmbeddingProvider({
			model: "model",
			fetch: async () => new Response("rate limited", { status: 429 }),
		});
		await expect(quota.embed("text")).rejects.toMatchObject({ code: "quota" });

		const refused = new OllamaEmbeddingProvider({
			model: "model",
			fetch: async () => {
				throw new Error("connect ECONNREFUSED");
			},
		});
		await expect(refused.embed("text")).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	test("aborts and classifies a timed-out request as unavailable", async () => {
		let signal: AbortSignal | null | undefined;
		const fetcher: OllamaFetch = async (_input, init) => {
			signal = init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			});
		};
		const provider = new OllamaEmbeddingProvider({
			model: "model",
			timeoutMs: 5,
			fetch: fetcher,
		});

		await expect(provider.embed("text")).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(signal?.aborted).toBe(true);
	});
});
