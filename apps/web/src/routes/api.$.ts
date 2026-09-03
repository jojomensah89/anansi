import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "../server/api.ts";
import { serverEnv } from "../server/env.ts";

/**
 * One splat route for the whole JSON API.
 *
 * The routing here is deliberately thin: `handleApi` does the dispatch, takes
 * a plain Request, and is tested without a framework at all. If TanStack's
 * server-route API changes shape again, this file changes and nothing else
 * does.
 */
export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleApi(serverEnv(), request),
      POST: ({ request }) => handleApi(serverEnv(), request),
    },
  },
});
