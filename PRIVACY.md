# Anansi privacy notice

Effective date: 14 October 2026

Anansi is an open-source, self-hosted personal library. The public Chrome
extension connects to the Anansi server URL you choose. The project maintainer
does not operate a central capture service in this edition.

## What the extension handles

When you connect and use capture/import features, the extension processes saved
post or repository identifiers, URLs, text, author information, timestamps,
available metadata and media references. GitHub imports can include private
repositories visible to your signed-in account. Saving a page or selection can
include sensitive content visible on that page. Optional Chrome bookmark
mirroring reads bookmark URLs, titles and identifiers after you grant permission.

Connection credentials, capture queues, import progress, configuration and
diagnostics are stored locally in the browser profile. The extension uses your
existing signed-in provider session to make supported requests. It does not use
the browser cookies API to read cookie values or send session cookies to Anansi.

Supported-site content scripts observe supported save actions and import
responses. General page capture uses a toolbar or context-menu gesture. Chrome
bookmark access is optional and can be disabled. The extension does not request
mandatory access to every website.

## Where data goes

Captured content is transmitted to the Anansi server you configure, using HTTPS
for hosted servers; loopback HTTP is allowed for local development. A Cloudflare
deployment stores library records in D1 and accepted media copies in R2. Local
runtime data is stored by the installation owner. The extension makes provider
requests needed to capture/import supported saves from the browser session.

Automatic tagging and semantic search are optional. When enabled, relevant saved
text is sent to Cloudflare Workers AI; semantic indexing stores text chunks in
D1 and embeddings in Vectorize. Cloudflare operates those services under its
own policies and the deployment owner's account. Hosting logs can include
request metadata. Owners control their Cloudflare logging and retention settings.

Anansi's current source includes no third-party advertising or analytics SDK.
Captured library content is not sent to the project maintainer by the extension.
If you connect to another person's deployment, that operator can access the
library data; choose a server you control or trust.

## Your controls and retention

You can disable individual sources, disable bookmark mirroring, disconnect the
extension and disable optional AI. Disconnecting stops delivery and clears the
connection credential; it does not delete the server library. Queued captures
can remain locally for recovery. Removing the extension removes its local
browser storage. Archiving an item or removing a source save is not a promise
of permanent deletion from library history.

The deployment owner controls stored data and retention. Export provides a
logical library backup, excluding media bytes. Owners needing complete deletion
must remove the applicable library data, media and AI indexes from their own
installation, and account for backups. Disabling semantic search queues index
cleanup; remote deletion can require retry while the service is unavailable.

Browser profiles and deployment credentials need protection. The public release
package contains no owner's connection credential. Private configured builds
contain extractable credentials and must not be shared or uploaded to a store.

## Contact and changes

For general support, use the Anansi GitHub issue tracker without posting secrets
or private saved content: https://github.com/jojomensah89/anansi/issues.
Report security concerns privately using the process in SECURITY.md.
This notice must be reviewed when capture behavior or data destinations change.
