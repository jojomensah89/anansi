/**
 * The public MCP surface, kept separate from the server implementation so the
 * setup page can describe the same tools without bundling the SDK or database.
 */
export const MCP_TOOL_CATALOG = [
	{
		name: "search_saved",
		title: "Search saved posts",
		summary:
			"Search visible saved items and return ranked excerpts with source URLs.",
	},
	{
		name: "get_saved",
		title: "Get one saved item",
		summary:
			"Pull one saved item into context with its text, media, links, and thread.",
	},
	{
		name: "get_saved_many",
		title: "Get several saved items",
		summary: "Pull a bounded shortlist into context in the requested order.",
	},
	{
		name: "list_saved",
		title: "Browse saved items",
		summary: "Browse visible saved items with filters and a stable cursor.",
	},
	{
		name: "list_recent_saves",
		title: "Recently saved",
		summary: "List the newest visible saved items in their bookmark order.",
	},
	{
		name: "list_author_saves",
		title: "Everything from one author",
		summary: "Find everything saved from a particular handle, newest first.",
	},
	{
		name: "list_tags",
		title: "List saved tags",
		summary: "List the visible tag vocabulary and usage counts.",
	},
	{
		name: "library_stats",
		title: "Library statistics",
		summary: "Summarize visible saves by source, archive state, and media.",
	},
] as const;

export type McpToolName = (typeof MCP_TOOL_CATALOG)[number]["name"];
