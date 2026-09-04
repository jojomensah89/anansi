/**
 * The public MCP surface, kept separate from the server implementation so the
 * setup page can describe the same tools without bundling the SDK or database.
 */
export const MCP_TOOL_CATALOG = [
  {
    name: "search_memory",
    title: "Search saved posts",
    summary: "Search the saved library and return ranked excerpts with source URLs.",
  },
  {
    name: "get_item",
    title: "Get one saved item",
    summary: "Pull one saved item into context with its text, media, links, and thread.",
  },
  {
    name: "recent_saves",
    title: "Recently saved",
    summary: "List the newest saved items in their bookmark order.",
  },
  {
    name: "find_by_author",
    title: "Everything from one author",
    summary: "Find everything saved from a particular handle, newest first.",
  },
] as const;

export type McpToolName = (typeof MCP_TOOL_CATALOG)[number]["name"];
