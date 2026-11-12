import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@anansi/ui/components/alert-dialog";
import { Badge } from "@anansi/ui/components/badge";
import { Button } from "@anansi/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@anansi/ui/components/dropdown-menu";
import { Input } from "@anansi/ui/components/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@anansi/ui/components/tooltip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, MoreHorizontal, Plus, RotateCcw } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { toast } from "sonner";
import { api, type PasskeyRow } from "../lib/api.ts";
import { addPasskey, PASSKEY_LIMIT, passkeyError, passkeyMeta, passkeysKey, sessionKey } from "../lib/passkey.ts";
import { SettingsNotice, SettingsRow } from "./settings-panel.tsx";
import { SettingsSkeleton } from "./skeleton.tsx";

const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;

/** Settings › Sign-in: the passkeys that open this library, and signing out. */
export function PasskeySettings() {
	const queryClient = useQueryClient();
	const list = useQuery({ queryKey: passkeysKey, queryFn: () => api.listPasskeys().then((r) => r.passkeys) });
	const [editing, setEditing] = useState<string | null>(null);
	const [removing, setRemoving] = useState<PasskeyRow | null>(null);

	const setSession = () => queryClient.setQueryData(sessionKey, (prev: { configured: boolean } | undefined) => ({ configured: prev?.configured ?? true, authenticated: true, hasPasskey: true }));

	const add = useMutation({
		mutationFn: () => addPasskey(),
		onSuccess: (row) => {
			queryClient.setQueryData<PasskeyRow[]>(passkeysKey, (rows = []) => [...rows, row]);
			setSession();
			setEditing(row.id);
		},
		onError: (error) => {
			const text = passkeyError(error);
			if (text) toast.error("Passkey not added", { description: text });
		},
	});

	const remove = useMutation({
		mutationFn: (row: PasskeyRow) => api.deletePasskey(row.id),
		onSuccess: (_, row) => {
			queryClient.setQueryData<PasskeyRow[]>(passkeysKey, (rows = []) => rows.filter((r) => r.id !== row.id));
			setRemoving(null);
		},
	});

	const signOut = useMutation({
		mutationFn: api.disconnect,
		onSuccess: (next) => {
			// Nothing from the library stays in memory once the session ends.
			queryClient.clear();
			queryClient.setQueryData(sessionKey, next);
		},
		onError: (error) => toast.error("Couldn’t sign out", { description: passkeyError(error) ?? undefined }),
	});

	if (list.isPending) return <SettingsSkeleton label="Loading passkeys" />;
	if (list.isError) {
		return (
			<SettingsNotice tone="danger" icon={<AlertCircle {...ICON} />}>
				Couldn’t load passkeys
				<Button variant="outline" className="passkey-retry" onClick={() => void list.refetch()} disabled={list.isFetching}>
					<RotateCcw {...ICON} />
					Try again
				</Button>
			</SettingsNotice>
		);
	}

	const rows = list.data;
	const full = rows.length >= PASSKEY_LIMIT;
	const addButton = (
		<Button variant={rows.length ? "outline" : "default"} disabled={full || add.isPending} onClick={() => add.mutate()}>
			<Plus {...ICON} />
			{add.isPending ? "Waiting for passkey" : "Add passkey"}
		</Button>
	);

	return (
		<>
			{rows.length === 0 ? (
				<SettingsRow title="No passkeys yet" description="You sign in with the recovery secret" control={addButton} />
			) : (
				<>
					{rows.map((row) =>
						editing === row.id ? (
							<RenameRow key={row.id} row={row} onDone={() => setEditing(null)} />
						) : (
							<SettingsRow
								key={row.id}
								title={<span className="passkey-name">{row.name}</span>}
								badge={row.backedUp ? <Badge variant="outline" className="settings-badge">Synced</Badge> : undefined}
								description={passkeyMeta(row)}
								control={
									<PasskeyMenu
										row={row}
										only={rows.length === 1}
										onRename={() => setEditing(row.id)}
										onRemove={() => {
											remove.reset();
											setRemoving(row);
										}}
									/>
								}
							/>
						),
					)}
					<SettingsRow
						title="Add a passkey"
						description={full ? `Limit of ${PASSKEY_LIMIT} reached` : "Another device or password manager"}
						control={addButton}
					/>
				</>
			)}
			<SettingsRow
				title="This browser"
				description="Stays signed in while you use it"
				control={
					<Button variant="outline" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
						{signOut.isPending ? "Signing out" : "Sign out"}
					</Button>
				}
			/>

			<AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open && !remove.isPending) setRemoving(null); }}>
				<AlertDialogContent className="settings-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
						<AlertDialogDescription>It stops signing in to this library</AlertDialogDescription>
					</AlertDialogHeader>
					{remove.isError && <p className="settings-inline-danger" role="alert">{passkeyError(remove.error)}</p>}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={remove.isPending}>Keep it</AlertDialogCancel>
						<Button variant="destructive" disabled={remove.isPending} onClick={() => removing && remove.mutate(removing)}>
							{remove.isPending ? "Removing" : "Remove passkey"}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function PasskeyMenu({ row, only, onRename, onRemove }: { row: PasskeyRow; only: boolean; onRename: () => void; onRemove: () => void }) {
	const removeItem = (
		<DropdownMenuItem variant="destructive" disabled={only} onClick={onRemove}>
			Remove…
		</DropdownMenuItem>
	);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="client-more" aria-label={`More for ${row.name}`} />}>
				<MoreHorizontal {...ICON} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="client-menu">
				<DropdownMenuItem onClick={onRename}>Rename</DropdownMenuItem>
				{only ? (
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger render={<div />}>{removeItem}</TooltipTrigger>
							<TooltipContent side="left" className="passkey-tip">Add another passkey first</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				) : (
					removeItem
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function RenameRow({ row, onDone }: { row: PasskeyRow; onDone: () => void }) {
	const queryClient = useQueryClient();
	const [name, setName] = useState(row.name);
	const rename = useMutation({
		mutationFn: (next: string) => api.renamePasskey(row.id, next),
		onSuccess: ({ passkey }) => {
			queryClient.setQueryData<PasskeyRow[]>(passkeysKey, (rows = []) => rows.map((r) => (r.id === passkey.id ? passkey : r)));
			onDone();
		},
	});
	const trimmed = name.trim();
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (trimmed === row.name) return onDone();
		if (trimmed) rename.mutate(trimmed);
	};
	const escape = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onDone();
		}
	};
	const error = rename.isError ? passkeyError(rename.error) : null;

	return (
		<div className="settings-row">
			<form className="passkey-rename" onSubmit={submit} onKeyDown={escape}>
				<Input
					aria-label="Passkey name"
					className="client-input passkey-rename-input"
					autoFocus
					onFocus={(event) => event.currentTarget.select()}
					maxLength={60}
					value={name}
					disabled={rename.isPending}
					aria-invalid={error ? true : undefined}
					onChange={(event) => setName(event.target.value)}
				/>
				<Button type="button" variant="ghost" disabled={rename.isPending} onClick={onDone}>Cancel</Button>
				<Button type="submit" disabled={!trimmed || rename.isPending}>{rename.isPending ? "Saving" : "Save"}</Button>
			</form>
			{error && <p className="settings-inline-danger passkey-rename-error" role="alert">{error}</p>}
		</div>
	);
}
