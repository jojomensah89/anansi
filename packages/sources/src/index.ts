export type { NormalizedItem, MediaRef, Source, Kind } from "./item.ts";
export { itemKey } from "./item.ts";
export {
	SOURCE_CAPABILITIES,
	SOURCE_IDS,
	RETAINED_PARSING_SOURCES,
	VISIBLE_LIBRARY_SOURCES,
	EXTENSION_PLATFORM_SOURCES,
	PAGE_IMPORT_SOURCES,
	SESSION_IMPORT_SOURCES,
	LIVE_CAPTURE_SOURCES,
	MANUAL_CAPTURE_SOURCES,
	TOGGLEABLE_SOURCES,
	SHIPPED_CAPTURE_SOURCES,
	RETAINED_SOURCES,
	VISIBLE_SOURCES,
	EXTENSION_SOURCES,
	isSource,
	isKnownSource,
	sourceCapability,
	isExtensionPlatformSource,
	isRetainedParsingSource,
	isPageImportSource,
	isSessionImportSource,
	isManualCaptureSource,
	isLiveCaptureSource,
	isToggleableSource,
	captureMethodsForSource,
	retainedCaptureMethodsForSource,
	supportsCaptureMethod,
	supportsRetainedCaptureMethod,
	sourceFlags,
	validateSourceCapabilityFacts,
} from "./capabilities.ts";
export type {
	CaptureMethod,
	CaptureSource,
	ImportMode,
	SourceCapability,
	RetainedParsingSource,
	VisibleLibrarySource,
	ExtensionPlatformSource,
	PageImportSource,
	SessionImportSource,
	LiveCaptureSource,
	ManualCaptureSource,
	ToggleableSource,
	ShippedCaptureSource,
	CapabilityFactsValidationError,
	CapabilityFactsValidationResult,
} from "./capabilities.ts";
export {
	parseExtensionConfig,
	isExtensionRemoteConfig,
	validateExtensionConfig,
	SHIPPED_CAPTURE_FLAGS,
} from "./extension-config.ts";
export type {
	ExtensionSourceConfig,
	ExtensionConfigFeatures,
	ExtensionRemoteConfig,
	RemoteConfig,
	SourceConfig,
	ExtensionConfigValidationErrorCode,
	ExtensionConfigValidationError,
	ExtensionConfigParseResult,
} from "./extension-config.ts";
export type {
  BookmarkCapture,
  CaptureBase,
  CaptureLimits,
  CaptureOutcome,
  CaptureParseResult,
  CaptureQueueState,
  CaptureQueueStatus,
  CaptureReceipt,
  CaptureValidationError,
  ItemEventCapture,
  RawPageCapture,
} from "./capture.ts";
export { CAPTURE_SCHEMA_VERSION, parseBookmarkCapture } from "./capture.ts";
export type { ParseContext } from "./context.ts";
export { parseBookmarksPage } from "./x/parse.ts";
export { parseStarredPage, README_CHARS } from "./github/parse.ts";
export type { StarredRawPage } from "./github/parse.ts";
export { parseSavedListing, savedListingCursor } from "./reddit/parse.ts";
export { parseItemList } from "./tiktok/parse.ts";
export { canonicalizeWebUrl, webExternalId } from "./web/canonical-url.ts";
export type {
  ExtensionHeartbeat,
  HeartbeatParseResult,
  HeartbeatSourceState,
  HeartbeatValidationError,
} from "./extension-heartbeat.ts";
export {
  HEARTBEAT_SCHEMA_VERSION,
  parseExtensionHeartbeat,
} from "./extension-heartbeat.ts";
