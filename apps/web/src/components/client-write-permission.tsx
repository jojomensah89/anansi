import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@anansi/ui/components/alert-dialog";
import { Button } from "@anansi/ui/components/button";
import { Switch } from "@anansi/ui/components/switch";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type PermissionClient = { id: string; name: string; kind: string; scopes: string; revokedAt: number | null };

/**
 * Read only ↔ read and write for one agent. Turning changes on asks first;
 * turning them off takes effect at once. Owner session, same origin.
 */
export function ClientWritePermission({ client, onChange }: { client: PermissionClient; onChange: () => void }) {
	const enabled = client.scopes.split(",").includes("write");
	const [pending, setPending] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const [optimistic, setOptimistic] = useState<boolean | null>(null);
	useEffect(() => setOptimistic(null), [client.scopes]);
	if (client.revokedAt !== null || !["api", "app"].includes(client.kind)) return null;

	async function save(write: boolean) {
		setPending(true);
		setOptimistic(write);
		try {
			const response = await fetch(`/api/clients/${encodeURIComponent(client.id)}/permissions`, {
				method: "PATCH",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ write }),
			});
			if (!response.ok) throw new Error();
			setConfirm(false);
			onChange();
		} catch {
			setOptimistic(null);
			toast.error(`Couldn’t change access for ${client.name}`);
		} finally {
			setPending(false);
		}
	}

	const on = optimistic ?? enabled;
	return (
		<div className="client-access">
			<div className="client-access-line">
				<Switch
					aria-label={`Allow changes for ${client.name}`}
					checked={on}
					disabled={pending}
					onCheckedChange={(next) => (next ? setConfirm(true) : void save(false))}
				/>
				<span data-on={on || undefined}>{on ? "Read and write" : "Read only"}</span>
			</div>
			<AlertDialog open={confirm} onOpenChange={(open) => { if (!pending) setConfirm(open); }}>
				<AlertDialogContent className="settings-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>Allow {client.name} to make changes?</AlertDialogTitle>
						<AlertDialogDescription>It can add tags, notes and save links. It can never delete</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={pending}>Keep read-only</AlertDialogCancel>
						<Button disabled={pending} onClick={() => void save(true)}>
							{pending ? "Saving" : "Allow changes"}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
