import type { AiTopic } from "./api.ts";
import { formatCount } from "./format.ts";

/** "1 save", "1,204 saves". */
export function saveCount(count: number): string {
	return `${formatCount(count)} ${count === 1 ? "save" : "saves"}`;
}

/** A built-in whose description is no longer the shipped one. */
export function topicEdited(topic: Pick<AiTopic, "builtIn" | "description" | "defaultDescription">): boolean {
	return topic.builtIn && topic.defaultDescription !== undefined && topic.description !== topic.defaultDescription;
}
