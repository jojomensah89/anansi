import { retirePreviousConnection, connectLibrary } from "../lib/library-connect.ts";
import { isLibrarySyncCommand } from "../lib/messages.ts";
/**
 * The background worker: the only part of the extension that knows a server
 * exists, and the only part that holds the token.
 *
 * Coordinates session imports, page observers, and durable delivery. GitHub
 * HTML is reduced to repository records locally; JSON source payloads are
 * normalized by the server. Session credentials stay in the browser.
 */

import type {
	CaptureQueueStatus,
	ExtensionRemoteConfig,
	ExtensionSourceConfig,
	HeartbeatSourceState,
	NormalizedItem,
	RawPageCapture,
	ShippedCaptureSource,
} from "@anansi/sources";
import {
	EXTENSION_PLATFORM_SOURCES,
	isExtensionPlatformSource,
	parseExtensionConfig,
	SHIPPED_CAPTURE_SOURCES,
} from "@anansi/sources";
import { type CaptureQueue, createCaptureQueue } from "../lib/capture-queue.ts";
import { createQueueDestinationGuard } from "../lib/connection-lifecycle.ts";
import {
	type BookmarkNode,
	importCaptures,
	removalCaptures,
	toBookmarkCapture,
} from "../lib/chrome-bookmarks.ts";
import { cachedForServer, createPersistedConfigCache, type ServerCache } from "../lib/config-cache.ts";
import { saveExtensionConnection, getExtensionConnection } from "../lib/connection.ts";
import {
	createHeartbeatClient,
	type HeartbeatClient,
} from "../lib/heartbeat.ts";
import {
	createIndexedDbOutbox,
	type IndexedDbOutbox,
} from "../lib/idb-outbox.ts";
import { initialImportSources, runImportAll } from "../lib/import-all.ts";
import {
	createIngestTransport,
	safeHttpErrorDetail,
} from "../lib/ingest-transport.ts";
import {
	MESSAGE_PROTOCOL_VERSION,
	type PageEventMessage,
	type PlatformSource,
	type PopupCommandMessage,
	parseExtensionMessage,
} from "../lib/messages.ts";
import {
	capturablePage,
	type PageDetails,
	readPage,
	toWebCapture,
	UNSUPPORTED_MESSAGES,
} from "../lib/page-capture.ts";
import { createLiveCapture } from "../lib/live-capture.ts";
import { captureAdapter, isSessionCaptureSource, platformCanonicalUrl, platformEntryUrl, platformTabPatterns, shouldRefreshTopOnResume } from "../lib/platforms/registry.ts";
import { createDocumentNonces } from "../lib/document-nonces.ts";
import { importWindowBounds, importTabPresentation, needsFullWindowImport } from "../lib/import-window.ts";
import { createRunDeadlines } from "../lib/run-deadline.ts";
import { SAVE_CONFIRMATION_SETTING } from "../lib/save-toast.ts";
import {
	nativeHandoffStorageKey,
	parseNativeHandoffStoreRequest,
} from "../lib/native-handoff.ts";
import { createLibrarySync, isLibraryPage } from "../lib/library-sync.ts";
import {
	SYNC_ALARM,
	scheduleEarliestAlarm,
	scheduleOutboxRetry,
} from "../lib/schedule.ts";
import {
	runSessionImport,
	SessionImportError,
	type SessionSource,
} from "../lib/session-import.ts";
import {
	createSourceImportLifecycle,
	type SourceImportEffect,
	type SourceImportLifecycle,
	SourceImportLifecycleError,
	type SourceImportPage,
} from "../lib/source-import-lifecycle.ts";
import {
	type CaptureSource,
	captureDeliveryMode,
	createSourceRuns,
	type SourceRuns,
} from "../lib/source-runs.ts";

export interface Settings {
	server: string;
	token: string;
}

export type SourceConfig = ExtensionSourceConfig;
export type RemoteConfig = ExtensionRemoteConfig;

export interface SourceStatus {
	/**
	 * When the current run began, or null when nothing is running.
	 *
	 * The popup decides staleness from this rather than trusting a timer here:
	 * MV3 kills an idle service worker after about thirty seconds, so a
	 * setTimeout watchdog in this file usually never fires — which is exactly
	 * how "running…" got written to storage and stayed there forever.
	 */
	startedAt: number | null;
	lastRun: number | null;
	pages: number;
	items: number;
	uploaded: number;
	failed: number;
	message: string | null;
}

export type Status = Record<string, SourceStatus>;

const CONFIG_TTL_MS = 60 * 60 * 1000;
const OUTBOX_ALARM = "anansi-outbox";
const HEARTBEAT_ALARM = "anansi-heartbeat";
const SOURCE_RUN_RECOVERY_ALARM_PREFIX = "anansi-source-run-recovery:";
/** Long enough to sit out TikTok's rate limit between two pages. */
const OBSERVED_RUN_STALL_MS = 150_000;
const PAGE_RUN_STALL_MS = 180_000;
const runDeadlines = createRunDeadlines<ReturnType<typeof setTimeout>>({
	schedule: (run, ms) => setTimeout(run, ms),
	cancel: (timer) => clearTimeout(timer),
});
const CAPTURE_SOURCES = EXTENSION_PLATFORM_SOURCES;
const HEARTBEAT_SOURCES = SHIPPED_CAPTURE_SOURCES;
const documentNonces = createDocumentNonces();
const identifiedPageRuns = new Map<string, string>();

let cached: ServerCache<RemoteConfig> | null = null;
let cachedToken: string | null = null;
const persistedConfig = createPersistedConfigCache<RemoteConfig>({
	storage: {
		get: (key) => browser.storage.local.get(key),
		set: (values) => browser.storage.local.set(values),
		remove: (key) => browser.storage.local.remove(key),
	},
	validate: (value) => {
		const parsed = parseExtensionConfig(value);
		return parsed.ok ? parsed.config : null;
	},
});
let persistent: { outbox: IndexedDbOutbox; runs: SourceRuns } | null = null;
let durableQueue: CaptureQueue | null = null;
let destinationGuard: ReturnType<typeof createQueueDestinationGuard> | null = null;
let healthHeartbeat: HeartbeatClient | null = null;
const sessionImports = new Map<
	SessionSource,
	{ controller: AbortController; task: Promise<void>; runId: string }
>();
let importLifecycle: SourceImportLifecycle | null = null;

function persistentState(): { outbox: IndexedDbOutbox; runs: SourceRuns } {
	if (persistent) return persistent;
	const outbox = createIndexedDbOutbox();
	persistent = {
		outbox,
		runs: createSourceRuns({
			store: outbox,
			now: Date.now,
			createId: () => crypto.randomUUID(),
		}),
	};
	return persistent;
}

async function settings(): Promise<Settings | null> {
	const conn = await getExtensionConnection();
	if (!conn) return null;
	return { server: conn.origin, token: conn.token };
}

async function patchStatus(
	source: string,
	patch: Partial<SourceStatus>,
): Promise<void> {
	const all = ((await browser.storage.local.get("status")).status ??
		{}) as Status;
	const current = all[source] ?? {
		startedAt: null,
		lastRun: null,
		pages: 0,
		items: 0,
		uploaded: 0,
		failed: 0,
		message: null,
	};
	await browser.storage.local.set({
		status: { ...all, [source]: { ...current, ...patch } },
	});
	requestHeartbeat();
}

async function readStatus(source: string): Promise<SourceStatus> {
	const all = ((await browser.storage.local.get("status")).status ??
		{}) as Status;
	return (
		all[source] ?? {
			startedAt: null,
			lastRun: null,
			pages: 0,
			items: 0,
			uploaded: 0,
			failed: 0,
			message: null,
		}
	);
}

/** Status writes from an import must not outlive the run that produced them. */
async function patchStatusForRun(
	source: CaptureSource,
	runId: string,
	patch: Partial<SourceStatus>,
): Promise<boolean> {
	return persistentState().runs.runIfCurrent(source, runId, async () => {
		await patchStatus(source, patch);
	});
}

/**
 * Revalidated hourly rather than fetched per run, and the kill switch: a
 * source switched off in the web app simply stops appearing here, so capture
 * for it stops on the next run without anyone updating anything.
 */
