import { createFileRoute, redirect } from "@tanstack/react-router";
import { SettingsSectionContent } from "../components/settings-sections.tsx";
import { DEFAULT_SETTINGS_SECTION, settingsSection } from "../lib/settings-sections.ts";

export const Route = createFileRoute("/_app/settings/$section")({
	beforeLoad: ({ params }) => {
		if (!settingsSection(params.section)) {
			throw redirect({ to: "/settings/$section", params: { section: DEFAULT_SETTINGS_SECTION }, replace: true });
		}
	},
	component: SettingsSectionPage,
});

function SettingsSectionPage() {
	const { section: id } = Route.useParams();
	const section = settingsSection(id);
	if (!section) return null;
	return (
		// Keyed so a section's own state (an open edit, a dialog) starts fresh on each visit.
		<div key={section.id} className="settings-section-page">
			<SettingsSectionContent section={section.id} />
		</div>
	);
}
