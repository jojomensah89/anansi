import {
  createRouter as createTanStackRouter,
  parseSearchWith,
  stringifySearchWith,
} from "@tanstack/react-router";

import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";

/**
 * Search params a person can read.
 *
 * The default serialiser JSON-encodes anything that is not a string, so a
 * two-platform filter becomes `?source=%5B%22x%22%2C%22tiktok%22%5D`. The
 * library's filters are meant to be linked to — from Sources, from the rail,
 * from a message to yourself — and that is not a link anyone can read, edit or
 * trust the look of.
 *
 * Arrays are comma-joined instead. Everything else keeps the default
 * behaviour, and each route's `validateSearch` remains the thing that decides
 * what a param actually means.
 */
const encode = (value: unknown): string => {
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return (value as string[]).join(",");
  }
  return typeof value === "string" ? value : JSON.stringify(value);
};

/**
 * Left as a string on the way in.
 *
 * A comma list is ambiguous with a value that merely contains a comma, so the
 * splitting is not done here: `validateSearch` knows which params are lists
 * and splits only those. Anything this parser guessed at would be a guess
 * applied to every route.
 */
const decode = (value: string): unknown => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
};

export const getRouter = () => {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    context: {},
    parseSearch: parseSearchWith(decode),
    stringifySearch: stringifySearchWith(encode),
    defaultPendingComponent: () => <Loader />,
    defaultNotFoundComponent: () => <div>Not Found</div>,
  });

  return router;
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
