import type { NormalizedItem, ExtensionPlatformSource } from "@anansi/sources";

export type PlatformPageEventAction =
	| "ready"
	| "saved"
	| "page"
	| "observed"
	| "scanned"
	| "identified"
	| "bookmark"
	| "done"
	| "error";

export type PlatformPageCommandAction =
	| "ready"
	| "configure"
	| "backfill"
	| "identify"
	| "scan";

export interface PlatformProtocolRules {
	events: {
		actions: readonly PlatformPageEventAction[];
		ready: "query-or-relay" | "relay-only";
		pageRequiresRunId: boolean;
		doneRequiresRunId: boolean;
		errorRequiresRunId: boolean;
	};
	commands: {
		actions: readonly PlatformPageCommandAction[];
		requiredRunIdActions: readonly PlatformPageCommandAction[];
	};
}

export interface NativeSnapshotAdapter {
	parseObject(value: Record<string, unknown>, now: number): NormalizedItem[];
	matchesIdentity(item: NormalizedItem): boolean;
	hasCompleteProviderData(raw: unknown, maxObjects: number): boolean;
	sanitize(item: NormalizedItem): NormalizedItem;
	fromDocument(
		id: string,
		doc: Document,
		now: number,
		parsePayload: (raw: unknown) => NormalizedItem[],
	): NormalizedItem | undefined;
	idsFromClickTarget(root: Element): string[];
}

export interface PageImportPreparationContext {
	setMessage(message: string): Promise<void>;
	identify(): Promise<void>;
	waitForIdentity(): Promise<string | null>;
	currentUrl(): Promise<string | null>;
	navigate(url: string): Promise<boolean>;
	configure(): Promise<boolean>;
}

export type PageImportPreparationResult =
	| { ready: true }
	| { ready: false; code: "capture_failed" | "platform_request_failed"; message: string };

export interface PlatformCaptureAdapter<S extends ExtensionPlatformSource> {
	readonly source: S;
	readonly hosts: readonly string[];
	readonly tabPatterns: readonly string[];
	readonly entryUrl: string;
	readonly importMode: "page" | "session";
	readonly refreshTopOnResume?: boolean;
	/** The import navigates, so it always opens and later closes its own tab. */
	readonly ownsImportTab?: boolean;
	readonly isExternalId: (value: unknown) => value is string;
	readonly canonicalUrl: (externalId: string) => string;
	readonly parsePage: (raw: unknown, importedAt: number) => NormalizedItem[];
	readonly isExpectedImportTab: (value: string) => boolean;
	readonly protocol: PlatformProtocolRules;
	readonly nativeSnapshot: NativeSnapshotAdapter;
	readonly preparePageImport?: (context: PageImportPreparationContext) => Promise<PageImportPreparationResult>;
}

export type AnyPlatformCaptureAdapter = {
	[S in ExtensionPlatformSource]: PlatformCaptureAdapter<S>;
}[ExtensionPlatformSource];

export const NATIVE_SNAPSHOT_LIMITS = {
	maxObjects: 10_000,
	maxChildren: 2_000,
	maxPayloadChars: 2_000_000,
	maxTextChars: 100_000,
} as const;

