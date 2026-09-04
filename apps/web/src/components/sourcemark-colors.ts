const BRAND: Record<string, string> = {
	x: "#e6ebef",
	github: "#e6ebef",
	reddit: "#ff4500",
	tiktok: "#25f4ee",
	// Not a brand. A cool blue reads as "a website" beside four saturated logos.
	web: "#7fa9cc",
};

export function sourceMarkColor(source: string): string {
	return BRAND[source] ?? "var(--text)";
}
