import { MCP_TOOL_CATALOG, MCP_WRITE_TOOL_CATALOG } from "@anansi/mcp/catalog";

/**
 * What an app approved on the consent page can call.
 *
 * Consent only ever grants read. Write tools belong to an app only when the
 * owner already switched its access to read and write on the MCP page, which
 * survives the app reconnecting.
 */
export function consentTools(write: boolean): { allowed: string[]; denied: string[] } {
	const read = MCP_TOOL_CATALOG.map((tool) => tool.name);
	const changes = MCP_WRITE_TOOL_CATALOG.map((tool) => tool.name);
	return write ? { allowed: [...read, ...changes], denied: [] } : { allowed: read, denied: changes };
}
