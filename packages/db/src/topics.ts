export const TOPIC_TAXONOMY_VERSION = "v2" as const;

/**
 * The fixed list Clef chooses from. v2 widens it past tech and business so
 * the entertainment, food, gaming and hardware saves that fill a social
 * library get a home. Descriptions go into Clef's question, so they say what
 * belongs, not what the label already says.
 */
export const TOPIC_DEFINITIONS = [
	{ id: "web-dev", label: "Web Dev", color: "#22c55e", description: "Programming, software, apps, frameworks and developer tools." },
	{ id: "ai-ml", label: "AI / ML", color: "#3b82f6", description: "AI models, chatbots, agents, machine learning and AI tools." },
	{ id: "marketing", label: "Marketing", color: "#14b8a6", description: "Growth, ads, content, social media strategy and branding." },
	{ id: "design", label: "Design", color: "#eab308", description: "UI, UX, graphic design, typography and visual work." },
	{ id: "startups", label: "Startups", color: "#ec4899", description: "Founding, running or funding a business, side projects and SaaS." },
	{ id: "product", label: "Product", color: "#8b5cf6", description: "Product management, product ideas, launches and user research." },
	{ id: "career", label: "Career", color: "#f97316", description: "Jobs, interviews, resumes and professional growth." },
	{ id: "devops", label: "DevOps", color: "#06b6d4", description: "Servers, cloud, self-hosting, deployment and infrastructure." },
	{ id: "security", label: "Security", color: "#ef4444", description: "Cybersecurity, privacy, hacking and scams." },
	{ id: "finance", label: "Finance", color: "#84cc16", description: "Money, investing, crypto, trading and personal finance." },
	{ id: "health", label: "Health", color: "#6366f1", description: "Fitness, exercise, nutrition, medicine and mental health." },
	{ id: "hardware", label: "Hardware & Networking", color: "#0ea5e9", description: "Computers, phones, gadgets, routers, WiFi, CCTV and home lab setups." },
	{ id: "entertainment", label: "Entertainment & Anime", color: "#f43f5e", description: "Anime, films, series, webnovels, comics, celebrities and memes." },
	{ id: "gaming", label: "Gaming", color: "#a855f7", description: "Video games, consoles, emulators and gaming setups." },
	{ id: "music", label: "Music", color: "#d946ef", description: "Songs, artists, music production and instruments." },
	{ id: "food-travel", label: "Food & Travel", color: "#f59e0b", description: "Cooking, recipes, restaurants, places and trips." },
	{ id: "science", label: "Science", color: "#10b981", description: "Physics, space, biology, research and how things work." },
	{ id: "learning", label: "Learning", color: "#64748b", description: "Courses, tutorials, study tips, books and free education." },
	{ id: "lifestyle", label: "Lifestyle", color: "#fb7185", description: "Home, fashion, relationships, productivity habits and daily life." },
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
	// Only names specific enough that a manual tag using them means the topic.
	hardware: ["networking", "gadgets", "homelab", "home lab"],
	entertainment: ["anime", "movies", "manga", "webnovel"],
	gaming: ["video games", "esports"],
	music: ["music production"],
	"food-travel": ["cooking", "recipes"],
	science: ["physics", "astronomy"],
	learning: ["online courses", "tutorials"],
	lifestyle: ["fashion"],
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