async function loadConfig(force = false): Promise<RemoteConfig | null> {
	const s = await settings();
	if (!s) return null;
	if (cachedToken !== s.token) {
		cached = null;
		cachedToken = s.token;
	}
	const now = Date.now();
	if (!cached) {
		cached = await persistedConfig.load(s.server, s.token, now).catch(() => null);
	}
	const fresh = cachedForServer(cached, s.server, now, CONFIG_TTL_MS);
	if (!force && fresh) return fresh;

	const url = `${s.server}/api/extension/config`;
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${s.token}` },
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
		if (res.status === 401 || res.status === 403) {
			cached = null;
			await persistedConfig.clear(s.server, s.token);
		}
		if (res.status === 404) {
			throw new Error(
				`404 at ${url} — is an older Anansi server still on that port?`,
			);
		}
		if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
		const parsed = parseExtensionConfig(await res.json());
		if (!parsed.ok) {
			throw new Error(`invalid extension config: ${parsed.error.message}`);
		}
		cached = { serverOrigin: s.server, at: Date.now(), value: parsed.config };
		await persistedConfig.save(s.server, s.token, parsed.config, cached.at).catch(() => {});
		await patchStatus("_", { message: null });
		return parsed.config;
	} catch (err) {
		await patchStatus("_", { message: (err as Error).message });
		return cachedForServer(cached, s.server, Date.now(), CONFIG_TTL_MS, true);
	}
}

function isCaptureSource(source: string): source is CaptureSource {
	return isExtensionPlatformSource(source);
}

function queue(): CaptureQueue {
	if (durableQueue) return durableQueue;
	const { outbox } = persistentState();
	destinationGuard = createQueueDestinationGuard({
		storage: {
			get: (key) => browser.storage.local.get(key),
			set: (values) => browser.storage.local.set(values),
			remove: (key) => browser.storage.local.remove(key),
		},
		listRecords: () => outbox.list(),
		hasPendingWork: async () => {
			const durable = await browser.storage.local.get(null);
			if (Object.keys(durable).some((key) => key.startsWith("native-handoff:"))) return true;
			for (const source of EXTENSION_PLATFORM_SOURCES) {
				if ((await liveCapture().pending(source)).length > 0) return true;
				if ((await persistentState().runs.current(source)).phase === "running") return true;
			}
			return false;
		},
		getOrigin: async () => (await settings())?.server ?? null,
		getProvenOrigin: async () => {
			const stored = await browser.storage.local.get("anansiAuthorizedOrigin");
			return typeof stored.anansiAuthorizedOrigin === "string" ? stored.anansiAuthorizedOrigin : null;
		},
	});
	const underlying = createCaptureQueue({
		store: outbox,
		transport: createIngestTransport(async (record) => {
			const [s, config] = await Promise.all([settings(), loadConfig()]);
			return s && config && destinationGuard && await destinationGuard.canDeliver() && (!isCaptureSource(record.source) || nativeDeliveryEnabled(record.source, config))
				? { ingest: config.ingest, token: s.token } : null;
		}),
		clock: { now: Date.now },
		random: Math.random,
		scheduler: {
			async schedule(at) {
				if (!(await settings()) || !(await destinationGuard!.canDeliver())) return;
				return scheduleEarliestAlarm(browser.alarms, OUTBOX_ALARM, Math.max(Date.now() + 100, at));
			},
		},
	});
	durableQueue = {
		hasImportRoom: () => underlying.hasImportRoom(),
		async enqueue(capture) {
			const admission = await destinationGuard!.beginEnqueue();
			if (!admission.ok) throw new Error(admission.error);
			try {
				return await underlying.enqueue(capture);
			} catch (error) {
				await destinationGuard!.clearIfEmpty();
				throw error;
			} finally {
				await admission.release();
			}
		},
		async getStatus() {
			const status = await underlying.getStatus();
			await destinationGuard!.clearIfEmpty();
			return status;
		},
		async retry(request) {
			if (!(await destinationGuard!.canDeliver())) return underlying.getStatus();
			const status = await underlying.retry(request);
			await destinationGuard!.clearIfEmpty();
			return status;
		},
	};
	return durableQueue;
}

/**
 * Counts, read at the moment they are asked for.
 *
 * There is deliberately no cached copy in storage any more. A second place to
 * look is a second thing that can be stale, and a stale count is exactly the
 * failure this whole pass exists to remove.
 */
async function publishQueueStatus(): Promise<CaptureQueueStatus> {
	await queue().getStatus(); // Recover interrupted uploads before counting.
	const counts = await queueBySource();
	return Object.values(counts).reduce((total, source) => ({
		queued: total.queued + source.queued, uploading: total.uploading + source.uploading,
		retrying: total.retrying + source.retrying, failed: total.failed + source.failed,
	}), { queued: 0, uploading: 0, retrying: 0, failed: 0 });
}

function heartbeat(): HeartbeatClient {
	if (healthHeartbeat) return healthHeartbeat;
	healthHeartbeat = createHeartbeatClient({
		storage: {
			async get(key) {
				return (await browser.storage.local.get(key))[key];
			},
			set: (values) => browser.storage.local.set(values),
		},
		version: browser.runtime.getManifest().version,
		createId: () => crypto.randomUUID(),
		now: () => Math.floor(Date.now() / 1000),
		async readState() {
			const snapshot = await durableSnapshot();
			const sources: Partial<
				Record<ShippedCaptureSource, HeartbeatSourceState>
			> = {};
			for (const source of HEARTBEAT_SOURCES) {
				const run = snapshot.runs[source];
				const counts = snapshot.bySource[source] ?? EMPTY_COUNTS;
				sources[source] = {
					phase: run?.phase ?? "idle",
          lastCheckedAt: Math.floor(Number(((await browser.storage.local.get("syncLastChecks")).syncLastChecks as Record<string, number> | undefined)?.[source] ?? 0) / 1000),
					...(run?.paused ? { paused: true } : {}),
					...(run?.lastErrorCode ? { lastErrorCode: run.lastErrorCode } : {}),
					...counts,
				};
			}
			return { queue: snapshot.queue, sources };
		},
		async transport(payload) {
			const current = await settings();
			if (!current) throw new Error("extension is not configured");
			const response = await fetch(
				`${current.server}/api/extension/heartbeat`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${current.token}`,
					},
					body: JSON.stringify(payload),
				},
			);
			if (!response.ok) throw new Error("heartbeat rejected");
			const answer = (await response.json().catch(() => null)) as { syncRequestedAt?: unknown; platformSync?: unknown } | null;
			void (answer?.platformSync ? librarySync().platformRequests(answer.platformSync) : librarySync().serverRequest(answer?.syncRequestedAt)).catch(() => {});
			// The server answered, so captures waiting out an outage need not wait
			// up to an hour for their next attempt.
			void queue()
				.getStatus()
				.then((status) => (status.retrying > 0 ? queue().retry({ resetBackoff: true }) : undefined))
				.catch(() => {});
		},
	});
	return healthHeartbeat;
}

let syncRunner: ReturnType<typeof createLibrarySync> | null = null;
function librarySync() {
	syncRunner ??= createLibrarySync({
		storage: {
			get: async (key) => (await browser.storage.local.get(key))[key],
			set: (values) => browser.storage.local.set(values),
		},
		now: Date.now,
		enabledSources: async () => {
			const config = await loadConfig();
			return config?.enabled ? config.sources.map((entry) => entry.source) : [];
		},
		start: (source) => startCapture(source, true, true),
	});
	return syncRunner;
}

function requestHeartbeat(): void {
	void heartbeat().send();
}

async function wakeDurableQueue(
	includeFailed = false,
	source?: CaptureSource,
): Promise<CaptureQueueStatus> {
	if (!(await settings()) || !(await queueDestination().canDeliver())) {
		return queue().getStatus();
	}
	await recoverNativeHandoffs();
	await Promise.all(
		EXTENSION_PLATFORM_SOURCES.map((platform) => flushPendingSaves(platform)),
	);
	const status = await queue().retry(
		includeFailed
			? { includeFailed: true, ...(source ? { source } : {}) }
			: undefined,
	);
	if (await queue().hasImportRoom()) {
		await Promise.all(
			CAPTURE_SOURCES.map((platform) => persistentState().runs.clearError(platform, "queue_full")),
		);
	}
	requestHeartbeat();
	return status;
}

function queueDestination() {
	queue();
	return destinationGuard!;
}

