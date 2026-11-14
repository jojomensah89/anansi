import { createFileRoute } from "@tanstack/react-router";
import { authorizationServerMetadata, protectedResourceMetadata } from "../server/oauth.ts";

/** Public discovery documents that tell an MCP client where to sign in. */
export const Route = createFileRoute("/.well-known/$")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const url = new URL(request.url);
				const path = url.pathname.replace(/[/]+$/, "");
				if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
					return Response.json(protectedResourceMetadata(url.origin));
				}
				if (path === "/.well-known/oauth-authorization-server") {
					return Response.json(authorizationServerMetadata(url.origin));
				}
				return Response.json({ error: "not found" }, { status: 404 });
			},
		},
	},
});
