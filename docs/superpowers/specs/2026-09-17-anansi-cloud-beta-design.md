# Anansi Cloud Beta Design

- Status: Proposed — user review pending
- Date: 2026-09-17
- Scope: A narrow paid hosted beta for one-person Anansi libraries

## 1. Decision summary

Anansi Cloud Beta will be a shared, multi-tenant hosted service built on the
existing Anansi web Worker, D1, R2, extension, and read-only MCP surfaces.
It will sell managed operation rather than remove functionality from the MIT
licensed OSS edition.

The beta will support one account with one default library, one account-login
method, browser-extension pairing, tenant-scoped keyword search, read-only
hosted MCP, billing, export, deletion, device revocation, and private operator
diagnostics. Semantic search, automatic tagging, teams, dedicated deployments,
and server-side social-source synchronization are deferred.

The central architectural seam is an authenticated `TenantContext` passed
through every library operation. Local installs use a stable local tenant;
Cloud accounts use real account and library identifiers. The system must never
depend on client-side filtering, deployment-wide secrets, vector ID prefixes,
or a success redirect as proof of authorization or payment.

## 2. Product contract

### OSS

Anansi OSS remains a complete self-hosted personal library:

- local SQLite operation;
- the supported browser capture sources;
- keyword search, notes, tags, collections, and export;
- local MCP;
- optional local Ollama features;
- the existing single-user Cloudflare deployment path.

The Cloud work must not add artificial feature restrictions to OSS or require
an account controlled by the Anansi operator.

### Cloud Beta

Cloud Beta provides:

- managed hosting and updates;
- one account and one default library;
- account login and revocable sessions;
- extension pairing with scoped device credentials;
- browser-session capture for X, Reddit, GitHub, and Web/Chrome bookmarks;
- tenant-scoped keyword search and library actions;
- read-only hosted MCP with per-token revocation;
- billing and webhook-backed entitlements;
- account export, deletion, and device/session management;
- private operational diagnostics, rate limits, and structured logs.

The product must describe source capture accurately: Cloud does not receive
social-network passwords or browser cookies. The user's browser session and
the extension perform supported source capture; Cloud receives bounded capture
records and processes them.

### Pricing decision

The beta offer will be a capped Founding Cloud cohort at $3.99/month or
$39/year. That is an introductory validation offer, not a permanent
public-price commitment. The beta must measure willingness to pay, direct
delivery cost, support burden, and retention before a general public price is
selected.

## 3. Explicit non-goals

The beta will not include:

- teams, organizations, shared libraries, RBAC, SSO, or SCIM;
- one Cloudflare deployment per customer;
- server-held social credentials, cookies, or platform passwords;
- server-side background synchronization that works while the user's browser
  and extension are unavailable;
- semantic MCP search or MCP write tools;
- automatic tagging or hosted semantic search as a required launch feature;
- mobile applications;
- a connector marketplace or social features;
- a formal uptime SLA or enterprise support promise.

## 4. Current baseline and constraints

The current repository is intentionally single-tenant. The schema has no
`user_id`, the item uniqueness key is global, and several supporting tables are
global as well. The current HTTP and MCP paths use deployment-wide library,
ingest, and MCP secrets. The private extension currently receives its ingest
credential at build time.

The current Cloudflare path is wired as one Worker, D1, R2 bucket, Workers AI
binding, Vectorize index, and scheduled recovery. It uses D1-backed durable
jobs and `waitUntil`/cron processing rather than Cloudflare Queues. The hosted
path, provider behavior, and clean-account migration are release gates, not
assumptions.

The current Vectorize adapter does not apply a tenant metadata filter. A
multi-tenant implementation must add that capability before Cloud Beta data is
accepted. The current export is a logical library export and restore is
restricted to an empty library; neither is sufficient by itself for a managed
backup promise.

The existing UI typecheck blocker must be resolved before treating the Cloud
branch as a release candidate. Unrelated cleanup is out of scope.

## 5. Identity and tenant model