/** Legacy direct upload, kept only while a source's captureV2 flag is off. */
async function legacyUpload(source: string, raw: unknown): Promise<boolean> {
	const [s, config] = await Promise.all([settings(), loadConfig()]);
	if (!s || !config) return false;

	try {
		const res = await fetch(config.ingest, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${s.token}`,
			},
			body: JSON.stringify({ source, raw }),
		});
		const current = await readStatus(source);
		if (res.ok) {
			await patchStatus(source, {
				uploaded: current.uploaded + 1,
				message: null,
			});
			return true;
		}
		// 422 is the server's zero-parse alarm. It means the payload shape
		// changed, and it must be visible rather than swallowed.
		const detail = await safeHttpErrorDetail(res);
		await patchStatus(source, {
			failed: current.failed + 1,
			message: `ingest ${res.status}${detail ? `: ${detail}` : ""}`,
		});
		return false;
	} catch (err) {
		const current = await readStatus(source);
		await patchStatus(source, {
			failed: current.failed + 1,
			message: (err as Error).message,
		});
		return false;
	}
}

/** Queue adapter used by the lifecycle; resolving is the durable page receipt. */
async function enqueueImportedPage(page: SourceImportPage): Promise<void> {
	const config = await loadConfig();
	const delivery = captureDeliveryMode(
		config?.ingestProtocolVersion,
		config?.features?.captureV2,
		page.source,
	);
	if (delivery === "legacy") {
		if (!(await legacyUpload(page.source, page.raw))) {
			throw new Error("legacy ingest rejected the capture");
		}
		return;
	}
	const capture: RawPageCapture = {
		schemaVersion: 1,
		payloadType: "raw_page",
		eventId: page.eventId,
		source: page.source,
		action: "snapshot",
		observedAt: Math.floor(Date.now() / 1000),
		captureMethod: page.captureMethod,
		runId: page.runId,
		page: page.page,
		...(page.cursor ? { cursor: page.cursor } : {}),
		raw: page.raw,
	};
	if (page.source !== "web") await hydrateNativeCaptures(page.source, page.raw);
	await queue().enqueue(capture);
	await wakeDurableQueue().catch(() => {});
}

function sourceImportLifecycle(): SourceImportLifecycle {
	if (importLifecycle) return importLifecycle;
	const { runs } = persistentState();
	importLifecycle = createSourceImportLifecycle({
		runs,
		enqueuePage: enqueueImportedPage,
		flushPendingSaves,
		isEnabled: async (source) => {
			const config = await loadConfig(true);
			return Boolean(
				config?.enabled &&
					config.sources.some((entry) => entry.source === source),
			);
		},
	});
	return importLifecycle;
}

async function applyImportEffects(
	effects: SourceImportEffect[],
): Promise<void> {
	const runs = persistentState().runs;
	for (const effect of effects) {
		if (effect.kind === "schedule-recovery") {
			await runs.runIfCurrent(effect.source, effect.runId, async (run) => {
				if (run.phase !== "running") return;
				browser.alarms.create(sourceRunRecoveryAlarm(effect.source), {
					when: effect.at,
				});
			});
		} else if (effect.kind === "clear-recovery") {
			await runs.runIfCurrent(effect.source, effect.runId, async () => {
				await clearSourceRunRecovery(effect.source);
			});
		} else if (effect.kind === "close-owned-tab") {
			// takeOwnedTabForRun is itself fenced and consumes the ownership before
			// the browser call. A stale close can therefore only release the tab
			// recorded for its own run (or its persisted orphan), never a replacement.
			await closeOwnedTab(effect.source, effect.runId, effect.expectedTabId);
		} else if (effect.kind === "process-pending-refresh") {
			// claimRefresh rechecks each source under the shared serialized tail;
			// there is no separate check whose result could go stale here.
			await processPendingRefreshes();
		} else {
			await runs.runIfCurrent(effect.source, effect.runId, async () => {
				await patchStatus(effect.source, effect.patch as Partial<SourceStatus>);
			});
		}
	}
}

/** Native events are persisted before configuration or network work. */
let nativeCaptures: ReturnType<typeof createLiveCapture> | null = null;
const NATIVE_CAPTURE_ALARM = "anansi-native-capture";
function nativeDeliveryEnabled(source: string, config: RemoteConfig): boolean {
	return isCaptureSource(source) && config.enabled &&
		config.sources.some((entry) => entry.source === source) &&
		captureDeliveryMode(config.ingestProtocolVersion, config.features?.captureV2, source) === "queue";
}
function liveCapture() {
	if (!nativeCaptures) nativeCaptures = createLiveCapture({
		store: persistentState().outbox, queue: queue(), now: Date.now,
		createId: () => crypto.randomUUID(),
		canEnqueue: async (source) => {
			const config = await loadConfig();
			return Boolean(config && nativeDeliveryEnabled(source, config));
		},
	});
	return nativeCaptures;
}

function platformUrl(source: PlatformSource, externalId: string): string {
	return platformCanonicalUrl(source, externalId);
}

function contentFromPage(source: PlatformSource, raw: unknown): NormalizedItem[] {
	try { return captureAdapter(source).parsePage(raw, Math.floor(Date.now() / 1000)); }
	catch { return []; }
}

let recoveringHandoffs: Promise<void> | null = null;
async function recoverNativeHandoffs(): Promise<void> {
	if (recoveringHandoffs) return recoveringHandoffs;
	recoveringHandoffs = (async () => {
		const stored = await browser.storage.local.get(null);
		const handoffs = Object.entries(stored).sort((a, b) =>
			Number((a[1] as { order?: number })?.order ?? 0) - Number((b[1] as { order?: number })?.order ?? 0));
		for (const [key, value] of handoffs) {
			if (!key.startsWith("native-handoff:") || !value || typeof value !== "object") continue;
			const entry = value as { message?: PageEventMessage; pageUrl?: string };
			if (typeof entry.pageUrl !== "string" || typeof entry.message?.nonce !== "string") continue;
			const parsed = parseExtensionMessage(entry.message, { path: "page-to-relay", pageUrl: entry.pageUrl, expectedNonce: entry.message.nonce });
			if (!parsed.ok || parsed.message.anansi !== "page-event" || parsed.message.action !== "bookmark") continue;
			const event = parsed.message;
			try {
				await recordNativeMutation(event.source, event.bookmarkAction, event.externalId, event.canonicalUrl,
					event.raw, event.normalizedItem, event.mutationId, event.observedAt);
				await browser.storage.local.remove(key);
			} catch { /* Keep the handoff until durable native storage accepts it. */ }
		}
	})();
	try { await recoveringHandoffs; } finally { recoveringHandoffs = null; }
}

async function reportNativePending(source: PlatformSource, state: { pending: number; needsContent: boolean }) {
	if (state.pending) {
		await patchStatus(source, { message: state.needsContent
			? "saved on the platform; fetching post content automatically"
			: "capture held on this device; delivery will retry" });
		await scheduleEarliestAlarm(browser.alarms, NATIVE_CAPTURE_ALARM, Date.now() + 30_000);
		if (state.needsContent) await persistentState().runs.requestRefresh(source);
	}
}

async function recordNativeMutation(
	source: PlatformSource, action: "save" | "unsave", externalId: string,
	canonicalUrl?: string, raw?: unknown, normalizedItem?: NormalizedItem,
	mutationId?: string, observedAt?: number,
) {
	const content = normalizedItem ?? (raw === undefined ? undefined
		: contentFromPage(source, raw).find((item) => item.externalId === externalId));
	const state = await liveCapture().record({
		source, action, externalId, canonicalUrl: canonicalUrl ?? content?.url ?? platformUrl(source, externalId),
		mutationId: mutationId ?? crypto.randomUUID(),
		observedAt: observedAt ?? Math.floor(Date.now() / 1000), normalizedItem: content,
	});
	await reportNativePending(source, state);
	await patchStatus(source, { lastRun: Date.now(), ...(state.pending ? {} : { message: null }) });
	return state;
}

async function handleBookmarkMutation(...args: Parameters<typeof recordNativeMutation>): Promise<void> {
	// A worker restart may leave an older confirmed transition in the relay's
	// persisted handoff. Admit it before this page's newly confirmed transition.
	await recoverNativeHandoffs();
	const state = await recordNativeMutation(...args);
	// Keep the runtime message alive through the immediate drain. Detached
	// work can be suspended with the worker and defer ready captures to an alarm.
	await wakeDurableQueue().catch(() => {});
	if (state.needsContent) void processPendingRefreshes().catch(() => {});
}

/** Persist relay handoffs only in this trusted worker, under a derived key. */
async function handleNativeHandoffStore(
	request: NonNullable<ReturnType<typeof parseNativeHandoffStoreRequest>>,
	sender: RuntimeMessageSender,
): Promise<BackgroundResult> {
	if (!sender.tab || !Number.isSafeInteger(sender.tab.id)) {
		return { ok: false, error: "native handoffs must come from a supported page" };
	}
	const parsed = validateRuntimeMessage(request.message, sender);
	if (
		!parsed.ok ||
		parsed.message.anansi !== "page-event" ||
		parsed.message.action !== "bookmark" ||
		!parsed.source ||
		!parsed.message.mutationId
	) {
		return { ok: false, error: "native handoff is invalid" };
	}
	const pageUrl = sender.url ?? sender.tab.url;
	const current = await settings();
	if (!pageUrl || !current) {
		return { ok: false, error: "connect to Anansi before capturing" };
	}
	const key = nativeHandoffStorageKey(parsed.source, parsed.message.mutationId);
	if (!key) return { ok: false, error: "native handoff identity is invalid" };
	const admission = await queueDestination().beginEnqueue();
	if (!admission.ok) return { ok: false, error: admission.error };
	try {
		await browser.storage.local.set({
			[key]: {
				message: parsed.message,
				pageUrl,
				order: Date.now(),
			},
		});
	} catch {
		await admission.release();
		await queueDestination().clearIfEmpty();
		return { ok: false, error: "could not persist native handoff" };
	} finally {
		await admission.release();
	}
	try {
		await recoverNativeHandoffs();
	} catch {
		// The persisted record is the durability boundary; startup/alarm recovers it.
	}
	if ((await browser.storage.local.get(key))[key] !== undefined) {
		await scheduleEarliestAlarm(browser.alarms, NATIVE_CAPTURE_ALARM, Date.now() + 30_000);
	}
	await wakeDurableQueue().catch(() => {});
	const setting = await browser.storage.local.get(SAVE_CONFIRMATION_SETTING);
	return { ok: true, confirm: setting[SAVE_CONFIRMATION_SETTING] === true };
}

/** Migrate old id-only pending saves once, then preserve their new identity. */
async function migratePendingSaves(source: PlatformSource): Promise<void> {
	const runs = persistentState().runs;
	const run = await runs.current(source);
	for (const externalId of run.pendingSaves) {
		await liveCapture().record({ source, action: "save", externalId,
			canonicalUrl: platformUrl(source, externalId), mutationId: `legacy-pending:${externalId}`,
			observedAt: Math.max(1, Math.floor(run.updatedAt / 1000)) });
		await runs.ackPendingSave(source, externalId);
	}
}

async function hydrateNativeCaptures(source: PlatformSource, raw: unknown): Promise<void> {
	await migratePendingSaves(source);
	await reportNativePending(source, await liveCapture().hydrate(source, contentFromPage(source, raw)));
}

async function flushPendingSaves(source: PlatformSource): Promise<void> {
	await migratePendingSaves(source);
	await reportNativePending(source, await liveCapture().retry(source));
}

/**
 * Save the page in one tab, right now.
 *
 * `activeTab` is what makes this possible without host permission for every
 * site, and it is also why this only ever runs from a deliberate gesture: the
 * grant arrives when you press the button or the menu item and lapses after.
 * There is no path here that reads a page you did not ask for.
 */
async function capturePage(
	tabId: number,
	method: "toolbar" | "context_menu",
	selectionText?: string,
): Promise<
	{ ok: true; delivery: "queued" | "uploaded" } | { ok: false; error: string }
> {
	const tab = await browser.tabs.get(tabId).catch(() => null);
	const supported = capturablePage(tab?.url);
	if (!supported.ok) {
		await patchStatus("web", {
			message: UNSUPPORTED_MESSAGES[supported.reason],
		});
		return { ok: false, error: UNSUPPORTED_MESSAGES[supported.reason] };
	}

	let details: PageDetails;
	try {
		const [injected] = await browser.scripting.executeScript({
			target: { tabId },
			func: readPage,
		});
		details = injected?.result as PageDetails;
		if (!details?.url) throw new Error("nothing came back");
	} catch {
		const message = "could not read that page";
		await patchStatus("web", { message });
		return { ok: false, error: message };
	}

	// The menu passes what was highlighted; it is more reliable than asking the
	// page again, because the click can clear the selection.
	const built = await toWebCapture(
		{ ...details, selection: selectionText ?? details.selection },
		{ method, observedAt: Math.floor(Date.now() / 1000) },
	);
	if (!built.ok) {
		await patchStatus("web", { message: UNSUPPORTED_MESSAGES[built.reason] });
		return { ok: false, error: UNSUPPORTED_MESSAGES[built.reason] };
	}

	await queue().enqueue(built.capture);
	await wakeDurableQueue();

	const pending = await persistentState().outbox.get(built.capture.eventId);
	const current = await readStatus("web");
	await patchStatus("web", {
		lastRun: Date.now(),
		items: current.items + 1,
		...(pending
			? { message: "saved locally; delivery will retry" }
			: { uploaded: current.uploaded + 1, message: null }),
	});
	return { ok: true, delivery: pending ? "queued" : "uploaded" };
}

type MenuSpec = Parameters<typeof browser.contextMenus.create>[0];

/* ------------------------------------------------- chrome bookmarks --- */

const MIRROR_KEY = "mirrorChromeBookmarks";
let bookmarkInstallation: Promise<string> | undefined;
function bookmarkInstallationId(): Promise<string> {
	if (bookmarkInstallation) return bookmarkInstallation;
	bookmarkInstallation = (async () => {
		const stored = await browser.storage.local.get("bookmarkInstallationId");
		if (typeof stored.bookmarkInstallationId === "string")
			return stored.bookmarkInstallationId;
		const id = crypto.randomUUID();
		await browser.storage.local.set({ bookmarkInstallationId: id });
		return id;
	})().catch((error) => {
		bookmarkInstallation = undefined;
		throw error;
	});
	return bookmarkInstallation;
}

async function mirroringOn(): Promise<boolean> {
	const stored = await browser.storage.local.get(MIRROR_KEY);
	if (stored[MIRROR_KEY] !== true) return false;
	// The setting is not the authority; the grant is. A permission revoked from
	// Chrome's own settings would otherwise leave this claiming to mirror.
	return browser.permissions
		.contains({ permissions: ["bookmarks"] })
		.catch(() => false);
}

async function enqueueBookmarks(
	captures: Awaited<ReturnType<typeof importCaptures>>,
) {
	if (captures.length === 0) return;
	let accepted = 0;
	for (const capture of captures) {
		try {
			await queue().enqueue(capture);
			accepted++;
		} catch {
			/* Report partial persistence below; never count it as saved. */
		}
	}
	await wakeDurableQueue();
	const current = await readStatus("web");
	await patchStatus("web", {
		lastRun: Date.now(),
		items: current.items + accepted,
		message:
			accepted < captures.length
				? `${captures.length - accepted} bookmarks could not be saved on this device; turn mirroring off and on to retry`
				: null,
	});
}

/**
 * Listeners exist only while the permission does.
 *
 * Registering them regardless and checking inside would mean the extension
 * asks Chrome for bookmark events it has no right to, and gets them the
 * moment someone grants the permission for something else.
 */
let bookmarkListeners: null | {
	created: Parameters<typeof browser.bookmarks.onCreated.addListener>[0];
	changed: Parameters<typeof browser.bookmarks.onChanged.addListener>[0];
	removed: Parameters<typeof browser.bookmarks.onRemoved.addListener>[0];
} = null;

async function startMirroring(): Promise<void> {
	if (bookmarkListeners || !(await mirroringOn())) return;

	const now = () => Math.floor(Date.now() / 1000);
	const options = { installationId: await bookmarkInstallationId() };

	const created = async (_id: string, node: BookmarkNode) => {
		const capture = await toBookmarkCapture(node, "save", now(), options);
		if (capture) await enqueueBookmarks([capture]);
	};

	const changed = async (
		id: string,
		info: { title?: string; url?: string },
	) => {
		// onChanged carries only what changed, so the node is read back for the
		// url — a rename with no url would otherwise identify nothing.
		const [node] = await browser.bookmarks.get(id).catch(() => []);
		if (!node) return;
		const capture = await toBookmarkCapture(
			{ ...(node as BookmarkNode), title: info.title ?? node.title },
			"save",
			now(),
			options,
		);
		if (capture) await enqueueBookmarks([capture]);
	};

	const removed = async (_id: string, info: { node: BookmarkNode }) => {
		await enqueueBookmarks(await removalCaptures(info.node, now(), options));
	};

	bookmarkListeners = {
		created: created as never,
		changed: changed as never,
		removed: removed as never,
	};
	browser.bookmarks.onCreated.addListener(bookmarkListeners.created);
	browser.bookmarks.onChanged.addListener(bookmarkListeners.changed);
	browser.bookmarks.onRemoved.addListener(bookmarkListeners.removed);
}

function stopMirroring(): void {
	if (!bookmarkListeners) return;
	browser.bookmarks.onCreated.removeListener(bookmarkListeners.created);
	browser.bookmarks.onChanged.removeListener(bookmarkListeners.changed);
	browser.bookmarks.onRemoved.removeListener(bookmarkListeners.removed);
	bookmarkListeners = null;
}

/**
 * Turning mirroring on, which is when the permission is asked for.
 *
 * Denial is not an error state: nothing else in the extension depends on
 * this, so it simply stays off and says so.
 */
async function setMirroring(on: boolean): Promise<BackgroundResult> {
	if (!on) {
		stopMirroring();
		await browser.storage.local.set({ [MIRROR_KEY]: false });
		// Handed back rather than kept for later. Items already mirrored stay:
		// the library keeps what you saved.
		await browser.permissions
			.remove({ permissions: ["bookmarks"] })
			.catch(() => false);
		await patchStatus("web", { message: null });
		return { ok: true, mirroring: false };
	}

	const granted = await browser.permissions
		.request({ permissions: ["bookmarks"] })
		.catch(() => false);
	if (!granted) {
		await browser.storage.local.set({ [MIRROR_KEY]: false });
		return {
			ok: false,
			error: "Chrome did not grant access to your bookmarks",
		};
	}

	await browser.storage.local.set({ [MIRROR_KEY]: true });
	await startMirroring();

	const tree = (await browser.bookmarks
		.getTree()
		.catch(() => [])) as BookmarkNode[];
	await enqueueBookmarks(
		await importCaptures(tree, Math.floor(Date.now() / 1000), {
			installationId: await bookmarkInstallationId(),
		}),
	);
	return { ok: true, mirroring: true };
}

const MENUS: MenuSpec[] = [
	{ id: "anansi-save-page", title: "Save page to Anansi", contexts: ["page"] },
	{
		id: "anansi-save-selection",
		title: "Save selection to Anansi",
		contexts: ["selection"],
	},
];

async function findTab(source: PlatformSource, expectedUrl?: string) {
	const patterns = platformTabPatterns(source);
	const tabs = await browser.tabs.query({ url: [...patterns] });
	return tabs.find(
		(tab) =>
			tab.url &&
			captureAdapter(source).isExpectedImportTab(tab.url) &&
			(!expectedUrl || tab.url === expectedUrl),
	);
}

/**
 * Open a tab for a source and wait for its content scripts.
 *
 * Opened inactive, so an import does not yank you out of what you were doing,
 * and closed again afterwards if we were the ones who opened it.
 */
/** Falls back to a tab, which still captures the first page of a list. */
async function openImportWindow(url: string) {
	try {
		const anchor = await browser.windows.getLastFocused().catch(() => null);
		const opened = await browser.windows.create({
			url,
			type: "popup",
			// Opened unfocused it lands behind the browser, where it counts as hidden.
			focused: true,
			...importWindowBounds(anchor),
		});
		return opened?.tabs?.[0] ?? null;
	} catch {
		return await browser.tabs.create({ url, active: false });
	}
}

async function openTab(
	source: PlatformSource,
	preferredUrl?: string,
	live = false,
): Promise<{ id: number; ours: boolean } | null> {
	const url = preferredUrl ?? platformEntryUrl(source);
	const tab = importTabPresentation(captureAdapter(source).ownsImportTab === true, live) === "window"
		? await openImportWindow(url)
		: await browser.tabs.create({ url, active: false });
	if (!tab?.id) return null;

	const id = tab.id;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(finish, 25_000);
		function finish() {
			clearTimeout(timer);
			browser.tabs.onUpdated.removeListener(onUpdated);
			// document_idle scripts land a beat after "complete".
			setTimeout(resolve, 900);
		}
		function onUpdated(tabId: number, info: { status?: string }) {
			if (tabId === id && info.status === "complete") finish();
		}
		browser.tabs.onUpdated.addListener(onUpdated);
		// A fast page can finish before the listener above was attached.
		void browser.tabs
			.get(id)
			.then((current) => {
				if (current.status === "complete" && current.url && current.url !== "about:blank") finish();
			})
			.catch(() => {});
	});

	return { id, ours: true };
}

async function waitForPageIdentity(runId: string, timeoutMs = 12_000): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const identity = identifiedPageRuns.get(runId);
		if (identity) { identifiedPageRuns.delete(runId); return identity; }
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	identifiedPageRuns.delete(runId);
	return null;
}

async function navigateTab(tabId: number, url: string): Promise<boolean> {
	try {
		await browser.tabs.update(tabId, { url });
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => { browser.tabs.onUpdated.removeListener(onUpdated); reject(new Error("page navigation timed out")); }, 25_000);
			function onUpdated(id: number, info: { status?: string }) {
				if (id !== tabId || info.status !== "complete") return;
				clearTimeout(timer);
				browser.tabs.onUpdated.removeListener(onUpdated);
				setTimeout(resolve, 900);
			}
			browser.tabs.onUpdated.addListener(onUpdated);
		});
		return true;
	} catch { return false; }
}

async function closeOwnedTab(
	source: CaptureSource,
	runId: string,
	expectedTabId?: number,
): Promise<void> {
	await persistentState().runs.closeOwnedTabForRun(
		source,
		runId,
		expectedTabId,
		async (tabId) => {
			await browser.tabs.remove(tabId).catch(() => {});
		},
	);
}

function sourceRunRecoveryAlarm(source: CaptureSource): string {
	return `${SOURCE_RUN_RECOVERY_ALARM_PREFIX}${source}`;
}

function clearSourceRunRecovery(source: CaptureSource): Promise<boolean> {
	return browser.alarms.clear(sourceRunRecoveryAlarm(source));
}

async function expireOwnedRun(
	source: CaptureSource,
	expectedTabId: number,
	runId: string,
): Promise<void> {
	const failed = await sourceImportLifecycle().fail({
		source,
		runId,
		tabId: expectedTabId,
		code: "capture_timeout",
	});
	if (failed.kind === "ignored-stale") return;
	await applyImportEffects(failed.effects);
	await patchStatusForRun(source, runId, {
		startedAt: null,
		message: "capture timed out; retry when the platform is ready",
	});
}

/**
 * Session-import adapters use credentialed worker requests; page-import
 * adapters open an inactive platform tab when they need one.
 */
/** IDs are read before any page is queued, so this run cannot stop on itself. */
async function syncKnownIds(source: string): Promise<string[]> {
  const current = await settings();
  if (!current) throw new Error("extension is not connected");
  const response = await fetch(`${current.server}/api/extension/known-ids?source=${encodeURIComponent(source)}`, {
    headers: { Authorization: `Bearer ${current.token}` }, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("could not read sync stopping points");
  const body = await response.json() as {ids?: unknown};
  if (!Array.isArray(body.ids) || body.ids.length > 2000 || body.ids.some(id => typeof id !== "string" || id.length > 200)) throw new Error("invalid stopping points");
  return body.ids as string[];
}

async function startCapture(
	source: string,
	quiet = false,
	live = false,
): Promise<void> {
	if (!isExtensionPlatformSource(source)) return;
	if (
		isSessionCaptureSource(source) &&
		sessionImports.has(source)
	)
		return;
	const begun = await sourceImportLifecycle().start(
		source,
		live ? "live" : "full",
	);
	await applyImportEffects(
		quiet && (begun.kind === "already-running" || begun.kind === "disabled")
			? begun.effects.filter((effect) => effect.kind !== "status")
			: begun.effects,
	);
	if (begun.kind !== "started") {
		if (begun.kind === "disabled") return;
		if (quiet) return;
		return;
	}
	const runId = begun.run.runId;

	const config = await loadConfig(true);
	if (!config?.enabled) {
		if (!quiet)
			await patchStatusForRun(source, runId, {
				message: "server has capture disabled",
			});
		await applyImportEffects(
			(await sourceImportLifecycle().stop(source, runId)).effects,
		);
		return;
	}

	const configuredEntry = config.sources.find((s) => s.source === source);
  let knownIds: string[] | undefined;
  if (live && configuredEntry) {
    try { knownIds = await syncKnownIds(source); }
    catch {
      await applyImportEffects((await sourceImportLifecycle().fail({source, runId, code: "platform_request_failed"})).effects);
      await patchStatusForRun(source, runId, {message: "could not read sync stopping points"});
      return;
    }
  }
  const entry = configuredEntry && live ? { ...configuredEntry, pageLimit: source === "tiktok" ? 1 : 10, knownIds: source === "tiktok" ? knownIds ?? [] : knownIds } : configuredEntry;
	if (!entry) {
		if (!quiet)
			await patchStatusForRun(source, runId, {
				message: "switched off in Sources",
			});
		await applyImportEffects(
			(await sourceImportLifecycle().stop(source, runId)).effects,
		);
		return;
	}

	if (isSessionCaptureSource(source)) {
		const controller = new AbortController();
		const task = importWithoutTab(
			source,
			runId,
			entry,
			live,
			controller.signal,
		);
		sessionImports.set(source, { controller, task, runId });
		try {
			await task;
		} finally {
			sessionImports.delete(source);
		}
		if (!controller.signal.aborted) await processPendingRefreshes();
		return;
	}

	let target: { id: number; ours: boolean } | null = null;
	// An import that navigates must not take over a tab the person is using, and
	// only a tab it opened is one it may close afterward.
	const existing = captureAdapter(source).ownsImportTab ? undefined : await findTab(source);
	if (existing?.id) target = { id: existing.id, ours: false };
	else {
		await patchStatus(source, { message: `opening ${entry.host}…` });
		target = await openTab(source, undefined, live);
	}

	if (!target) {
		await applyImportEffects(
			(
				await sourceImportLifecycle().fail({
					source,
					runId,
					code: "platform_request_failed",
				})
			).effects,
		);
		await patchStatusForRun(source, runId, {
			startedAt: null,
			message: `could not open ${entry.host}`,
		});
		return;
	}
	const tab = { id: target.id };
	// Record ownership immediately after creating our tab. If the run expires
	// while bind/configure is waiting on the page, a replacement can orphan and
	// close this exact tab instead of leaving it behind.
	if (
		target.ours &&
		!(await persistentState().runs.setOwnedTabForRun(source, runId, tab.id))
	) {
		await persistentState().runs.disposeUnclaimedTab(
			source,
			runId,
			tab.id,
			async () => {
				await browser.tabs.remove(tab.id).catch(() => {});
			},
		);
		return;
	}
	const bound = await sourceImportLifecycle().bindTab(
		source,
		runId,
		tab.id,
		false,
	);
	await applyImportEffects(bound.effects);
	if (bound.kind === "ignored-stale") return;

	if (entry.mode === "observe") {
		const configure = () =>
			talk(tab.id, {
				anansi: "page-command",
				messageVersion: MESSAGE_PROTOCOL_VERSION,
				source,
				runId,
				action: "configure",
				config: entry,
			});

		if (!(await configure())) {
			await applyImportEffects(
				(
					await sourceImportLifecycle().fail({
						source,
						runId,
						tabId: tab.id,
						code: "platform_request_failed",
					})
				).effects,
			);
			await patchStatusForRun(source, runId, {
				startedAt: null,
				message: `could not reach the ${entry.host} tab`,
			});
			return;
		}

		const preparePageImport = captureAdapter(source).preparePageImport;
		if (preparePageImport) {
			const prepared = await preparePageImport({
				setMessage: async (message) => {
					await patchStatusForRun(source, runId, { message });
				},
				identify: async () => {
					await talk(tab.id, { anansi: "page-command", messageVersion: MESSAGE_PROTOCOL_VERSION, source, runId, action: "identify", config: entry });
				},
				waitForIdentity: () => waitForPageIdentity(runId),
				currentUrl: async () => (await browser.tabs.get(tab.id).catch(() => null))?.url ?? null,
				navigate: (url) => navigateTab(tab.id, url),
				configure,
			});
			if (!prepared.ready) {
				await applyImportEffects((await sourceImportLifecycle().fail({ source, runId, tabId: tab.id, code: prepared.code })).effects);
				await patchStatusForRun(source, runId, { startedAt: null, message: prepared.message });
				return;
			}
		}

		// Nothing to request, so the capture is a scroll: the app fetches its own
		// item lists as the page grows, and those are what get kept.
		await patchStatusForRun(source, runId, {
			startedAt: begun.run.startedAt,
			pages: 0,
			items: 0,
			uploaded: 0,
			failed: 0,
			message: "scanning…",
		});
		const scanning = await talk(tab.id, {
			anansi: "page-command",
			messageVersion: MESSAGE_PROTOCOL_VERSION,
			source,
			runId,
			action: "scan",
			// Syncs use a bounded pre-run snapshot; imports may walk history.
			config: entry,
		});
		if (!scanning) {
			await applyImportEffects(
				(
					await sourceImportLifecycle().fail({
						source,
						runId,
						tabId: tab.id,
						code: "platform_request_failed",
					})
				).effects,
			);
			await patchStatusForRun(source, runId, {
				startedAt: null,
				message: `could not start the ${entry.host} scan`,
			});
			return;
		}
		if (target.ours) {
			runDeadlines.start(runId, OBSERVED_RUN_STALL_MS, () => void expireOwnedRun(source, tab.id, runId));
		}
		return;
	}

	// A sync walks at most ten pages, stopping on a pre-run known ID.

	const job = live
		? {
				...entry,
				pageLimit: 10,
				variables: { ...(entry.variables ?? {}), count: 20 },
			}
		: // A full run picks up where the last acknowledged page left off, so an
			// import interrupted at page nine does not start again at page one.
			{
				...entry,
				...(begun.run.cursor ? { resumeCursor: begun.run.cursor } : {}),
				...(shouldRefreshTopOnResume(source) && begun.run.cursor ? { refreshTop: true } : {}),
			};
	await patchStatusForRun(source, runId, {
		startedAt: begun.run.startedAt,
		pages: 0,
		items: 0,
		uploaded: 0,
		failed: 0,
		message: "running…",
	});
	const reached =
		(await talk(tab.id, {
			anansi: "page-command",
			messageVersion: MESSAGE_PROTOCOL_VERSION,
			source,
			runId,
			action: "configure",
			config: job,
		})) &&
		(await talk(tab.id, {
			anansi: "page-command",
			messageVersion: MESSAGE_PROTOCOL_VERSION,
			source,
			runId,
			action: "backfill",
			config: job,
		}));

	if (!reached) {
		await applyImportEffects(
			(
				await sourceImportLifecycle().fail({
					source,
					runId,
					tabId: tab.id,
					code: "platform_request_failed",
				})
			).effects,
		);
		await patchStatusForRun(source, runId, {
			startedAt: null,
			message: `could not reach the ${entry.host} tab; reload it and try again`,
		});
		return;
	}

	// Close a tab we opened once the run reports in, or when it stops progressing.
	if (target.ours) {
		runDeadlines.start(runId, PAGE_RUN_STALL_MS, () => void expireOwnedRun(source, tab.id, runId));
	}
}

/** Fan out the existing full-import path without creating an aggregate run. */
async function startAllCaptures(): Promise<BackgroundResult> {
	const config = await loadConfig(true);
	if (!config?.enabled) {
		return { ok: false, error: "capture disabled on server" };
	}
	const sources = await initialImportSources(config, (source) =>
		persistentState().runs.initialImportDue(source),
	);
	if (sources.length === 0) {
		return { ok: false, error: "no sources due for import" };
	}
	void runImportAll(sources, async (source) => {
		try {
			await startCapture(source, true);
		} catch (error) {
			const run = await persistentState().runs.current(source);
			if (run.phase !== "running" || !run.runId) throw error;
			const failed = await sourceImportLifecycle().fail({
				source,
				runId: run.runId,
				code: "initial_import_start_failed",
			});
			await applyImportEffects(failed.effects);
			if (failed.kind === "ignored-stale") throw error;
			await patchStatusForRun(source, run.runId, {
				startedAt: null,
				message: "capture failed to start; retry the import",
			});
		}
	});
	return { ok: true };
}

async function importWithoutTab(
	source: SessionSource,
	runId: string,
	entry: SourceConfig,
	live: boolean,
	signal: AbortSignal,
): Promise<void> {
	const runs = persistentState().runs;
	const ownsRun = async () => {
		const run = await runs.current(source);
		return !signal.aborted && run.phase === "running" && run.runId === runId;
	};
	try {
		const run = await runs.current(source);
		await patchStatusForRun(source, runId, {
			startedAt: run.startedAt,
			pages: 0,
			items: 0,
			uploaded: 0,
			failed: 0,
			message: "importing in the background…",
		});
		const result = await runSessionImport({
			source,
			cursor: run.cursor,
			pageLimit: entry.pageLimit ?? 40,
			knownIds: entry.knownIds,
			live,
			signal,
			isCurrent: async () => {
				if (!(await ownsRun())) return false;
				const config = await loadConfig(true);
				if (!(await ownsRun())) return false;
				if (
					!config?.enabled ||
					!config.sources.some((candidate) => candidate.source === source)
				) {
					const disabled = await sourceImportLifecycle().stop(source, runId);
					await applyImportEffects(disabled.effects);
					return false;
				}
				return true;
			},
			onPage: async (page, number) => {
				const accepted = await sourceImportLifecycle().page({
					source,
					runId,
					page: number,
					items: page.items,
					cursor: live ? undefined : page.cursor,
					raw: page.raw,
					captureMethod: live ? "platform_event" : "platform_import",
				});
				await applyImportEffects(accepted.effects);
				if (accepted.kind === "queue-failed") {
					const code =
						accepted.errorCode === "queue_full" ||
						accepted.errorCode === "record_too_large"
							? accepted.errorCode
							: "queue_failed";
					throw new SourceImportLifecycleError(
						code,
						"capture queue rejected the page",
					);
				}
				if (accepted.kind === "ignored-stale" || accepted.kind === "disabled") {
					throw new SourceImportLifecycleError(
						"stale_run",
						"source run is no longer current",
					);
				}
				if (accepted.kind !== "accepted-page") {
					throw new Error("source import page was not accepted");
				}
				const current = await readStatus(source);
				await patchStatusForRun(source, runId, {
					pages: number,
					items: current.items + page.items,
				});
			},
		});
		const completed = await sourceImportLifecycle().complete({
			source,
			runId,
			state: result.state,
			pages: result.pages,
			items: result.items,
			initialImport: !live,
		});
		await applyImportEffects(completed.effects);
	} catch (error) {
		if (
			error instanceof SourceImportLifecycleError &&
			(error.code === "queue_full" ||
				error.code === "record_too_large" ||
				error.code === "queue_failed")
		)
			return;
		if (
			error instanceof SourceImportLifecycleError &&
			error.code === "stale_run"
		)
			return;
		if (!(await ownsRun())) return;
		const code =
			error instanceof SessionImportError
				? error.code
				: "platform_request_failed";
		const failed = await sourceImportLifecycle().fail({
			source,
			runId,
			code,
			retryAfterMs:
				error instanceof SessionImportError ? error.retryAfterMs : undefined,
		});
		await applyImportEffects(failed.effects);
		if (failed.kind === "failed") {
			await patchStatusForRun(source, runId, {
				message: SAFE_PLATFORM_ERRORS[code],
			});
		}
	}
}

/**
 * Talk to a tab, reloading it once if nobody is listening.
 *
 * Content scripts are injected when a page loads, so a tab that was already
 * open when the extension was installed or reloaded has none — and
 * `sendMessage` rejects with "Receiving end does not exist". Swallowing that
 * is what left the popup saying "running…" forever with no way to tell why.
 *
 * A reload puts the script in place. It is the user's own tab, on the site
 * they just asked to import from, in response to their click.
 */
/**
 * Arm the tabs that were already open.
 *
 * Reloading an extension does not re-inject content scripts into tabs that
 * were already open, and observers were only ever armed by tabs.onUpdated. So
 * after every reload the x.com tab you were actually using had no script in it
 * at all — you could unsave something and nothing anywhere would notice, with
 * no error, because there was no code there to fail.
 *
 * `talk` reloads a tab that has nobody home, which is disruptive; that is why
 * this runs on install and update only, and not on the service worker's many
 * ordinary wakes.
 */
async function armOpenTabs(): Promise<void> {
	const config = await loadConfig(true);
	if (!config) return;

	for (const entry of config.sources) {
		const host = entry.host.replace("www.", "");
		const tabs = await browser.tabs
			.query({ url: `*://*.${host}/*` })
			.catch(() => []);
		for (const tab of tabs) {
			if (!tab.id) continue;
			await talk(tab.id, {
				anansi: "page-command",
				messageVersion: MESSAGE_PROTOCOL_VERSION,
				source: entry.source,
				action: "configure",
				config: entry,
			}).catch(() => false);
		}
	}
}

async function talk(tabId: number, message: unknown): Promise<boolean> {
	try {
		await browser.tabs.sendMessage(tabId, message);
		return true;
	} catch {
		// Nobody home. Reload and wait for the script to land.
	}

	try {
		await browser.tabs.reload(tabId);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("tab reload timed out")),
				20_000,
			);
			const onUpdated = (id: number, info: { status?: string }) => {
				if (id !== tabId || info.status !== "complete") return;
				clearTimeout(timer);
				browser.tabs.onUpdated.removeListener(onUpdated);
				// document_idle scripts land a beat after "complete".
				setTimeout(resolve, 600);
			};
			browser.tabs.onUpdated.addListener(onUpdated);
		});
		await browser.tabs.sendMessage(tabId, message);
		return true;
	} catch {
		return false;
	}
}

