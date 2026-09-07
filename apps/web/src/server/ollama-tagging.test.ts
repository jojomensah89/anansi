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