### Account identity

The first Cloud login method will be Google OAuth. The account record stores:

- stable internal user ID;
- provider and provider subject ID;
- verified email and display name;
- creation and update timestamps;
- disabled/deleted state.

The OAuth flow must use state, PKCE where supported, a fixed callback allowlist,
short-lived authorization codes, and rate limits. Provider identity is only
used to establish the Anansi account; it does not grant access to source
platform data.

### Sessions

Cloud browser sessions use random opaque values. Store only a verification
hash and session metadata in D1:

- session ID and user ID;
- created, last-used, and expiry timestamps;
- revoked timestamp;
- user-agent/device description where safe.

Use an HttpOnly, Secure, SameSite cookie on HTTPS. Mutating cookie-authenticated
requests require same-origin/origin validation or an equivalent CSRF defence.
Bearer credentials remain reserved for device and MCP access.

### Tenant context

Every authenticated request resolves to:

```ts
type TenantContext = {
  userId: string;
  libraryId: string;
  authKind: "browser" | "device" | "mcp";
  subjectId: string;
  scopes: readonly string[];
};
```

The context is resolved once at the HTTP/MCP boundary and passed to database
operations. Database functions must require the context for user-owned work;
they must not accept an unscoped item ID, tag ID, collection ID, job ID, or
media key from a caller.

Local mode uses a stable pseudo-user and default library internally so the
shared query contract remains testable without Cloud account authentication.

## 6. Data model and isolation

Add account, identity, session, library, device, MCP credential, subscription,
and billing-event tables. Add ownership to every existing user-owned table,
including:

- items and source links;
- media and media jobs;
- tags, item tags, and tag overrides;
- highlights and collections;
- source settings and AI settings;
- AI enrichment jobs and item embeddings;
- extension clients and sync/import state.

Use `library_id` as the primary library boundary. Where a direct user-owned
record has no library parent, also store `user_id` and enforce consistency.
The item identity constraint becomes `(library_id, source, external_id)`.

All reads, updates, deletes, joins, exports, and counts must include the tenant
boundary. Direct-object routes must verify ownership before returning a 404 or
object response. A request must not reveal whether an object exists in another
tenant.

### Vector isolation

Every vector is stored with metadata containing at least `libraryId` and
`itemId`. Vector queries require a server-generated library filter. The
Vectorize adapter must expose the filter in its typed interface and fail closed
if a filtered query cannot be issued.

The database hydration step must repeat the tenant predicate. Vector filtering
and D1 filtering are both required; one is not a substitute for the other.
Tenant-isolation tests must include a semantically similar item in another
library.

### R2 isolation

Use keys such as:

```text
libraries/{libraryId}/items/{itemId}/media/{mediaId}
libraries/{libraryId}/exports/{exportId}.json
```

R2 objects remain private. Media reads verify the item and library relationship
before fetching the key. Keys from another library must return the same safe
not-found response as an unknown key.

## 7. Extension pairing and capture

The public extension contains only the Cloud API origin and public metadata.
It contains no shared ingest secret.

Pairing flow:

1. The extension generates a random state and short-lived pairing challenge.
2. It opens the Cloud authorization page using a browser-supported extension
   redirect flow.
3. The user signs in, reviews the requested device name and scopes, and
   approves the device.
4. Cloud exchanges the one-time authorization code for a random device token.
5. The extension stores the token in extension-controlled storage and clears
   the pairing material.

The raw device token is never stored by Cloud after issuance. Store its hash,
prefix, device name, scopes, created/last-used timestamps, expiry if used, and
revoked timestamp. Initial scopes are:

```text
items:read
items:write
sync:write
device:self
```

The ingest endpoint resolves the device token to a library before parsing or
mutating a capture. Idempotency remains keyed by the capture event, but the
receipt and resulting item must be tenant-scoped.

The extension must retain its existing queue, retry, cursor, and provider
session boundaries. A missing source session is a visible retryable state, not
an authorization failure for the Cloud account.

