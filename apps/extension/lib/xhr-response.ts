type XhrResponse = Pick<XMLHttpRequest, "responseType" | "response" | "responseText">;

/** JSON-mode XHR throws when responseText is read. Never consume or alter it. */
export function xhrResponseText(xhr: XhrResponse): string | null {
	if (xhr.responseType === "json") return JSON.stringify(xhr.response) ?? null;
	if (xhr.responseType === "" || xhr.responseType === "text") return xhr.responseText;
	return null;
}

export function xhrResponseJson(xhr: XhrResponse): unknown {
	if (xhr.responseType === "json") return xhr.response;
	const text = xhrResponseText(xhr);
	return text === null ? null : JSON.parse(text);
}
