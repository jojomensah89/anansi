import { describe, expect, test } from "bun:test";
import { AiProviderError } from "./ai.ts";
import { OllamaTaggingProvider } from "./ollama-tagging.ts";

describe("Ollama tagging provider", () => {
	test("sends a schema-constrained chat request and normalizes labels", async () => {
		let request: Record<string, unknown> | undefined;
		const provider = new OllamaTaggingProvider({
			model: "qwen-test",
			fetch: async (_input, init) => {
				request = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return Response.json({ model: "qwen-test", message: { content: '{"tags":["web-dev", "AI / ML"]}' } });
			},
		});
		expect(await provider.generateTags("SQLite and MCP")).toEqual(["web-dev", "ai-ml"]);
		expect(request).toMatchObject({ model: "qwen-test", stream: false, think: false, options: { temperature: 0 } });
		expect(request?.format).toMatchObject({ type: "object", required: ["tags"] });
	});

	test("keeps a configured alias stable when Ollama returns a resolved model", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const provider = new OllamaTaggingProvider({
			model: "tag-alias",
			fetch: async (_input, init) => {
				requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return Response.json({
					model: "resolved-tagging",
					message: { content: '{"tags":["web-dev"]}' },
				});
			},
		});

		await expect(provider.generateTags("first")).resolves.toEqual(["web-dev"]);
		await expect(provider.generateTags("second")).resolves.toEqual(["web-dev"]);
		expect(provider.model).toBe("tag-alias");
		expect(provider.observedModel).toBe("resolved-tagging");
		expect(requests.map((body) => body.model)).toEqual(["tag-alias", "tag-alias"]);
	});

	test("rejects a resolved model identity that changes between requests", async () => {
		let request = 0;
		const provider = new OllamaTaggingProvider({
			model: "tag-alias",
			fetch: async () => {
				request += 1;
				return Response.json({
					model: request === 1 ? "resolved-tagging" : "other-tagging",
					message: { content: '{"tags":["web-dev"]}' },
				});
			},
		});
		await provider.generateTags("first");
		await expect(provider.generateTags("second")).rejects.toMatchObject({
			code: "malformed",
		});
	});

	test("rejects malformed, duplicate, and excessive output", async () => {
		for (const content of [
			"not-json",
			'{"tags":["same", "same"]}',
			'{"tags":["one", "two", "three"]}',
		]) {
			const provider = new OllamaTaggingProvider({
				model: "qwen-test",
				fetch: async () => Response.json({ model: "qwen-test", message: { content } }),
			});
			const promise = provider.generateTags("text", content.includes("one") ? 2 : 5);
			await expect(promise).rejects.toBeInstanceOf(AiProviderError);
		}
	});

	test("classifies missing models and timeouts safely", async () => {
		const missing = new OllamaTaggingProvider({ model: "missing", fetch: async () => new Response("", { status: 404 }) });
		await expect(missing.generateTags("text")).rejects.toMatchObject({ code: "unavailable" });
		const timeout = new OllamaTaggingProvider({ model: "slow", timeoutMs: 5, fetch: async () => new Promise<Response>(() => {}) });
		await expect(timeout.generateTags("text")).rejects.toMatchObject({ code: "unavailable" });
	});
});
