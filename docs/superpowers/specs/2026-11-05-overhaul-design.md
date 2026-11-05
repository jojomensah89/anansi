# Anansi overhaul

Date: 2026-11-05
Status: Decisions confirmed by the owner in a design interview; this written plan awaits owner review.
Branch: `overhaul`, from GitHub `main` (`2561cfa`) merged with the adapter work on `wip/platform-adapters` (`babb35a`).

## Goal

Anansi is an open-source, self-hosted alternative to Stashr. Saving on a platform should put that save in your library without further thought, including saves made on your phone. Agents should be able to connect and find things. The interface should be pleasant to read, and setting it up should take minutes.

The overhaul merges only when the owner runs Anansi and Stashr side by side and Anansi keeps up.

## Decisions

| Area | Decision |
| --- | --- |
| Hosting | Self-hosted only. One owner per deployment, on their own Cloudflare account. No accounts, teams or billing. Local operation is for development and testing. |
| Rebuild approach | Rebuild in this repo. Keep parsers, capture contracts, receipts and the database. Delete replaced code as each part lands. |
| Sync of saves made elsewhere | Opening the library on any device prompts the extension to check each platform, opening a brief background tab where needed. Agent searches prompt the same sync, limited to Reddit and GitHub unless the owner allows X and TikTok. There are no sync timers and no paid APIs. It stops at the first item already saved. Reddit, GitHub and X are on by default. TikTok is opt-in with the risk explained. |
| X risk notice | Shown once when the extension first connects, because X is on by default. |
| Extension connection | A "Connect extension" button in the signed-in library. The extension asks for that one site, and the library issues a capture-only key for that browser. Pasting a key remains the fallback. |
| Agent connection | OAuth for apps. Named, revocable API keys for CLI tools and scripts. No dedicated CLI for now. |
| Agent permissions | Read-only by default. Optional per-client write access for tags, notes and saving a link. Agents cannot delete. |
| Agent search | By meaning when enabled, falling back to keyword when AI is off or the monthly cap is reached. This replaces ADR 0004. |
| Client management | One "Connected clients" screen for extensions, apps and keys. |
| UI | Adapt T3 Code's styling and components, keeping its MIT notice with anything copied. Keep Anansi's spider logo and amber accent. Reading text stays at 14px or larger. |
| Platforms to merge | X, Reddit, GitHub, web and TikTok. |
| Platforms after merge | Instagram, then Hacker News. LinkedIn and Facebook only on demand. The README and Sources page list only platforms that passed acceptance. |
| Deploy target | One field to fill in, AI off by default, automatic migrations, and under 10 minutes from the button to the first captured save. |

## What we know about capture today

Evidence from the owner's local library and extension on 2026-11-05:

- Saves queued in the extension while the server was unavailable. The extension recorded `queue_full` on X, Reddit and GitHub. The durable queue has a 25 MB total limit.
- The queue drained once the server stayed reachable, from 223 waiting to 172 in about 20 minutes.
- Before that run, all 21 stored capture events were imports. None were live saves.
- There are no TikTok items, and TikTok's last error is `capture_failed`.
- A native X save was not observed on a reloaded tab during the September validation.

Causes found in stage 1, each reproduced in a test:

- A permanently failed import page held its source's place in line, so every later page waited behind it. X showed 170 pages queued behind 1 failure while other sources drained, and that backlog eventually filled the queue.
- Import pages and live saves shared one space limit, so a backlog could refuse live saves.
- Validation rejected any `undefined` field, and X's parser sets `saveOrder` that way on page-captured posts. Those saves were dropped in the relay with no retry or error. Only saves without a content snapshot got through.
- `bun run dev` from PR #12 served from an empty database, so delivery failed with "no such table".

Not yet proven with real accounts: why the first X page was rejected, and whether any save is still missed after these fixes. The side-by-side checklist settles that.

What Stashr does, from its public docs and a static read of extension 1.0.20:

