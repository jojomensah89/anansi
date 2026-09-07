import {
	AiProviderError,
	type EmbeddingProvider,
	validateVector,
} from "./ai.ts";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_BATCH_SIZE = 16;
export const DEFAULT_OLLAMA_TIMEOUT_MS = 30_000;
const MAX_OLLAMA_TEXT = 12_000;

export type OllamaFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface OllamaEmbeddingProviderOptions {
	model: string;
	baseUrl?: string;
	dimensions?: number;
	batchSize?: number;
	timeoutMs?: number;
	/** Injectable fetch seam for tests and alternate local runtimes. */
	fetch?: OllamaFetch;
	/** Alias retained for callers that use a more explicit name. */
	fetcher?: OllamaFetch;
	fetchImpl?: OllamaFetch;
}

export type OllamaEmbeddingResponse = {
	model: string;
	embeddings: number[][];
};

type OllamaOptionsWithoutModel = Omit<OllamaEmbeddingProviderOptions, "model">;

function providerError(
	code: AiProviderError["code"],
	message: string,
): AiProviderError {
	return new AiProviderError(code, message);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function normalizeEndpoint(baseUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw providerError("malformed", "Ollama base URL is invalid");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw providerError("malformed", "Ollama base URL must use HTTP or HTTPS");
	}
	if (parsed.username || parsed.password) {
		throw providerError(
			"malformed",
			"Ollama base URL must not contain credentials",
		);
	}
	parsed.pathname = "/api/embed";
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString();
}

function validatePositiveInteger(
	value: number,
	label: string,
	code: AiProviderError["code"] = "malformed",
): number {
	if (!Number.isInteger(value) || value < 1)
		throw providerError(code, `${label} must be a positive integer`);
	return value;
}

