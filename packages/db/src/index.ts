export * as schema from "./schema.ts";
export { captureEvents, extensionClients, items, itemSourceLinks, media, tags, itemTags, itemTagOverrides } from "./schema.ts";
export type { AnansiDb, DbItem, NewDbItem } from "./types.ts";
export { TOPIC_DEFINITIONS, TOPIC_TAGS, TOPIC_TAXONOMY_VERSION, canonicalTopicId, canonicalizeTopicIds, topicDefinition } from "./topics.ts";
export type { TagKind, TopicId } from "./topics.ts";
export { upsertItems, countItems, creators, setArchived, tagItems, listTags, disabledSources, setSourceEnabled } from "./queries.ts";
export type { CaptureOrigin, UpsertOptions } from "./queries.ts";
export { searchItems, searchItemsPage, hydrateSearchItems, recentSaves, findByAuthor, getItem, getItems, listItems, libraryStats, sourceHealth, toFtsQuery } from "./search.ts";
export { InvalidListCursorError, InvalidSearchCursorError } from "./search.ts";
export type { SearchHit, SearchOptions, ListOptions, ItemDetail, SourceHealth, CardMedia } from "./search.ts";
export { pendingMedia, markMediaStored, mediaStats } from "./media.ts";
export type { PendingMedia } from "./media.ts";
export { applyCapture, CaptureApplicationError } from "./capture-events.ts";
export type { CaptureApplicationErrorCode } from "./capture-events.ts";
export { extensionHealth, recordExtensionHeartbeat } from "./extension-health.ts";
export type { ExtensionHealth } from "./extension-health.ts";
export {
	HIDDEN_SOURCES,
	isHiddenSource,
	isVisibleSource,
	visibleSourceClause,
} from "./visibility.ts";

export { setItemNote, setFavorite, removeItemTag, listCollections, saveCollection, deleteCollection, exportLibrary, restoreLibrary } from "./organization.ts";
export type { Collection, CollectionFilters, LibraryExport } from "./organization.ts";
export { claimMediaJobs, completeMediaJob, failMediaJob } from "./media-jobs.ts";
export { aiEnrichmentJobs, aiSettings, itemEmbeddings, aiProgress, applyAiTags, claimAiJobs, completeAiJob, contentHash, failAiJob, getAiSettings, loadAiJobItems, reconcileAiJobs, reclassifyAiTopics, requeueEmbeddingJobs, releaseAiJob, searchableText, semanticText, setAiSettings, upsertItemEmbedding, validateAiJobClaim } from "./ai-jobs.ts";
export type { AiJob, AiJobFailureCode, AiJobKind } from "./ai-jobs.ts";
