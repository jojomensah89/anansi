export * as schema from "./schema.ts";
export { captureEvents, extensionClients, items, itemSourceLinks, media, tags, itemTags, itemTagOverrides } from "./schema.ts";
export type { AnansiDb, DbItem, NewDbItem } from "./types.ts";
export { TOPIC_DEFINITIONS, TOPIC_TAGS, TOPIC_TAXONOMY_VERSION, canonicalTopicId, canonicalizeTopicIds, topicDefinition } from "./topics.ts";
export type { TagKind, TopicId } from "./topics.ts";
export { upsertItems, countItems, creators, creatorPage, setArchived, tagItems, listTags, disabledSources, setSourceEnabled, InvalidCreatorCursorError } from "./queries.ts";
export type { CaptureOrigin, UpsertOptions, Creator, CreatorPage, CreatorPageOptions } from "./queries.ts";
export { searchItems, searchItemsPage, hydrateSearchItems, hydrateSemanticChunkMatches, recentSaves, findByAuthor, getItem, getItems, listItems, libraryStats, sourceHealth, toFtsQuery } from "./search.ts";
export { InvalidListCursorError, InvalidSearchCursorError } from "./search.ts";
export type { SearchHit, SearchOptions, ListOptions, ItemDetail, SourceHealth, CardMedia, SemanticChunkMatch } from "./search.ts";
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
export { aiEnrichmentJobs, aiSettings, itemEmbeddings, aiProgress, applyAiTags, claimAiJobs, completeAiJob, consumeSemanticCredits, contentHash, embeddingProjectionText, failAiJob, getAiSettings, loadAiJobItems, reconcileAiJobs, reclassifyAiTopics, requeueEmbeddingJobs, releaseAiJob, searchableText, semanticCreditsForText, semanticText, setAiSettings, upsertItemEmbedding, validateAiJobClaim } from "./ai-jobs.ts";
export type { AiJob, AiJobFailureCode, AiJobKind } from "./ai-jobs.ts";
export { semanticChunks, semanticVectorDeletions } from "./schema.ts";
export { clearSemanticIndex, completeSemanticVectorDeletions, discardSemanticChunks, estimateSemanticBackfill, markSemanticChunksComplete, retireStaleSemanticChunks, retrySemanticVectorDeletions, semanticIndexStats, semanticVectorDeletionBatch, stageSemanticChunks } from "./semantic-index.ts";
export type { SemanticChunkRow, SemanticChunkVector } from "./semantic-index.ts";
export { chunkSemanticText, normalizeSemanticText, SEMANTIC_CHUNKER_VERSION, SEMANTIC_CHUNK_MAX_CHARS, SEMANTIC_CHUNK_OVERLAP_CHARS, SEMANTIC_CREDIT_CHARS } from "./semantic-chunks.ts";
export type { SemanticTextChunk } from "./semantic-chunks.ts";
