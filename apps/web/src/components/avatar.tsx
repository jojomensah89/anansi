import type { CSSProperties } from "react";

/**
 * A deterministic visual identity for sources that do not provide avatars.
 * Reddit saved listings commonly have no profile image, so an initial is more
 * informative than a blank placeholder while the author text remains the
 * accessible name.
 */
const INITIAL_TINTS = [
	"#c76b45",
	"#6d66c8",
	"#398f7c",
	"#b66b61",
	"#6f9348",
	"#547ab4",
	"#a85985",
	"#ad8235",
] as const;

export function avatarLabelFor(seed?: string | null): string {
	return (seed ?? "").trim().replace(/^@/, "");
}

export function avatarTintFor(seed: string): string {
	let hash = 0;
	for (let i = 0; i < seed.length; i++)
		hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
	return INITIAL_TINTS[hash % INITIAL_TINTS.length];
}

const TRUSTED_AVATAR_HOSTS = [
	"pbs.twimg.com",
	"abs.twimg.com",
	"avatars.githubusercontent.com",
	"github.com",
	"styles.redditmedia.com",
	"www.redditstatic.com",
	"tiktokcdn.com",
	"tiktokcdn-us.com",
] as const;

/** Keep avatar loads local or on the provider CDNs that produce them. */
export function storedAvatarSource(src?: string | null): string | null {
	if (!src) return null;
	if (src.startsWith("/api/media/")) return src;
	try {
		const url = new URL(src);
		const host = url.hostname.toLowerCase();
		if (url.protocol !== "https:") return null;
		if (TRUSTED_AVATAR_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return url.href;
	} catch {
		// Invalid persisted metadata gets the deterministic initial below.
	}
	return null;
}

export function Avatar({
	src,
	size,
	square,
	seed,
}: {
	src?: string | null;
	size: number;
	square?: boolean;
	/** The handle or name used to keep the fallback stable across views. */
	seed?: string | null;
}) {
	const radius = square ? 4 : "50%";
	const label = avatarLabelFor(seed);
	const storedSrc = storedAvatarSource(src);

	if (!storedSrc) {
		const style: CSSProperties = {
			width: size,
			height: size,
			borderRadius: radius,
			background: label ? avatarTintFor(label) : "var(--edge-strong)",
			color: "#f4f7fa",
			flexShrink: 0,
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			fontSize: Math.max(8, Math.round(size * 0.44)),
			fontWeight: 600,
			textTransform: "uppercase",
		};

		return (
			<span aria-hidden="true" style={style}>
				{label.slice(0, 1)}
			</span>
		);
	}

	return (
		<img
			src={storedSrc}
			alt=""
			width={size}
			height={size}
			loading="lazy"
			style={{
				borderRadius: radius,
				flexShrink: 0,
				objectFit: "cover",
				background: "var(--edge-strong)",
			}}
		/>
	);
}
