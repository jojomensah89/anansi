import { Button } from "@anansi/ui/components/button";
import { Input } from "@anansi/ui/components/input";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api.ts";
import { restoreLibraryFile } from "../lib/restore-library.ts";
import { SettingsRow } from "./settings-panel.tsx";

const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;
const message = (error: unknown) => (error instanceof Error ? error.message : "The request failed.");

export function exportFileName(date = new Date()): string {
	return `anansi-library-${date.toISOString().slice(0, 10)}.json`;
}

/** Fetch the export and hand it to the browser as a download. */
export async function downloadLibraryExport(date = new Date()): Promise<void> {
	const blob = await api.exportLibrary();
	const href = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = href;
	link.download = exportFileName(date);
	link.click();
	URL.revokeObjectURL(href);
}

type RestoreView =
	| { state: "idle" }
	| { state: "running"; text: string }
	| { state: "done"; text: string }
	| { state: "failed"; text: string; abandonable: string | null };

/** Settings › Your data: export the library, or restore an export into an empty one. */
export function DataSettings() {
	const queryClient = useQueryClient();
	const fileRef = useRef<HTMLInputElement>(null);
	const [exporting, setExporting] = useState(false);
	const [restore, setRestore] = useState<RestoreView>({ state: "idle" });

	const exportAll = async () => {
		setExporting(true);
		try {
			await downloadLibraryExport();
			toast.success("Library export downloaded");
		} catch (error) {
			toast.error("Export failed", { description: message(error) });
		} finally {
			setExporting(false);
		}
	};

	const restoreFile = async (file: File) => {
		let last = "Checking export";
		setRestore({ state: "running", text: last });
		try {
			await restoreLibraryFile(file, (text) => {
				last = text;
				setRestore({ state: "running", text });
			});
			await queryClient.invalidateQueries();
			setRestore({ state: "done", text: last });
			toast.success("Library data restored");
		} catch (error) {
			let abandonable: string | null = null;
			try {
				const { restore: session } = await api.restoreStatus();
				if (session?.status === "active" && Object.values(session.progress).every((count) => count === 0)) abandonable = session.backupId;
			} catch { /* Keep the original restore error. */ }
			setRestore({ state: "failed", text: message(error), abandonable });
			toast.error("Restore stopped", { description: message(error) });
		}
	};

	const clearEmptyRestore = (backupId: string) => {
		void api.restoreAbort(backupId).then(() => {
			setRestore({ state: "done", text: "Empty restore cleared. Choose a corrected export" });
		}).catch((error) => toast.error("Could not clear the restore", { description: message(error) }));
	};

	const running = restore.state === "running";
	const description =
		restore.state === "idle" ? "Only into an empty library"
		: restore.state === "failed" ? `Stopped: ${restore.text}`
		: restore.text;

	return (
		<>
			<SettingsRow
				title="Export library"
				description="One JSON file, without media"
				control={
					<Button variant="outline" disabled={exporting} onClick={() => void exportAll()}>
						<Download {...ICON} />
						{exporting ? "Preparing" : "Export"}
					</Button>
				}
			/>
			<SettingsRow
				title="Restore from an export"
				description={<span role={restore.state === "failed" ? "alert" : "status"}>{description}</span>}
				tone={restore.state === "failed" ? "danger" : undefined}
				control={
					restore.state === "failed" && restore.abandonable ? (
						<Button variant="outline" onClick={() => clearEmptyRestore(restore.abandonable!)}>Clear empty restore</Button>
					) : (
						<>
							<Input
								ref={fileRef}
								type="file"
								accept=".json,application/json"
								className="sr-only"
								tabIndex={-1}
								aria-hidden="true"
								disabled={running}
								onChange={(event) => {
									const file = event.currentTarget.files?.[0];
									event.currentTarget.value = "";
									if (file) void restoreFile(file);
								}}
							/>
							<Button variant="outline" disabled={running} onClick={() => fileRef.current?.click()}>
								<Upload {...ICON} />
								{running ? "Restoring" : "Choose file"}
							</Button>
						</>
					)
				}
			/>
		</>
	);
}
