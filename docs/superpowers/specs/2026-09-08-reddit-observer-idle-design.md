# Reddit observer idle timing

## Problem

Anansi's Reddit MAIN-world content script installs a `window.fetch` observer at
`document_start`. Reddit's own preload request for
`/svc/events/preload-head` can then be attributed to the observer in Brave's
extension Errors view when its preload and later fetch credentials modes differ.
ContextBolt avoids the page fetch hook, while Stashr installs its analogous hook
at `document_idle`.

## Decision

Run Anansi's Reddit observer content script at `document_idle`.

The observer will continue to watch only same-site Reddit POST save/unsave
requests, clone request bodies before native fetch consumes them, return the
native fetch promise unchanged, and keep observation failures non-blocking. No
credentials or request options will be rewritten.

## Alternatives considered

1. Keep `document_start`: preserves the earliest possible observation but keeps
   Anansi inside Reddit's preload lifecycle and the visible warning attribution.
2. Remove the fetch observer: eliminates the warning attribution but loses live
   save/unsave capture.
3. Use `document_idle` (chosen): matches Stashr's proven timing, avoids the
   startup preload phase, and retains live interaction capture after page load.

## Acceptance criteria

- The Reddit content script manifest entry uses `runAt: "document_idle"`.
- The generated Reddit bundle still builds and contains the observer.
- Existing observer behavior tests remain green.
- The full test suite, extension compile, extension build, and diff check pass.
- Reloading the Reddit page in Brave still renders the page successfully.
