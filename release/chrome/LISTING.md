# Chrome Web Store listing draft

Name: Anansi

Short description: Save X bookmarks, Reddit saves, GitHub stars, TikTok favorites and web pages to your own Anansi library.

Category: Productivity (proposed; owner selects the available dashboard category).

## Full description

Anansi connects Chrome to a personal library hosted in your own Cloudflare account. Deploy your server first, then use Connect extension in the library and paste the single-use code into the popup. A capture key can also be entered manually.

Capture X bookmarks, Reddit saves, GitHub stars and TikTok favorites from signed-in browser sessions. Save a web page or selection from the toolbar or context menu. Chrome bookmark mirroring is optional. The popup has separate source switches; TikTok is opt-in and imports use a focused window. Platform behavior can change; capture is best effort.

Opening the library requests a check for saves made elsewhere. Browser-based checks need your signed-in desktop browser running. Search and organize your library in the web app. Compatible agents connect through OAuth or named API keys: eight read tools, with four optional owner-granted tools for tags, notes and saving links. Agents cannot delete. AI tagging and semantic search are off by default and use your Cloudflare services only when enabled.

## Single purpose

Capture the owner's deliberately saved web references into their own searchable Anansi library.

## Required permissions

Verified against wxt.config.ts and the generated private MV3 manifest on 11 November 2026.

| Permission | Justification |
| --- | --- |
| storage | Persist connection credentials, source settings, capture queue, import progress and recovery state in the browser. |
| tabs | Locate provider tabs, manage import tabs/windows and open the owner's library. |
| alarms | Schedule delivery retries, recovery and the check-in to the owner's server; not a daily platform polling timer. |
| activeTab | Grant temporary access to the page the owner explicitly chooses to save. |
| scripting | Inject page/selection capture after the owner's gesture. |
| contextMenus | Offer Save page and Save selection actions. |

Optional permission: `bookmarks` reads and follows Chrome bookmark changes only when the owner enables mirroring; disabling returns the permission.

## Host permissions (every manifest entry)

| Host pattern | Justification |
| --- | --- |
| https://x.com/* | Observe bookmarks and import saved posts in the signed-in X page. |
| https://twitter.com/* | Same capture path on X's alternate hostname. |
| https://www.reddit.com/* | Observe saves and request the signed-in saved-items list. |
| https://old.reddit.com/* | Same support for old Reddit pages. |
| https://reddit.com/* | Same support on the bare Reddit hostname. |
| https://github.com/* | Observe star changes and import stars using the signed-in session, including visible private repositories. |
| https://www.tiktok.com/* | Observe favorites and import the rendered Favorites list in a focused window. |
| https://tiktok.com/* | Same support on TikTok's bare hostname. |

Optional hosts:

| Host pattern | Justification |
| --- | --- |
| https://*/* | Allow an arbitrary owner-hosted HTTPS deployment. Only the exact server origin chosen during connection is requested; this is not mandatory all-site access. |
| http://localhost/* | Allow the owner's loopback development server. |
| http://127.0.0.1/* | Allow IPv4 loopback development. |
| http://[::1]/* | Allow IPv6 loopback development. |

The isolated private build used a synthetic origin, `https://anansi-build.invalid/*`, which is an additional required host solely for its preconfigured server connection. It is not a public release host. Dotenv loading was disabled and synthetic credentials supplied. Do not distribute this build. Public mode omits the configured origin and credentials; verify the final public ZIP and manifest before submission.

## Data-use disclosures

Collected/processed: deliberately saved URLs, identifiers, titles/text/selections, author metadata, timestamps, media references and available saved-content metadata; optional Chrome bookmark titles/URLs/IDs. Saved content may be sensitive or include private repository information. Browser-local storage holds connection credentials, settings, diagnostics, queued captures and import progress. Authentication information is used for the owner's connection. There is no cookies API permission; platform session cookies are not uploaded to Anansi.

Captured content is delivered only to the owner's configured server, not a maintainer capture service. Hosted records use the owner's Cloudflare D1 and accepted media copies use R2. Optional AI sends relevant saved text to Workers AI and stores embeddings in Vectorize. Owner-authorized MCP clients receive requested library data. Provider requests use the existing signed-in browser session. There is no sale, advertising transfer or data-broker transfer. No third-party advertising or analytics SDK is included. This does not mean no network transmission. See PRIVACY.md for retention, export limits and owner controls.

In the dashboard, disclose website content, authentication information and any applicable personal information present in saved content. Do not claim collection of general browsing history; capture is of supported saves and explicit page gestures. Review the actual dashboard taxonomy and certify only statements that match PRIVACY.md and the final artifact.

## Owner supplies before submission

- Chrome Web Store developer account and final dashboard declarations.
- Public HTTPS privacy policy URL serving PRIVACY.md.
- Actual Chrome screenshots: connection, source switches, explicit capture and populated synthetic library.
- Promo tile and any other required artwork in the dashboard's current dimensions.
- An isolated reviewer deployment, private reviewer connection instructions and synthetic content.
- Signed-in acceptance results from release/side-by-side-test.md and final public artifact validation.

Draft only. No submission or publication is authorized by this file.