async function rescheduleHeartbeat(): Promise<void> {
	await browser.alarms.clear(HEARTBEAT_ALARM);
	browser.alarms.create(HEARTBEAT_ALARM, {
		periodInMinutes: 2,
		delayInMinutes: 1,
	});
}

async function processPendingRefreshes(): Promise<void> {
	const runs = persistentState().runs;
	for (const source of CAPTURE_SOURCES) {
		if (await runs.claimRefresh(source)) await startCapture(source, true, true);
	}
}

const EMPTY_COUNTS: CaptureQueueStatus = {
	queued: 0,
	uploading: 0,
	retrying: 0,
	failed: 0,
};

/**
 * Outbox counts split by source.
 *
 * The popup needs these per row, not just as a grand total: "1,274 saved" next
 * to a row that still has three captures it could not send is the kind of
 * reassurance that made the old popup untrustworthy.
 */
async function queueBySource(): Promise<Record<string, CaptureQueueStatus>> {
	const records = await persistentState().outbox.list();
	const counts: Record<string, CaptureQueueStatus> = {};
	for (const source of CAPTURE_SOURCES) counts[source] = { ...EMPTY_COUNTS };
	for (const record of records) {
		let bucket = counts[record.source];
		if (!bucket) {
			bucket = { ...EMPTY_COUNTS };
			counts[record.source] = bucket;
		}
		if (record.state === "queued") bucket.queued++;
		else if (record.state === "uploading") bucket.uploading++;
		else if (record.state === "retry_wait") bucket.retrying++;
		else bucket.failed++;
	}
	const queuedIds = new Set(records.map((record) => record.eventId));
	for (const source of CAPTURE_SOURCES) {
		for (const capture of await liveCapture().pending(source)) {
			if (!queuedIds.has(capture.eventId)) counts[source]!.queued++;
		}
	}
	return counts;
}

