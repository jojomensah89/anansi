/**
 * The few Lucide icons the popup uses (ISC licence), inlined so the popup
 * bundle does not take a dependency for nine paths. 16px, stroke 1.5.
 */
import type { ReactNode } from "react";

const SHAPES = {
	sliders: (
		<>
			<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
		</>
	),
	back: (
		<>
			<path d="m12 19-7-7 7-7" />
			<path d="M19 12H5" />
		</>
	),
	globe: (
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
			<path d="M2 12h20" />
		</>
	),
	bookmarkPlus: (
		<>
			<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
			<path d="M12 7v6M15 10H9" />
		</>
	),
	check: <path d="M20 6 9 17l-5-5" />,
	pause: (
		<>
			<rect x="14" y="4" width="4" height="16" rx="1" />
			<rect x="6" y="4" width="4" height="16" rx="1" />
		</>
	),
	play: <path d="M6 3l14 9-14 9z" />,
	arrowUpRight: (
		<>
			<path d="M7 7h10v10" />
			<path d="M7 17 17 7" />
		</>
	),
	alert: (
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 8v4M12 16h.01" />
		</>
	),
	chevronRight: <path d="m9 18 6-6-6-6" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof SHAPES;

export function Icon({ name, className }: { name: IconName; className?: string }) {
	return (
		<svg
			className={className ? `icon ${className}` : "icon"}
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{SHAPES[name]}
		</svg>
	);
}
