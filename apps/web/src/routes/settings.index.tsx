import { createFileRoute, redirect } from "@tanstack/react-router";
import { settingsSectionForHash } from "../lib/settings-sections.ts";

/** `/settings` opens the first area; an old `/settings#ai` link opens AI. */
export const Route = createFileRoute("/settings/")({
	beforeLoad: ({ location }) => {
		throw redirect({ to: "/settings/$section", params: { section: settingsSectionForHash(location.hash) }, replace: true });
	},
});