async function durableSnapshot() {
	const runsState = persistentState().runs;
	const [queueStatus, bySource, ...runs] = await Promise.all([
		publishQueueStatus(),
		queueBySource(),
		...CAPTURE_SOURCES.map((source) => runsState.current(source)),
	]);
	return {
		queue: queueStatus,
		bySource,
		runs: Object.fromEntries(runs.map((run) => [run.source, run])),
		destinationOrigin: (await browser.storage.local.get("anansiQueueDestinationOrigin")).anansiQueueDestinationOrigin ?? null,
	};
}

type BackgroundResult =
	| {
			ok: true;
			delivery?: "queued" | "uploaded";
			snapshot?: Awaited<ReturnType<typeof durableSnapshot>>;
			/** Whether Chrome bookmark mirroring is on and still permitted. */
			mirroring?: boolean;
			/** Whether the page should confirm this save to the person. */
			confirm?: boolean;
	  }
	| { ok: false; error: string };

interface RuntimeMessageSender {
  frameId?: number;
	url?: string;
	documentId?: string;
	tab?: { id?: number; url?: string };
}

function claimedNonce(value: unknown): string {
	if (typeof value !== "object" || value === null) return "";
	const descriptor = Object.getOwnPropertyDescriptor(value, "nonce");
	return typeof descriptor?.value === "string" ? descriptor.value : "";
}

