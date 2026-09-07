export const TOPIC_TAXONOMY_VERSION = "v1" as const;

export const TOPIC_DEFINITIONS = [
	{ id: "web-dev", label: "Web Dev", color: "#22c55e" },
	{ id: "ai-ml", label: "AI / ML", color: "#3b82f6" },
	{ id: "marketing", label: "Marketing", color: "#14b8a6" },
	{ id: "design", label: "Design", color: "#eab308" },
	{ id: "startups", label: "Startups", color: "#ec4899" },
	{ id: "product", label: "Product", color: "#8b5cf6" },
	{ id: "career", label: "Career", color: "#f97316" },
	{ id: "devops", label: "DevOps", color: "#06b6d4" },
	{ id: "security", label: "Security", color: "#ef4444" },
	{ id: "finance", label: "Finance", color: "#84cc16" },
	{ id: "health", label: "Health", color: "#6366f1" },
] as const;

export type TopicId = (typeof TOPIC_DEFINITIONS)[number]["id"];
export type TagKind = "topic" | "custom";

export const TOPIC_TAGS = TOPIC_DEFINITIONS.map((topic) => ({
	...topic,
	tagId: `topic:${topic.id}`,
})) as ReadonlyArray<(typeof TOPIC_DEFINITIONS)[number] & { tagId: string }>;

const TOPIC_BY_ID = new Map(TOPIC_DEFINITIONS.map((topic) => [topic.id, topic]));
const TOPIC_BY_KEY = new Map<string, TopicId>();

function topicKey(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/[&/]+/g, " ")
		.replace(/[-_]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const aliases: Record<TopicId, string[]> = {
	"web-dev": ["web development", "web developer", "frontend", "front end", "backend", "back end", "software development", "programming", "javascript", "typescript", "react", "node.js"],
	"ai-ml": ["ai", "artificial intelligence", "machine learning", "deep learning", "ml", "llm", "generative ai"],
	marketing: ["growth", "content marketing", "social media marketing", "seo", "advertising", "branding"],
	design: ["ui", "ux", "ui ux", "user interface", "user experience", "graphic design", "visual design"],
	startups: ["startup", "founder", "founders", "entrepreneurship", "venture capital", "vc"],
	product: ["product management", "product manager", "roadmap", "user research", "customer discovery"],
	career: ["careers", "job search", "interview", "resume", "cv", "professional development"],
	devops: ["sre", "infrastructure", "cloud", "kubernetes", "docker", "ci cd", "continuous integration", "deployment"],
	security: ["cybersecurity", "cyber security", "infosec", "privacy", "application security", "appsec"],
	finance: ["personal finance", "investing", "investment", "stocks", "money", "economics", "fintech"],
	health: ["wellness", "fitness", "medicine", "medical", "mental health", "nutrition"],
};

for (const topic of TOPIC_DEFINITIONS) {
	TOPIC_BY_KEY.set(topicKey(topic.id), topic.id);
	TOPIC_BY_KEY.set(topicKey(topic.label), topic.id);
	for (const alias of aliases[topic.id]) TOPIC_BY_KEY.set(topicKey(alias), topic.id);
}

export function topicDefinition(id: string): (typeof TOPIC_DEFINITIONS)[number] | undefined {
	return TOPIC_BY_ID.get(id as TopicId);
}

/** Maps only exact canonical names and approved aliases; unknown output is dropped. */
export function canonicalTopicId(value: unknown): TopicId | undefined {
	return typeof value === "string" ? TOPIC_BY_KEY.get(topicKey(value)) : undefined;
}

export function canonicalizeTopicIds(values: unknown, max = 3): TopicId[] {
	if (!Array.isArray(values)) return [];
	const boundedMax = Math.min(Math.max(Math.trunc(max), 1), 3);
	const result: TopicId[] = [];
	for (const value of values) {
		const id = canonicalTopicId(value);
		if (id && !result.includes(id)) result.push(id);
		if (result.length >= boundedMax) break;
	}
	return result;
}