function classifyTransportError(error: unknown): AiProviderError {
	if (error instanceof AiProviderError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (
		/403|429|quota|rate[ -]?limit|capacity|too many requests/i.test(message)
	) {
		return providerError(
			"quota",
			"Ollama request was rate limited or over quota",
		);
	}
	return providerError("unavailable", "Ollama is unavailable");
}

function classifyHttpStatus(status: number): AiProviderError {
	if (status === 401 || status === 403 || status === 429) {
		return providerError(
			"quota",
			"Ollama request was rate limited or over quota",
		);
	}
	if (status === 404)
		return providerError(
			"unavailable",
			"Ollama model or endpoint was not found",
		);
	if (status >= 500)
		return providerError(
			"unavailable",
			"Ollama returned a temporary server error",
		);
	return providerError(
		"unavailable",
		`Ollama request failed with HTTP ${status}`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Server-only adapter for Ollama's `/api/embed` endpoint.
 *
 * The configured model is used for requests and remains the stable provider
 * identity even when Ollama resolves an alias in its response. The observed
 * response model is available separately for diagnostics. Vector dimensions
 * are discovered from the response unless an expected dimension was supplied.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
	readonly batchSize: number;
	readonly timeoutMs: number;
	readonly #requestedModel: string;
	readonly #endpoint: string;
	readonly #expectedDimensions?: number;
	readonly #fetch: OllamaFetch;
	#resolvedModel?: string;
	#dimensions?: number;

	constructor(options: OllamaEmbeddingProviderOptions);
	constructor(model: string, options?: OllamaOptionsWithoutModel);
	constructor(
		modelOrOptions: string | OllamaEmbeddingProviderOptions,
		modelOptions: OllamaOptionsWithoutModel = {},
	) {
		const options: OllamaEmbeddingProviderOptions =
			typeof modelOrOptions === "string"
				? { ...modelOptions, model: modelOrOptions }
				: modelOrOptions;
		const model = options.model.trim();
		if (!model)
			throw providerError("malformed", "Ollama embedding model is required");

		this.#requestedModel = model;
		this.#endpoint = normalizeEndpoint(
			options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
		);
		this.batchSize = validatePositiveInteger(
			options.batchSize ?? DEFAULT_OLLAMA_BATCH_SIZE,
			"Ollama batch size",
		);
		this.timeoutMs = validatePositiveInteger(
			options.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS,
			"Ollama timeout",
		);
		if (options.dimensions !== undefined) {
			this.#expectedDimensions = validatePositiveInteger(
				options.dimensions,
				"Ollama embedding dimensions",
				"dimension",
			);
		}
		const fetcher =
			options.fetch ??
			options.fetcher ??
			options.fetchImpl ??
			globalThis.fetch?.bind(globalThis);
		if (typeof fetcher !== "function")
			throw providerError("unavailable", "Fetch is unavailable for Ollama");
		this.#fetch = fetcher;
	}

	get model(): string {
		return this.#requestedModel;
	}

	/** The model identity Ollama returned, which may differ from the alias used. */
	get observedModel(): string | undefined {
		return this.#resolvedModel;
	}

	/** The observed vector dimension, or the configured expected dimension. */
	get dimensions(): number {
		return this.#dimensions ?? this.#expectedDimensions ?? 0;
	}

	/** Undefined until Ollama has returned a successful embedding. */
	get observedDimensions(): number | undefined {
		return this.#dimensions;
	}

	get endpoint(): string {
		return this.#endpoint;
	}

	async embed(text: string): Promise<number[]> {
		const vectors = await this.embedBatch([text]);
		const vector = vectors[0];
		if (!vector)
			throw providerError("malformed", "Ollama returned no embedding");
		return vector;
	}

	async embedMany(texts: readonly string[]): Promise<number[][]> {
		return this.embedBatch(texts);
	}

	async embedBatch(texts: readonly string[]): Promise<number[][]> {
		if (
			!Array.isArray(texts) ||
			texts.some((text) => typeof text !== "string")
		) {
			throw providerError(
				"malformed",
				"Ollama embedding input must be an array of strings",
			);
		}
		if (texts.length === 0) return [];

		const vectors: number[][] = [];
		for (let start = 0; start < texts.length; start += this.batchSize) {
			const batch = texts
				.slice(start, start + this.batchSize)
				.map((text) => text.slice(0, MAX_OLLAMA_TEXT));
			const input = batch.length === 1 ? batch[0] : batch;
			if (input === undefined)
				throw providerError("malformed", "Ollama embedding batch is empty");
			const payload = await this.request(input);
			vectors.push(...this.parseEmbeddings(payload, batch.length));
		}
		return vectors;
	}

	private async request(input: string | readonly string[]): Promise<unknown> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const operation = (async () => {
			let response: Response;
			try {
				response = await this.#fetch(this.#endpoint, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: this.#requestedModel, input }),
					signal: controller.signal,
				});
			} catch (error) {
				throw classifyTransportError(error);
			}

			const status =
				typeof response.status === "number" ? response.status : 200;
			const ok =
				typeof response.ok === "boolean"
					? response.ok
					: status >= 200 && status < 300;
			if (!ok) throw classifyHttpStatus(status);
			try {
				return await response.json();
			} catch {
				throw providerError("malformed", "Ollama returned malformed JSON");
			}
		})();

		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(providerError("unavailable", "Ollama request timed out"));
			}, this.timeoutMs);
		});
		try {
			return await Promise.race([operation, timeout]);
		} catch (error) {
			throw classifyTransportError(error);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	private parseEmbeddings(payload: unknown, expectedCount: number): number[][] {
		if (
			!isRecord(payload) ||
			typeof payload.model !== "string" ||
			payload.model.trim() === ""
		) {
			throw providerError(
				"malformed",
				"Ollama returned an invalid model identity",
			);
		}
		if (
			this.#resolvedModel !== undefined &&
			this.#resolvedModel !== payload.model
		) {
			throw providerError(
				"malformed",
				"Ollama returned inconsistent model identities",
			);
		}
		if (
			!Array.isArray(payload.embeddings) ||
			payload.embeddings.length !== expectedCount
		) {
			throw providerError(
				"malformed",
				"Ollama returned an invalid embedding batch",
			);
		}

		const dimension =
			this.#dimensions ??
			this.#expectedDimensions ??
			(Array.isArray(payload.embeddings[0]) ? payload.embeddings[0].length : 0);
		const parsed: number[][] = [];
		for (const [index, value] of payload.embeddings.entries()) {
			if (!Array.isArray(value))
				throw providerError(
					"malformed",
					`Ollama embedding ${index} is not an array`,
				);
			if (value.some((number) => !isFiniteNumber(number))) {
				throw providerError(
					"malformed",
					`Ollama embedding ${index} contains a non-finite value`,
				);
			}
			parsed.push(
				validateVector(value, dimension, `Ollama embedding ${index}`),
			);
		}
		if (this.#resolvedModel === undefined) this.#resolvedModel = payload.model;
		if (this.#dimensions === undefined) this.#dimensions = dimension;
		return parsed;
	}
}

export function createOllamaEmbeddingProvider(
	options: OllamaEmbeddingProviderOptions,
): OllamaEmbeddingProvider;
export function createOllamaEmbeddingProvider(
	model: string,
	options?: OllamaOptionsWithoutModel,
): OllamaEmbeddingProvider;
export function createOllamaEmbeddingProvider(
	modelOrOptions: string | OllamaEmbeddingProviderOptions,
	options?: OllamaOptionsWithoutModel,
): OllamaEmbeddingProvider {
	return typeof modelOrOptions === "string"
		? new OllamaEmbeddingProvider(modelOrOptions, options)
		: new OllamaEmbeddingProvider(modelOrOptions);
}