function validateRuntimeMessage(
	message: unknown,
	sender: RuntimeMessageSender,
) {
	if (!sender.tab) {
		return parseExtensionMessage(message, {
			path: "runtime-to-background",
			sender: { kind: "extension" },
		});
	}

	const tabId = sender.tab.id;
	const senderUrl = sender.url ?? sender.tab.url ?? "";
	if (!Number.isSafeInteger(tabId)) {
		return parseExtensionMessage(message, {
			path: "runtime-to-background",
			sender: { kind: "tab", url: senderUrl },
			expectedNonce: "",
		});
	}

	// The first event from a document can seed its nonce because only our
	// isolated-world relay can call runtime.sendMessage; the page itself can only
	// reach that relay, which already checked the nonce.
	const document = { tabId: tabId as number, ...(sender.documentId ? { documentId: sender.documentId } : {}) };
	const expectedNonce = documentNonces.expected(document, message, claimedNonce(message));
	const parsed = parseExtensionMessage(message, {
		path: "runtime-to-background",
		sender: { kind: "tab", url: senderUrl },
		expectedNonce,
	});
	if (parsed.ok) documentNonces.remember(document, expectedNonce);
	return parsed;
}

type PlatformErrorCode = Extract<
	PageEventMessage,
	{ action: "error" }