## 8. Search and MCP

Keyword FTS is the required Cloud Beta search path. Existing filters,
pagination, visibility, and bounded result projections remain shared wherever
possible, with `TenantContext` added to the database calls.

Hosted MCP remains stateless and read-only for the beta. Each MCP credential is
created from the authenticated settings page, displayed once, hashed at rest,
scoped to one library, and independently revocable. The MCP server resolves
the credential before constructing the shared Anansi tool server. All four
current read tools remain tenant-scoped and bounded.

The HTTP MCP acceptance test must include the required streamable HTTP `Accept`
header, wrong-token rejection, token revocation, initialize, tool discovery,
search, retrieval, and cross-tenant denial.

Semantic search remains an opt-in experiment after the keyword path is stable.
It must not be advertised as an MCP capability in this beta.

## 9. Billing and entitlements

Use a Merchant of Record checkout, initially Polar, with monthly and annual
products. The browser success page is informational only. Cloud access changes
only after a verified provider webhook or an explicitly reconciled provider
state.

Persist:

- internal user ID;
- provider customer and subscription IDs;
- product/price identifier;
- normalized state;
- current period end;
- created/updated timestamps;
- last provider event and reconciliation time.

Handle the provider's documented subscription and payment events through a
signature-verified, idempotent webhook handler. Store event IDs and payload
hashes. Duplicate events must produce the same state. Unknown or conflicting
events must be retained for operator review and must not grant new access.

Entitlement behavior:

```text
active       -> normal read/write Cloud access
past_due     -> normal access during a bounded grace period
cancelled    -> access until current period end
expired      -> read-only access plus export/deletion
unknown      -> preserve data; fail closed for new paid-only capacity
```

The billing layer must not be imported into local OSS runtime code merely to
represent a no-op provider. Cloud entitlement checks belong at the hosted
identity boundary.

## 10. Processing, quotas, and operations

For the beta, retain D1-backed durable jobs and scheduled bounded processing.
Do not add Queues until measured backlog, fairness, or retry volume requires
them. Each job must include library/user ownership, idempotency identity,
attempt count, lease, next-run time, safe error, and terminal/retryable state.

AI features are disabled by default. If enabled for a beta cohort, enforce
per-library quotas and record embeddings, tagging calls, MCP calls, item count,
storage, and failed work. AI or Vectorize provider failures must leave keyword
search and ingest usable.

Before public paid launch, add:

- request IDs and structured logs;
- PII/content redaction review;
- rate limits by account, device, MCP credential, endpoint, and IP where useful;
- billing webhook diagnostics;
- failed-job and source-health views for the operator;
- alerting for authentication, ingest, billing, and recovery failures;
- a private admin view with no arbitrary cross-tenant mutation by default.

## 11. Export, deletion, and recovery

Account export must contain all owned structured records and clearly identify
media objects, source URLs, and fields that are not portable. A Cloud export
must never include another tenant's tags, collections, jobs, or media.

Account deletion is an authenticated, explicit, confirmed operation. It
revokes sessions, devices, and MCP credentials, removes owned D1 records,
deletes owned R2 objects, deletes owned vectors, and records a non-sensitive
completion audit event. A documented short retention window may be used for
fraud, billing, or legal records, but it must not silently retain library
content.

The beta backup promise is limited to a tested recovery process:

- scheduled private logical snapshots of account data;
- retention and failure monitoring;
- media-object coverage or an explicit limitation;
- restore into an isolated staging library/account;
- a repeatable restore drill before launch and after migration changes.

An export download is not itself proof that managed backup and restoration
work.

## 12. Migration strategy

Use additive, expand/backfill/contract migrations.

1. Add account/library ownership columns and new identity tables.
2. Backfill the local database to a stable local user and default library.
3. Update shared queries and writers to require `TenantContext`.
4. Add composite uniqueness and tenant indexes after backfill validation.
5. Add tenant-aware vector and R2 projection changes.
6. Remove or reject unscoped paths only after all callers are migrated.