- It watches native buttons, reads page state, and hooks requests, and shows a "Stashed" or "Failed" tooltip.
- TikTok import uses or opens a TikTok tab and fetches favorites through TikTok's own signed requests. X import uses a background tab. Reddit and GitHub need no tab.
- Imports stop early at items already saved, using stored watermarks.
- Its website can start imports through the extension.

Not proven: what triggered the phone save the owner saw appear. Stashr's docs describe a manual import, and no import timer was found in the extension. Stashr's code is proprietary, so we study its behaviour and do not copy it.

**Known limit:** provider sessions live in the browser, so browser-based sync runs only while a desktop browser with the extension is running. With every computer off, only platforms that have a free server path can update.

Server paths checked on 2026-11-05:

| Platform | Server path with computers off | Status |
| --- | --- | --- |
| GitHub | Public stars through GitHub's API from the Worker | Available when the library opens. Private stars need the browser. |
| X | Official bookmarks API | Paid, and rejected by the owner. X waits for the browser. |
| Reddit | None we should build on | Reddit says RSS ends on November 13, 2026. New API access needs approval, and reports say the public API closes in March 2027. |
| TikTok | None found | No official favorites endpoint was found. |

We will not upload platform session cookies to the Worker. That would turn a compromised library into compromised X, Reddit and TikTok accounts, and it would break Anansi's privacy promise.

## Build order

Each stage ends with its own proof. A successful build alone never counts.

### 1. Capture reliability

- Find the cause of `queue_full` and the slow drain, starting with a reproduction.
- Keep live saves from being starved by import backlogs, and report a full queue clearly.
- Add a "Saved" or "Failed" confirmation beside the platform's own button.
- Fix native X saves on reloaded tabs.
- Finish the adapter refactor, so platform behaviour lives in its adapter and the background worker shrinks.

**Proof:** a repeatable side-by-side checklist on signed-in X, Reddit and GitHub covering save, unsave, rapid toggles, reloaded tabs, and server outage and recovery. See `docs/superpowers/plans/2026-11-05-capture-side-by-side.md`.

**Status on 2026-11-05:** code complete except anything the owner's test reveals. The built extension passed an isolated end-to-end run against a stubbed x.com and a throwaway library. The real-account checklist has not been run. The background worker has no platform-specific branches left, though it is still large, and stage 2 replaces its catch-up timer.

### 2. TikTok and background sync

- Replace the click-and-watch TikTok import with direct fetches from a TikTok tab.
- Add one on-demand sync for every platform, stopping at the first known item. Remove today's 24-hour catch-up timer. No sync runs at browser start or on wake.
- Trigger it when the library opens on this computer. Reddit and GitHub need no tab. X and TikTok use an open tab or a brief background tab that closes afterward.
- When the library opens on another device, record a sync request on the Worker. The extension picks it up from its existing two-minute check-in, which only contacts the owner's Worker and never a platform.
- Skip a platform checked in the last 5 minutes, so reloading the library doesn't reopen tabs. A "Sync now" control bypasses this.
- Check public GitHub stars from the Worker when the library opens, so they update with every computer off.
- Show new saves arriving live through the existing two-second refresh.
- Show each platform's last check, any error, and whether the browser is offline, on the library and Sources.
- Let the library page talk to the extension on the owner's own origin only.

**Proof:** for X, Reddit, TikTok and GitHub, save on the phone without opening the platform on desktop, then check three cases. With the library closed, no platform request or tab occurs. With the library opened on desktop, the save arrives within seconds to a minute. With the library opened on the phone while the desktop browser runs, it arrives within about two minutes of the check-in.

Agent searches also prompt a sync through the same Worker request, with a 15-minute skip window per platform:

- Reddit and GitHub are checked by default, because they need no tab.
- X and TikTok are checked only if the owner turns on "Let agents check X and TikTok", which is off by default, because they can open a background tab.
- Results return immediately and state how fresh each platform is, whether a sync was requested, and whether the browser is offline, so the agent can search again or warn the owner.