>["errorCode"];

const SAFE_PLATFORM_ERRORS: Record<PlatformErrorCode, string> = {
	platform_request_failed:
		"the platform request failed; retry after checking the signed-in tab",
	not_signed_in: "sign in to the platform in this browser, then press Import",
	query_unavailable:
		"the bookmark query is unavailable; open the bookmarks page and retry",
	capture_failed: "capture failed inside the platform tab",
	page_shape_changed:
		"the platform returned an unexpected page; update the extension before retrying",
	rate_limited: "the platform temporarily limited the import; retry later",
};

async function handlePopupCommand(
	msg: PopupCommandMessage,
): Promise<BackgroundResult> {
	switch (msg.action) {
		case "queue-status":
			return { ok: true, snapshot: await durableSnapshot() };
		case "import-all":
			return await startAllCaptures();
		case "retry-queue":
			await wakeDurableQueue(true, msg.source);
			return { ok: true, snapshot: await durableSnapshot() };
		case "mirror-status":
			return { ok: true, mirroring: await mirroringOn() };
		case "mirror-on":
			return await setMirroring(true);
		case "mirror-off":
			return await setMirroring(false);
		case "adopt-legacy-queue": {
			const adopted = await queueDestination().adoptCurrentOrigin();
			if (!adopted.ok) return adopted;
			const current = await settings();
			if (!current) return { ok: false, error: "Connect to an Anansi server before assigning pending captures." };
			await browser.storage.local.set({ anansiAuthorizedOrigin: current.server });
			await browser.storage.local.remove(["anansiConnectionPreviousOrigin", "anansiConnectionAttemptOrigin"]);
			await wakeDurableQueue();
			return { ok: true };
		}
		case "connection-updated": {
			const originState = await browser.storage.local.get(["anansiConnectionPreviousOrigin", "anansiAuthorizedOrigin", "anansiConnectionAttemptOrigin"]);
			const prior = typeof originState.anansiConnectionPreviousOrigin === "string"
				? originState.anansiConnectionPreviousOrigin
				: typeof originState.anansiAuthorizedOrigin === "string" ? originState.anansiAuthorizedOrigin : cached?.serverOrigin;
			const current = await settings();
			if (current) {
				const admission = await queueDestination().canConnectTo(current.server);
				if (!admission.ok) return admission;
			}
			if (!current && typeof originState.anansiConnectionAttemptOrigin === "string") {
				try {
					await browser.permissions.remove({ origins: [`${originState.anansiConnectionAttemptOrigin}/*`] });
				} catch { /* The user may already have revoked this optional grant. */ }
			}
			if (typeof prior === "string" && (!current || prior !== current.server)) {
				try {
					await browser.permissions.remove({ origins: [`${prior}/*`] });
				} catch {
					// Chrome may already have revoked this optional grant.
				}
			}
			cached = null;
			cachedToken = null;
			await browser.storage.local.remove("anansiExtensionConfigCacheV1");
			if (current) {
				await browser.storage.local.set({ anansiAuthorizedOrigin: current.server });
				await browser.storage.local.remove(["anansiConnectionPreviousOrigin", "anansiConnectionAttemptOrigin"]);
				await loadConfig(true);
                const verified = await fetch(`${current.server}/api/extension/config`, {headers:{authorization:`Bearer ${current.token}`},redirect:"error",signal:AbortSignal.timeout(10000)});
                if (verified.status !== 200) return {ok:false,error:"Connection verification failed"};
                await heartbeat().send();
                await wakeDurableQueue();
                await armLibraryTabs();
                const previous = (await browser.storage.local.get("anansiPreviousConnection")).anansiPreviousConnection as {origin:string;token:string} | undefined;
                await retirePreviousConnection({origin:current.server,token:current.token},previous);
                await browser.storage.local.remove("anansiPreviousConnection");
            } else {
				await browser.alarms.clear(OUTBOX_ALARM);
				await browser.alarms.clear(NATIVE_CAPTURE_ALARM);
				await browser.storage.local.remove(["anansiConnectionPreviousOrigin", "anansiConnectionAttemptOrigin"]);
			}
			return { ok: true };
		}
		case "save-page": {
			const [tab] = await browser.tabs.query({
				active: true,
				currentWindow: true,
			});
			if (!tab?.id) return { ok: false, error: "no active tab" };
			return await capturePage(tab.id, "toolbar");
		}
		case "start": {
			await startCapture(msg.source);
			return { ok: true };
		}
		case "stop": {
			if (isSessionCaptureSource(msg.source)) {
				const importing = sessionImports.get(msg.source);
				importing?.controller.abort();
				await importing?.task;
			}
			const current = await persistentState().runs.current(msg.source);
			if (current.runId) {
				const stopped = await sourceImportLifecycle().stop(
					msg.source,
					current.runId,
				);
				await applyImportEffects(stopped.effects);
			}
			return { ok: true };
		}
	}
}

async function handlePageEvent(
	msg: PageEventMessage,
	source: PlatformSource,
	tabId?: number,
): Promise<BackgroundResult> {
	// Import results for these sources are owned by the worker. Old content
	// scripts in already-open tabs must not advance or finish its run.
	if (
		isSessionCaptureSource(source) &&
		["page", "done", "error", "scanned"].includes(msg.action)
	) {
		return {
			ok: false,
			error: "import results are owned by the background worker",
		};
	}
	switch (msg.action) {
		case "ready":
			if (msg.relay && tabId) {
				const config = await loadConfig(true);
				const entry = config?.sources.find((candidate) => candidate.source === source);
				if (entry) {
					await browser.tabs.sendMessage(tabId, {
						anansi: "page-command",
						messageVersion: MESSAGE_PROTOCOL_VERSION,
						source,
						action: "configure",
						config: entry,
					}).catch(() => {});
				}
			}
			return { ok: true };
		case "page":
			{
				const accepted = msg.runId
					? await sourceImportLifecycle().page({
							source,
							runId: msg.runId,
							tabId,
							page: msg.page,
							items: msg.items,
							cursor: msg.cursor ?? null,
							raw: msg.raw,
							captureMethod: "platform_import",
						})
					: { kind: "ignored-stale" as const, source, effects: [] };
				await applyImportEffects(accepted.effects);
				if (accepted.kind === "queue-failed") {
					return {
						ok: false,
						error: accepted.errorCode ?? "capture queue rejected the page",
					};
				}
				if (accepted.kind === "ignored-stale" || accepted.kind === "disabled")
					return { ok: true };
				if (msg.runId) runDeadlines.progress(msg.runId);
			}
			await patchStatusForRun(source, msg.runId ?? "", {
				pages: msg.page,
				items: msg.items,
			});
			return { ok: true };
		case "saved":
			await persistentState().runs.requestRefresh(source);
			scheduleOutboxRetry(browser.alarms, OUTBOX_ALARM, Date.now());
			return { ok: true };
		case "bookmark":
			await handleBookmarkMutation(
				source,
				msg.bookmarkAction,
				msg.externalId,
				msg.canonicalUrl,
				msg.raw,
				msg.normalizedItem,
				msg.mutationId,
				msg.observedAt,
			);
			return { ok: true };
		case "observed": {
			const accepted = await sourceImportLifecycle().page({ source, runId: msg.runId, tabId, page: 0, items: msg.items, raw: msg.raw, captureMethod: "platform_import" });
			await applyImportEffects(accepted.effects);
			if (accepted.kind === "queue-failed") return { ok: false, error: accepted.errorCode ?? "capture queue rejected the page" };
			if (accepted.kind !== "accepted-page") return { ok: true };
			runDeadlines.progress(msg.runId);
			const current = await readStatus(source);
			await patchStatusForRun(source, msg.runId, {
				lastRun: Date.now(),
				pages: current.pages + 1,
				items: current.items + msg.items,
			});
			return { ok: true };
		}
		case "done":
			{
				if (!msg.runId) return { ok: true };
				const completed = await sourceImportLifecycle().complete({
					source,
					runId: msg.runId,
					tabId,
					state: msg.state,
					pages: msg.pages,
					items: msg.items,
					initialImport: (await persistentState().runs.current(source)).runMode !== "live",
				});
				await applyImportEffects(completed.effects);
				if (completed.kind === "completed" && msg.items === 0) {
					await patchStatusForRun(source, msg.runId, {
						message: "run returned zero items",
					});
				}
			}
			return { ok: true };
		case "identified":
			if ((await persistentState().runs.current(source)).runId === msg.runId) {
				identifiedPageRuns.set(msg.runId, msg.handle);
				await persistentState().runs.setHandle(source, msg.handle);
			}
			return { ok: true };
		case "scanned": {
			const run = await persistentState().runs.current(source);
			if (run.runId === msg.runId) {
				const currentStatus = await readStatus(source);
				const completed = await sourceImportLifecycle().complete({
					source,
					runId: msg.runId,
					tabId,
          state: needsFullWindowImport(run.runMode === "live", msg) || (run.runMode === "live" && currentStatus.pages >= 10) ? "limited" : "complete",
					initialImport: run.runMode !== "live",
				});
				await applyImportEffects(completed.effects);
				if (completed.kind === "completed" && needsFullWindowImport(run.runMode === "live", msg)) {
					await patchStatusForRun(source, msg.runId, {
						message: "more favorites may remain; use Import everything to finish in a window",
					});
				} else if (completed.kind === "completed" && currentStatus.items === 0) {
					await patchStatusForRun(source, msg.runId, {
						message: "no favorites were returned",
					});
				}
			}
			return { ok: true };
		}
		case "error":
			{
				if (msg.runId) {
					const failed = await sourceImportLifecycle().fail({
						source,
						runId: msg.runId,
						tabId,
						code: msg.errorCode,
					});
					await applyImportEffects(failed.effects);
					if (failed.kind === "failed") {
						await patchStatusForRun(source, msg.runId, {
							startedAt: null,
							message: SAFE_PLATFORM_ERRORS[msg.errorCode],
						});
					}
				}
			}
			await processPendingRefreshes();
			return { ok: true };
	}
}

