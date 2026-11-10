import type { ExtensionStatus } from "../lib/source-state.ts";

/**
 * The extension's state as a dot. Colour carries the meaning (see `extensionStatus`);
 * "not connected yet" is a hollow ring so it differs by shape too, not only by grey.
 */
export function StatusDot({ status }: { status: Pick<ExtensionStatus, "state" | "tone"> }) {
	return <span aria-hidden="true" className="status-dot" data-tone={status.tone} data-state={status.state} />;
}