**Agent proof:** with the setting off, an agent search causes a Reddit and GitHub check and no tab. With it on, X and TikTok are checked too. Repeated searches inside the skip window cause no further platform requests, and an offline browser is reported in the results.

### 3. Auth and connected clients

- Add stored clients with names, permissions, last use and revocation.
- Add the "Connect extension" flow and per-browser capture-only keys.
- Add API keys and OAuth for MCP, with a maintained OAuth library chosen during this stage.
- Limit the master secret to owner sign-in and recovery.
- Add the "Connected clients" screen.

**Proof:** a capture key cannot read the library or call MCP, a revoked client stops working immediately, and at least one OAuth client and one API-key client both connect.

### 4. Agent surface

- Add search by meaning with keyword fallback, sharing the existing AI budget.
- Add optional write tools for tags, notes and saving links.
- Rewrite the MCP setup page around the new connection options, and replace the stale `MCP_TOKEN` guidance.
- Supersede ADR 0004.

**Proof:** agent tests cover semantic results, fallback at the cap, and rejected writes on read-only clients.

### 5. UI

- Import T3 Code's relevant tokens and components into `packages/ui`.
- Replace the inline style objects with one type scale and text color roles.
- Rebuild the library, Sources, Authors, MCP, Settings, sign-in and extension popup in that order.
- Turn the capture trail into the signature detail: a thin thread showing captured, stored and tagged on each save, with failures visible.
- Run the `unslop` passes and its checklist on each screen.

**Proof:** body and meta text meet 4.5:1 contrast, no reading text is under 14px, no meta text is under 12px, and screenshots are reviewed by the owner.

Stages 1 to 3 change how the app behaves, and this stage changes how it looks. It can start alongside stage 2, because the owner's complaint about legibility doesn't depend on the capture work.

### 6. Deployment

- Make AI resources safe to leave unused.
- Supply Vectorize settings from the repo if Cloudflare allows it, and otherwise keep two documented fields.
- Remove the manual `BUN_VERSION` step if the repo can set the version.
- Keep the existing public extension build checks.

**Proof:** on a brand-new Cloudflare account, deploy, connect, capture, search, export and restore, then connect one agent through OAuth, in under 10 minutes to the first capture.

### 7. Launch acceptance

- Run the full side-by-side test across X, Reddit, GitHub, web and TikTok.
- Correct `README.md`, `CONTEXT.md` and the older strategy documents, including the "local-first" claim.
- Prepare the Chrome Web Store listing and permission explanations, using `release/chrome/README.md`.

Submission and public publication remain the owner's decisions.

## Needed from the owner

- A signed-in browser for side-by-side tests, starting at stage 1.
- The phone-save test on Stashr: save on the phone, open the library, and watch for a TikTok tab or import count.
- A clean Cloudflare account at stage 6.
- A Chrome Web Store developer account and a public privacy policy URL at stage 7.

## Risks

- **Provider changes:** capture relies on signed-in sessions and undocumented behaviour, so it will break from time to time. Clear failure reporting matters as much as the capture itself.
- **Account risk:** automated requests could draw provider attention. X is on by default by the owner's decision, so sync stays small and infrequent, and the notice stays honest. We will not disguise the extension's hooks as native browser code.
- **Store review:** Chrome may delay or question the extension's site access. Testers can load the public ZIP by hand until approval.
- **AI quota:** agent searches by meaning count against the owner's monthly cap, which falls back to keyword when reached.
- **Old patterns surviving:** a rebuild in place can leave dead code behind, so each stage removes what it replaces.

## Open details

These don't block the plan and will be settled in the stage named:

- The final skip window after measuring account and rate-limit behaviour (stage 2).
- Whether TikTok should later move to on by default, based on the owner's own testing (stage 2).
- The OAuth library and where tokens are stored (stage 3).
- Whether Cloudflare's deploy form still asks for Vectorize settings (stage 6).
