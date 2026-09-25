import {
	type AnansiDb,
	completeSemanticVectorDeletions,
	retrySemanticVectorDeletions,
	semanticVectorDeletionBatch,
} from "@anansi/db";
import type { VectorIndex } from "./ai.ts";

/** Best-effort bounded cleanup; D1 tombstones already hide every queued ID. */
export async function drainSemanticVectorDeletes(db: AnansiDb, index: VectorIndex | undefined, limit = 80): Promise<number> {
	if (!index?.deleteByIds) return 0;
	const rows = await semanticVectorDeletionBatch(db, limit);
	if (rows.length === 0) return 0;
	const ids = rows.map((row) => row.vectorId);
	try {
		await index.deleteByIds(ids);
		await completeSemanticVectorDeletions(db, ids);
		return ids.length;
	} catch {
		await retrySemanticVectorDeletions(db, ids);
		return 0;
	}
}
