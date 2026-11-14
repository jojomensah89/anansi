/**
 * Runs before every test file (see bunfig.toml).
 *
 * Base UI chooses between useLayoutEffect and a no-op once, when its module
 * first loads, by checking for a `document`. All test files share one module
 * cache, so whichever file loads Base UI first decides for the rest. On Linux
 * CI a server-rendering test happened to load it first, without a DOM, and
 * every later dialog test rendered nothing. Load it here, with a document in
 * place, so the order of test files no longer matters.
 */
const hadDocument = "document" in globalThis;
if (!hadDocument) Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: {} });
await import("@base-ui/utils/useIsoLayoutEffect");
if (!hadDocument) delete (globalThis as { document?: unknown }).document;
