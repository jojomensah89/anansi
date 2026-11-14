import { type CSSProperties, useCallback, useState } from "react";

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

type AvatarStatus = "loading" | "loaded" | "failed";

/**
 * A provider avatar over the author's initial.
 *
 * TikTok and X avatar URLs are signed CDN links that expire, so a stored URL
 * failing is routine rather than exceptional. The image stays invisible until
 * it has actually decoded, and a failure swaps in the initial, so the
 * browser's broken-image glyph can never show. A load that settled before
 * hydration attached `onError` is caught by checking the element on mount.
 */
export function Avatar({
	src,
	size,
	square,
	seed,
	name,
}: {
	src?: string | null;
	size: number;
	square?: boolean;
	/** The handle or name used to keep the fallback stable across views. */
	seed?: string | null;
	/** The display name, when it differs from the seed: the initial comes from it. */
	name?: string | null;
}) {
	const radius = square ? 4 : "50%";
	const label = avatarLabelFor(seed);
	const initial = (avatarLabelFor(name) || label).slice(0, 1);
	const storedSrc = storedAvatarSource(src);
	const [state, setState] = useState<{ src: string | null; status: AvatarStatus }>({
		src: storedSrc,
		status: "loading",
	});
	// A new URL starts over; derived during render so no stale frame shows.
	const status: AvatarStatus = state.src === storedSrc ? state.status : "loading";
	const settle = useCallback(
		(next: AvatarStatus) => setState({ src: storedSrc, status: next }),
		[storedSrc],
	);
	const checkSettled = useCallback(
		(img: HTMLImageElement | null) => {
			if (!img || !img.complete) return;
			settle(img.naturalWidth > 0 ? "loaded" : "failed");
		},
		[settle],
	);

	const showImage = storedSrc !== null && status !== "failed";
	const style: CSSProperties = {
		position: "relative",
		width: size,
		height: size,
		borderRadius: radius,
		overflow: "hidden",
		background:
			showImage || !label ? "var(--edge-strong)" : avatarTintFor(label),
		color: "#f4f7fa",
		flexShrink: 0,
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		fontSize: Math.max(8, Math.round(size * 0.44)),
		fontWeight: 600,
		lineHeight: 1,
		textTransform: "uppercase",
	};

	return (
		<span aria-hidden="true" data-avatar={showImage ? status : "initial"} style={style}>
			{showImage ? (
				<img
					key={storedSrc}
					ref={checkSettled}
					src={storedSrc}
					alt=""
					width={size}
					height={size}
					loading="lazy"
					decoding="async"
					onLoad={() => settle("loaded")}
					onError={() => settle("failed")}
					style={{
						position: "absolute",
						inset: 0,
						width: "100%",
						height: "100%",
						objectFit: "cover",
						opacity: status === "loaded" ? 1 : 0,
						transition: "opacity 120ms var(--ease-ui)",
					}}
				/>
			) : (
				initial
			)}
		</span>
	);
}
