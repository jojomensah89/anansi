# Owner-run Anansi / reference-extension side-by-side acceptance

Run in your own signed-in desktop browser with both extensions and libraries connected. Do not put account credentials, cookies or private captures in the report. Record date, browser, OS, extension versions, Anansi commit and server version. This checklist is pending until the owner records results.

## Setup and evidence

- [ ] Confirm X, Reddit and GitHub source switches are on. Read the X risk notice. Opt into TikTok after reading its warning; its importer uses a focused window.
- [ ] Keep AI off for the baseline. Record starting counts per source in both libraries and extension queue/error state.
- [ ] Use distinct, harmless saves with known URLs and text. Record each URL, action time, confirmation, arrival time in both libraries, metadata differences and errors. Do not infer success from a total count alone.

## Desktop capture (repeat in both products)

| Source | Save and inspect |
| --- | --- |
| X | Bookmark a text post, a post with an image and a thread post. Find the exact URLs under X; inspect text, author, links and available thread/media context. |
| Reddit | Save a post and a comment. Find their exact URLs under Reddit; inspect body/title and author. |
| GitHub | Star a public repository. Find it under GitHub with its canonical URL, name and available description. Optionally test a private repository you own without sharing evidence publicly. |
| Web | Save a page with the toolbar and save a text selection with the context menu. Find both under Web and compare selected text and source URL. If the reference extension offers a different action, record it explicitly. |
| TikTok | Favorite two videos (not Likes). Find the exact video URLs under TikTok; inspect available author/text/thumbnail. Do not expect downloaded video files. |

For each platform source:

- [ ] Save, unsave, then save again; inspect current save state and history. Anansi retains history, so unsave is not a permanent delete. No duplicate current item for the same platform ID.
- [ ] Repeat on a reloaded tab, then rapidly toggle save/unsave/save. Final library state matches the final provider state.
- [ ] Run Import; repeat it. Known items do not duplicate. Check popup and Sources for errors and last-check status. A large history gap may need full import because on-demand sync is bounded.
- [ ] Disable that source in the popup and attempt a new capture; verify it is not captured while disabled. Re-enable and import to recover; existing history stays present.

Pass: each chosen save appears under the right source, opens the original URL, has usable available text/metadata, and shows truthful success/failure state. Record elapsed time and any reference/Anansi mismatch. Missing captures, silent failures, duplicate current items or incorrect source/state fail; do not mark all five sources accepted from one successful source.

## Outage and optional bookmarks

- [ ] Make only your test server unavailable through an owner-controlled method. Save test items; inspect queued/failed state. Restore service and verify retries drain and each item arrives once. Do not stop unrelated processes.
- [ ] Restart the test browser during pending delivery and verify recovery.
- [ ] Grant optional Chrome bookmark mirroring, add/edit/remove a harmless bookmark and inspect the Web item/link state. Disable mirroring and verify permission is returned and new bookmarks are not captured.

## Phone saves and on-demand sync

Repeat with fresh saves for X, Reddit, GitHub and TikTok. Keep the desktop browser signed in; close provider tabs where practical.

- [ ] With both libraries closed, save on the phone. Observe whether either product makes a request or opens a tab before a library is opened; record actual behavior. Anansi should not start platform sync solely from a timer.
- [ ] Open Anansi on desktop. Look for a sync attempt in Sources, the exact new item in the source view and the count change. Allow seconds to a minute for an ordinary small catch-up; record measured time and errors. TikTok may bring a focused window forward.
- [ ] With a fresh phone save, open Anansi on the phone while the desktop browser runs. Watch for the server request to reach the extension on its roughly two-minute check-in, then verify the exact item.
- [ ] With every desktop browser off, repeat. Browser-only sources cannot update until a browser returns. Public GitHub stars can update through the Worker when an explicit public username is configured. Record this limit instead of claiming continuous background sync.
- [ ] Reload within five minutes; no redundant platform check should occur. Use Sync now to bypass the recent-check skip.

### Required reference-extension phone observation

- [ ] Save a TikTok favorite on the phone with the reference extension's desktop browser running and its library closed. Record starting TikTok/import count.
- [ ] Open the reference extension's library. Watch for a TikTok tab/window opening or being reused, import progress/count changes, and the exact favorite appearing. Record timing and whether a manual import was required. If the behavior is not visible, mark the trigger unknown rather than guessing.
- [ ] Repeat the phone-save comparison for X, Reddit and GitHub and record discrepancies.

## Agents and finish

- [ ] Connect one OAuth app and one named API key through the MCP setup page. Read-only clients list eight tools and reject writes. Owner-granted writes list twelve tools; test tags, note set/clear and save_link on synthetic items. No delete tool exists. Revoke and verify access stops.
- [ ] Search with AI off: keyword results remain available. Agent checks request Reddit/GitHub by default; X/TikTok need owner opt-in. Check freshness/offline metadata. Repeated requests within the 15-minute per-platform window should not repeat sync.
- [ ] Record pass/fail per source and scenario, unresolved defects, artifacts with secrets removed, and the owner's acceptance decision. Tests/builds alone do not complete this checklist or authorize store submission.