The local migration must preserve existing item IDs, source identity, archive
state, tags, collections, and media metadata. The Cloud migration must be
tested against a clean D1 stage and a representative imported library. Never
use `db:push`; commit each generated migration and preserve applied history.

## 13. Verification and release gates

### Automated

- two-tenant database tests for every user-owned operation;
- direct-ID, pagination, filter, export, deletion, and count isolation tests;
- vector filtered-query and cross-tenant hydration tests;
- R2 key/ownership tests;
- browser-session CSRF and session-revocation tests;
- device and MCP token hashing, scope, rotation, and revocation tests;
- billing webhook signature, duplicate, ordering, and unknown-event tests;
- job idempotency, retry, lease, and deletion tests;
- migration tests for empty and populated local libraries;
- focused typecheck, build, test, and `git diff --check`.

### Live staging

Before charging a real customer, use an isolated staging stage and two test
accounts to demonstrate:

1. Google login and session revocation.
2. Extension install, pairing, first capture, retry, and device revocation.
3. Identical external IDs in two libraries remain isolated.
4. Keyword search and every library mutation remain isolated.
5. Vector search cannot return or hydrate another library's item.
6. Media reads cannot cross libraries.
7. MCP wrong-token, initialize, tool calls, and revocation behave correctly.
8. Export, deletion, backup, and restore complete without cross-tenant data.
9. Provider sandbox checkout and real webhook activation behave correctly.
10. AI remains disabled or visibly degraded without breaking core search.

The current Cloudflare deployment is not considered accepted until these live
results are recorded. Local tests, workerd, builds, and Alchemy dry runs are
supporting evidence only.

## 14. Delivery sequence

### Phase 0 — release baseline

Resolve the existing typecheck blocker, preserve unrelated work, establish a
clean branch, and complete a clean-account staging deployment of the current
single-tenant path. Record current provider and migration behavior before
changing the schema.

### Phase 1 — tenant foundation

Implement the local pseudo-tenant migration, account/library ownership,
tenant-aware query signatures, composite uniqueness, tenant indexes, and
two-tenant tests. Do not expose the service publicly yet.

### Phase 2 — identity and devices

Implement Google OAuth, D1-backed sessions, pairing, device tokens, scopes,
rotation, revocation, and tenant-aware ingest/config routes. Test with the
public extension build path.

### Phase 3 — hosted library and MCP

Migrate keyword search, library mutations, export/deletion, media, and
read-only MCP. Add vector metadata filtering even if semantic search remains
disabled so the future path cannot bypass the tenant contract.

### Phase 4 — billing and operations

Add Polar products, webhook state, entitlement checks, grace/read-only
behavior, reconciliation, admin diagnostics, rate limits, logs, and backup
drills. Keep the billing success redirect non-authoritative.

### Phase 5 — private beta

Onboard 10–20 users manually. Measure pairing completion, first-value time,
source import success, weekly usage, MCP usage, support time, storage, AI cost,
and account deletion/export success. Keep the beta quiet while state is
unchanged; fix provider and recovery failures before increasing access.

### Phase 6 — optional AI expansion

Only after the core beta is stable, validate hosted semantic search and tagging
with explicit per-user budgets, provider acceptance, and a separate decision
about whether semantic search belongs in the paid promise.

## 15. Continuation gates

Do not move from private beta to public paid launch until:

- tenant isolation has passed automated and live tests;
- extension pairing and at least the visible supported sources work on real
  browsers;
- export, deletion, and restore have been demonstrated;
- billing activation, cancellation, grace, and expiry are observed through
  provider callbacks;
- direct delivery cost and support burden are measured;
- a meaningful beta cohort repeatedly uses search or MCP;
- the operator can diagnose failed imports, jobs, payments, and accounts;
- terms, privacy, retention, refund, and acceptable-use documents match the
  actual service and data flows.

Until these gates pass, Cloud Beta remains a controlled validation project,
not a reliability or unlimited-hosting promise.
