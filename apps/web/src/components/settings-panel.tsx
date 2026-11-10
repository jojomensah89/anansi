import type { ReactNode } from "react";

/**
 * Settings layout: a label column naming the area, then one panel of rows.
 * Rows put the control on the right and anything that only exists while the
 * control is on (progress, a cap, a status) underneath, full width.
 */
export function SettingsSection({ id, title, lead, children }: { id: string; title: string; lead?: ReactNode; children: ReactNode }) {
	return (
		<section id={id} className="settings-section" aria-labelledby={`${id}-title`}>
			<div className="settings-section-head">
				<h2 id={`${id}-title`}>{title}</h2>
				{lead && <p>{lead}</p>}
			</div>
			<div className="settings-panel">{children}</div>
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
	children,
}: {
	title: ReactNode;
	icon?: ReactNode;
	badge?: ReactNode;
	description?: ReactNode;
	/** Colour of the description when it reports a problem. */
	tone?: "warn" | "danger";
	control?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="settings-row">
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
