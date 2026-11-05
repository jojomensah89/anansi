# Capture side-by-side checklist

Use this to prove stage 1 of the overhaul with real accounts, with Anansi and Stashr both installed in the same browser profile. Repeat it after any capture change.

## Setup

1. Start the local library and leave it running:

   ```bash
   bun run dev
   ```

2. Open `chrome://extensions` and press **Reload** on the Anansi card. Do not remove it or load a different folder, because its queued captures are stored with the extension's folder path.
3. If the popup says older pending captures have no recorded server destination, press **Assign pending captures here**, as long as the Worker URL is your own library. This appears once for a queue created before PR #12.
4. Refresh any open X, Reddit and GitHub tabs, so they run the new capture scripts.
5. Open `http://127.0.0.1:8787/sources` and note the queue numbers.

## Backlog recovery

Check this once, right after reloading.

- [ ] X's queued count starts falling within a few minutes
- [ ] Any permanently failed page stays visible as a failure, without stopping the pages behind it
- [ ] Reddit and GitHub stay clear
- [ ] The "queue is full" message disappears once the backlog is small enough

## Live saves

For each platform, use a post you haven't saved before. Stashr and Anansi should both react to the same click.

| Check | X | Reddit | GitHub |
| --- | --- | --- | --- |
| Save shows "Saved to Anansi" beside the button | [ ] | [ ] | [ ] |
| Saved post appears in the library with full text | [ ] | [ ] | [ ] |
| Stashr also captured it | [ ] | [ ] | [ ] |
| Unsave shows "Removed from Anansi" | [ ] | [ ] | [ ] |
| Unsave updates the library | [ ] | [ ] | [ ] |
| Three quick save and unsave clicks end in the right final state | [ ] | [ ] | [ ] |
| Save right after reloading the tab still works | [ ] | [ ] | [ ] |
| Save from a timeline or feed works | [ ] | [ ] | [ ] |
| Save from a post's own page works | [ ] | [ ] | [ ] |

## Outage and recovery

1. Stop `bun run dev`.
2. Save one post on X. It should still say "Saved to Anansi", because the extension holds it safely.
3. Start `bun run dev` again.

- [ ] The post reaches the library without any further action

## Not connected

1. Disconnect the extension from its popup.
2. Save a post.

- [ ] It says "Connect Anansi to save this"
- [ ] Reconnecting delivers that save

## Record anything Anansi misses

For each miss, note the platform, the page you were on, the post link, and what the confirmation said. A miss with no confirmation at all is the most useful to report, because it means Anansi never saw the save.