async function injectLibraryBridge(tabId: number) {
        await browser.scripting.executeScript({target: {tabId}, func: () => {
          const marker = "__anansiSyncBridge";
          const state = globalThis as typeof globalThis & {__anansiSyncBridge?: (event: MessageEvent) => void};
          if (state[marker]) window.removeEventListener("message",state[marker]);
          state[marker] = event => {
            if (event.source !== window || event.origin !== location.origin || !["library-sync-request","library-connect-request"].includes(event.data?.anansi) || typeof event.data.id !== "string" || event.data.id.length > 80) return;
            const id = event.data.id;
            const connecting=event.data.anansi === "library-connect-request";
            const family=connecting?"library-connect-response":"library-sync-response";
            void chrome.runtime.sendMessage(connecting?{anansi:"library-connect",messageVersion:1,code:event.data.code}:{anansi: "library-sync-now", messageVersion: 1}).then(result => {
              window.postMessage({anansi: family, id, ok: result?.ok === true}, location.origin);
            }).catch(() => window.postMessage({anansi: family, id, ok: false}, location.origin));
          };
          window.addEventListener("message",state[marker]);
        }}).catch(() => {});

}
async function armLibraryTabs() {
 const current=await settings();
 if (!current) return;
 for (const tab of await browser.tabs.query({})) {
   if (tab.id && isLibraryPage(tab.url,current.server)) await injectLibraryBridge(tab.id);
 }
}
async function handleRuntimeMessage(
	message: unknown,
	sender: RuntimeMessageSender,
): Promise<BackgroundResult> {
 if ((message as {anansi?:string})?.anansi === "library-connect") {
  const current=await settings();
  const result=await connectLibrary(message,{senderUrl:sender.tab?sender.url:undefined,origin:current?.server,frameId:sender.frameId},async(code)=>{
   const admission=await queueDestination().canConnectTo(current!.server);
   if(!admission.ok)throw new Error("Connection failed");
   const response=await fetch(`${current!.server}/api/connect/redeem`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code}),redirect:"error",signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw new Error("Connection failed");
   const issued=await response.json() as {key:string};
   const verified=await fetch(`${current!.server}/api/extension/config`,{headers:{authorization:`Bearer ${issued.key}`},redirect:"error",signal:AbortSignal.timeout(10000)});
   if(verified.status !== 200)throw new Error("Connection failed");
   await saveExtensionConnection(current!.server,issued.key);
   const updated=await handlePopupCommand({anansi:"popup-command",messageVersion:1,action:"connection-updated"});
   if(!updated.ok)throw new Error("Connection failed");
  });
  return result.ok?{ok:true}:{ok:false,error:"Connection failed"};
 }
	if ((message as {anansi?: string})?.anansi === "library-sync-now") {
    const current = await settings();
    if (!isLibrarySyncCommand(message, sender.url, current?.server) || !sender.tab || sender.frameId !== 0) return {ok: false, error: "origin not allowed"};
    void librarySync().syncNow().catch(() => {});
    return {ok: true};
  }
  const handoff = parseNativeHandoffStoreRequest(message);
	if (handoff) return handleNativeHandoffStore(handoff, sender);
	const parsed = validateRuntimeMessage(message, sender);
	if (!parsed.ok) return { ok: false, error: parsed.error.message };

	try {
		if (parsed.message.anansi === "popup-command") {
			return await handlePopupCommand(parsed.message);
		}
		if (parsed.message.anansi === "page-event" && parsed.source) {
			return await handlePageEvent(
				parsed.message,
				parsed.source,
				sender.tab?.id,
			);
		}
		return { ok: false, error: "message family is not allowed on this path" };
	} catch {
		const source = parsed.source ?? "_";
		await patchStatus(source, {
			startedAt: null,
			message: "background action failed",
		});
		return { ok: false, error: "background action failed" };
	}
}

export default defineBackground(() => {
	/**
	 * The menus are created on install rather than on every start.
	 *
	 * A service worker starts many times a day and createContextMenus throws on
	 * a duplicate id, so recreating them per start means an exception in the log
	 * every time — and a swallowed one is how a real error later gets missed.
	 */
	browser.runtime.onInstalled.addListener(() => {
        void armLibraryTabs().catch(() => {});
		browser.contextMenus.removeAll(() => {
			for (const menu of MENUS) {
				browser.contextMenus.create(menu);
			}
		});
	});

	browser.contextMenus.onClicked.addListener((info, tab) => {
		if (!tab?.id) return;
		if (info.menuItemId === "anansi-save-page") {
			void capturePage(tab.id, "context_menu");
		}
		if (info.menuItemId === "anansi-save-selection") {
			void capturePage(tab.id, "context_menu", info.selectionText);
		}
	});

	browser.runtime.onMessage.addListener(
		(message: unknown, sender: RuntimeMessageSender) =>
			handleRuntimeMessage(message, sender),
	);

	browser.alarms.onAlarm.addListener((alarm) => {
		void (async () => {
			if (alarm.name.startsWith(SOURCE_RUN_RECOVERY_ALARM_PREFIX)) {
				const source = alarm.name.slice(
					SOURCE_RUN_RECOVERY_ALARM_PREFIX.length,
				);
				if (!isCaptureSource(source)) return;
				const interrupted = await persistentState().runs.current(source);
				if (interrupted.phase !== "running") return;
				await startCapture(source, true, interrupted.runMode === "live");
				return;
			}
			if (alarm.name === HEARTBEAT_ALARM) {
				requestHeartbeat();
				return;
			}
			if (alarm.name === OUTBOX_ALARM || alarm.name === NATIVE_CAPTURE_ALARM) {
				await wakeDurableQueue();
				await processPendingRefreshes();
				return;
			}
		})();
	});

	// Earlier versions kept a daily catch-up alarm. Sync now follows the library.
	void browser.alarms.clear(SYNC_ALARM);
	void armLibraryTabs().catch(() => {});
	void rescheduleHeartbeat();
	void wakeDurableQueue().then(processPendingRefreshes);
	requestHeartbeat();
	// The worker restarts constantly; the listeners have to come back with it.
	void startMirroring();
	browser.runtime.onStartup.addListener(() => {
        void armLibraryTabs().catch(() => {});
		void wakeDurableQueue().then(processPendingRefreshes);
		requestHeartbeat();
	});
	browser.runtime.onInstalled.addListener(() => {
        void armLibraryTabs().catch(() => {});
		void wakeDurableQueue().then(processPendingRefreshes);
		void armOpenTabs();
		requestHeartbeat();
	});

	// Arm the observers on every matching tab as it loads, so real-time capture
	// works without anyone opening the popup.
	browser.tabs.onUpdated.addListener((tabId, info, tab) => {
		if (info.status !== "complete" || !tab.url) return;
		void settings().then(async (current) => {
			if (isLibraryPage(tab.url, current?.server)) {
        // The bridge only serves Sync now, so failing to add it must not stop this sync.
        void injectLibraryBridge(tabId);
        return librarySync().libraryOpened();
      }
		}).catch(() => {});
		void loadConfig().then((config) => {
			const entry = config?.sources.find((candidate) =>
				tab.url?.includes(candidate.host.replace("www.", "")),
			);
			if (entry) {
				void browser.tabs
					.sendMessage(tabId, {
						anansi: "page-command",
						messageVersion: MESSAGE_PROTOCOL_VERSION,
						source: entry.source,
						action: "configure",
						config: entry,
					})
					.catch(() => {});
			}
		});
	});
});
