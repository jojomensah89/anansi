import type { ReactNode } from "react";

/**
 * One settings panel: a header that names it in a line, then rows split by
 * hairlines. Each row puts its label and a one-line description on the left
 * and the control on the right; anything that only exists while the control
 * is on (progress, a cap, a status) sits underneath, full width.
 */
export function SettingsSection({
	id,
	title,
	lead,
	action,
	children,
}: {
	id: string;
	title: ReactNode;
	lead?: ReactNode;
	/** Sits at the right of the header: a count, or the panel's one action. */
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section id={id} className="settings-panel" aria-labelledby={`${id}-title`}>
			<header className="settings-panel-head">
				<div className="settings-panel-copy">
					<h2 id={`${id}-title`}>{title}</h2>
					{lead && <p>{lead}</p>}
				</div>
				{action && <div className="settings-panel-action">{action}</div>}
			</header>
			<div className="settings-panel-rows">{children}</div>
		</section>
	);
}

export function SettingsRow({
	title,
	icon,
	badge,
	description,
	tone,
	control,
	wide,
	children,
}: {
	title: ReactNode;
	icon?: ReactNode;
	badge?: ReactNode;
	description?: ReactNode;
	/** Colour of the description when it reports a problem. */
	tone?: "warn" | "danger";
	control?: ReactNode;
	/** A control too wide to sit beside the label on a phone (a field, a list): it drops underneath there. */
	wide?: boolean;
	children?: ReactNode;
}) {
	return (
		<div className="settings-row" data-wide={wide || undefined}>
			<div className="settings-row-copy">
				<div className="settings-row-title">
					{icon}
					{title}
					{badge}
				</div>
				{description && (
					<div className="settings-row-description" data-tone={tone}>
						{description}
					</div>
				)}
			</div>
			{control && <div className="settings-row-control">{control}</div>}
			{children && <div className="settings-row-sub">{children}</div>}
		</div>
	);
}

/** A whole-row message: a neutral notice, or an error that names what failed. */
export function SettingsNotice({ children, tone = "neutral", icon }: { children: ReactNode; tone?: "neutral" | "danger"; icon?: ReactNode }) {
	return (
		<div className="settings-row">
			<div className="settings-notice" data-tone={tone} role={tone === "danger" ? "alert" : undefined}>
				{icon}
				<span>{children}</span>
			</div>
		</div>
	);
}

/** "today at 07:42", "yesterday at 21:05", or the date for anything older. */
export function checkedLabel(unix: number, now = Date.now()): string {
	const date = new Date(unix * 1000);
	const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const days = Math.round((day(new Date(now)) - day(date)) / 86_400_000);
	if (days === 0) return `today at ${time}`;
	if (days === 1) return `yesterday at ${time}`;
	return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}
