import {
	Archive, BookOpen, Calendar, Bookmark, Brain, Briefcase, Camera, ChartLine, Code, Coffee, Compass, Cpu,
	Database, Dumbbell, Film, FlaskConical, Flag, Folder, Gamepad2, Gift, Globe, GraduationCap, Hammer, Hash,
	Headphones, Heart, HeartPulse, House, Image, Inbox, Layers, Leaf, Library, Lightbulb, Link, MapPin, Megaphone,
	Mountain, Music, Newspaper, Notebook, Package, Palette, PenTool, Plane, Quote, Rocket, Server, Shield, Shirt,
	ShoppingBag, Sprout, Star, Tag, Target, Telescope, Tent, Terminal, Trophy, Users, Utensils, Video, Wallet, Wrench,
	type LucideIcon,
} from "lucide-react";
import type { ShelfColor } from "../lib/api.ts";
import { shelfColor } from "../lib/shelves.ts";

/**
 * The icons a shelf can wear.
 *
 * A curated set about saving and reading rather than the whole of lucide: a
 * picker of four thousand icons is a search box, not a choice, and most of
 * them say nothing about a shelf of saves. Each has a few words the search
 * field matches, so "food" finds the fork and "money" finds the wallet.
 */
export interface ShelfIconOption {
	name: string;
	label: string;
	icon: LucideIcon;
	words: string;
}

const option = (name: string, icon: LucideIcon, words = ""): ShelfIconOption => ({
	name,
	label: name.replace(/-\d+$/, "").replace(/-/g, " "),
	icon,
	words: `${name.replace(/-/g, " ")} ${words}`.toLowerCase(),
});

export const SHELF_ICONS: ShelfIconOption[] = [
	option("folder", Folder, "files general"),
	option("bookmark", Bookmark, "save later"),
	option("star", Star, "favourite favorite best"),
	option("heart", Heart, "love like"),
	option("flag", Flag, "important mark"),
	option("tag", Tag, "label"),
	option("layers", Layers, "stack collection"),
	option("hash", Hash, "topic channel"),
	option("inbox", Inbox, "later queue"),
	option("archive", Archive, "box keep"),
	option("library", Library, "books shelf"),
	option("book-open", BookOpen, "read reading books"),
	option("notebook", Notebook, "notes journal"),
	option("newspaper", Newspaper, "news articles"),
	option("quote", Quote, "quotes words"),
	option("pen-tool", PenTool, "design vector"),
	option("palette", Palette, "design art colour color"),
	option("image", Image, "photo pictures"),
	option("camera", Camera, "photo photography"),
	option("film", Film, "movies cinema"),
	option("video", Video, "videos watch"),
	option("music", Music, "songs audio"),
	option("headphones", Headphones, "podcast listen audio"),
	option("lightbulb", Lightbulb, "ideas inspiration"),
	option("brain", Brain, "ai ml thinking"),
	option("code", Code, "programming dev"),
	option("terminal", Terminal, "cli shell dev"),
	option("cpu", Cpu, "hardware chips"),
	option("server", Server, "homelab devops hosting"),
	option("database", Database, "data storage"),
	option("link", Link, "links web"),
	option("globe", Globe, "web world internet"),
	option("rocket", Rocket, "startups launch"),
	option("chart-line", ChartLine, "finance money stocks growth"),
	option("wallet", Wallet, "money finance"),
	option("briefcase", Briefcase, "work career job"),
	option("megaphone", Megaphone, "marketing"),
	option("target", Target, "goals"),
	option("trophy", Trophy, "sport win"),
	option("users", Users, "people team"),
	option("graduation-cap", GraduationCap, "learning school study"),
	option("flask-conical", FlaskConical, "science lab"),
	option("telescope", Telescope, "space astronomy"),
	option("shield", Shield, "security privacy"),
	option("gamepad-2", Gamepad2, "gaming games"),
	option("dumbbell", Dumbbell, "fitness gym health"),
	option("heart-pulse", HeartPulse, "health medical"),
	option("utensils", Utensils, "food recipes cooking"),
	option("coffee", Coffee, "cafe drink lifestyle"),
	option("leaf", Leaf, "nature plants"),
	option("sprout", Sprout, "garden grow"),
	option("mountain", Mountain, "outdoors hiking"),
	option("tent", Tent, "camping outdoors"),
	option("plane", Plane, "travel trips flights"),
	option("map-pin", MapPin, "places travel location"),
	option("compass", Compass, "explore travel"),
	option("house", House, "home interiors"),
	option("hammer", Hammer, "diy build"),
	option("wrench", Wrench, "tools fix"),
	option("shopping-bag", ShoppingBag, "shopping buy wishlist"),
	option("shirt", Shirt, "fashion clothes"),
	option("gift", Gift, "presents wishlist"),
	option("package", Package, "product box"),
	option("calendar", Calendar, "events dates"),
];

const BY_NAME = new Map(SHELF_ICONS.map((entry) => [entry.name, entry]));

export function shelfIconOption(name: string | null | undefined): ShelfIconOption {
	return (name && BY_NAME.get(name)) || BY_NAME.get("folder")!;
}

/** Every word of the query must appear among the icon's words. */
export function searchShelfIcons(query: string): ShelfIconOption[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return SHELF_ICONS;
	return SHELF_ICONS.filter((entry) => words.every((word) => entry.words.includes(word)));
}

/** A shelf's icon in its colour: 16px, 1.5 stroke, like every icon in the rail. */
export function ShelfIcon({ icon, color, size = 16, className }: { icon: string | null | undefined; color: ShelfColor | null | undefined; size?: number; className?: string }) {
	const Icon = shelfIconOption(icon).icon;
	return <Icon aria-hidden="true" size={size} strokeWidth={1.5} className={className} style={{ color: shelfColor(color), flex: "none" }} />;
}
