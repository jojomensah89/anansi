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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@anansi/ui/components/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@anansi/ui/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@anansi/ui/components/dropdown-menu";
import { Input } from "@anansi/ui/components/input";
import { Label } from "@anansi/ui/components/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@anansi/ui/components/table";
import { AlertCircle, Bot, Check, ChevronDown, ChevronRight, Copy, KeyRound, MoreHorizontal, Pencil, Plus, RotateCcw } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ClientWritePermission } from "./client-write-permission.tsx";

const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;

export type Client = {
	id: string;
	name: string;
	kind: string;
	scopes: string;
	lastUse: number | null;
	revokedAt: number | null;
};
type KeyKind = "api" | "extension";

async function call(path = "", method = "GET", body?: unknown) {
	const response = await fetch(`/api/clients${path}`, {
		method,
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) throw new Error("Couldn’t reach the server. Try again");
	return response.json() as Promise<{ id: string; clients: Client[]; legacyActive: boolean; key: string }>;
}

/** "just now", "4 min ago", "yesterday", "12 days ago". */
export function ago(unix: number | null, now = Date.now()): string {
	if (!unix) return "Never";
	const minutes = Math.max(0, Math.floor((now / 1000 - unix) / 60));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
	if (minutes < 2880) return "yesterday";
	return `${Math.floor(minutes / 1440)} days ago`;
}

const TYPE: Record<string, string> = { app: "App", api: "API key", extension: "Extension" };

function KindIcon({ kind }: { kind: string }) {
	if (kind === "extension") return <img className="client-kind-mark" src="/favicon.png" width={16} height={16} alt="" aria-hidden="true" />;
	return kind === "app" ? <Bot {...ICON} /> : <KeyRound {...ICON} />;
}

function CopyValue({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="outline"
			aria-label={copied ? "Copied" : label}
			onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => setCopied(false))}
		>
			{copied ? <Check {...ICON} /> : <Copy {...ICON} />}
			{copied ? "Copied" : "Copy"}
		</Button>
	);
}

type Confirm = { kind: "revoke"; client: Client } | { kind: "retire" };
type Create = { kind: KeyKind; key: string | null };

/**
 * Everything that can reach the library: agents (apps and API keys), the
 * extension's capture keys, and the old shared token while it is still live.
 */
export function ConnectedClients() {
	const [data, setData] = useState<{ clients: Client[]; legacyActive: boolean } | null>(null);
	const [loadError, setLoadError] = useState("");
	const [busy, setBusy] = useState(false);
	const [create, setCreate] = useState<Create | null>(null);
	const [name, setName] = useState("");
	const [rename, setRename] = useState<Client | null>(null);
	const [draft, setDraft] = useState("");
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	const gate = useRef(false);

	const refresh = async () => {
		const next = await call();
		setData(next);
		setLoadError("");
	};
	const load = () => void refresh().catch((e: Error) => setLoadError(e.message));
	useEffect(load, []);

	/** One request at a time. A failure is a toast; the dialog stays open to try again. */
	async function action(failure: string, work: () => Promise<void>) {
		if (gate.current) return false;
		gate.current = true;
		setBusy(true);
		try {
			await work();
			await refresh().catch(() => undefined);
			return true;
		} catch (e) {
			toast.error(failure, { description: e instanceof Error && e.message ? e.message : undefined });
			return false;
		} finally {
			gate.current = false;
			setBusy(false);
		}
	}

	const clients = data?.clients.filter((c) => c.kind !== "pairing") ?? [];
	const active = clients.filter((c) => c.revokedAt === null);
	const revoked = clients.filter((c) => c.revokedAt !== null);
	const empty = data !== null && active.length === 0 && !data.legacyActive;

	const startCreate = (kind: KeyKind) => {
		setName("");
		setCreate({ kind, key: null });
	};
	const submitCreate = (event: FormEvent) => {
		event.preventDefault();
		if (!create || !name.trim()) return;
		void action("Couldn’t create the key", async () => {
			const result = await call("", "POST", { kind: create.kind, name: name.trim() });
			setCreate({ kind: create.kind, key: result.key });
		});
	};
	const submitRename = (event: FormEvent) => {
		event.preventDefault();
		if (!rename || !draft.trim()) return;
		void action("Couldn’t rename", async () => {
			await call(`/${rename.id}`, "PATCH", { name: draft.trim() });
		}).then((ok) => ok && setRename(null));
	};
	const runConfirm = () => {
		if (!confirm) return;
		void action(confirm.kind === "retire" ? "Couldn’t retire the token" : "Couldn’t revoke access", async () => {
			if (confirm.kind === "retire") await call("/retire-legacy", "POST");
			else await call(`/${confirm.client.id}`, "DELETE");
		}).then((ok) => ok && setConfirm(null));
	};

	const createMenu = (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button variant="outline" className="client-create" disabled={data === null} />}>
				<Plus {...ICON} />
				Create key
				<ChevronDown {...ICON} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="client-menu client-create-menu">
				<DropdownMenuItem onClick={() => startCreate("api")}>
					<span className="client-menu-copy">
						<span>API key</span>
						<span className="client-menu-meta">Read access for agents and scripts</span>
					</span>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => startCreate("extension")}>
					<span className="client-menu-copy">
						<span>Capture key</span>
						<span className="client-menu-meta">Save only, to connect the extension by hand</span>
					</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);

	const row = (c: Client) => {
		const off = c.revokedAt !== null;
		return (
			<TableRow key={c.id} data-off={off || undefined}>
				<TableCell>
					<div className="client-name">
						<span className="client-kind"><KindIcon kind={c.kind} /></span>
						<span className="client-name-text">
							<span className="client-title">{c.name}</span>
							<span className="client-meta">{TYPE[c.kind] ?? c.kind}{off ? "" : ` · ${ago(c.lastUse)}`}</span>
						</span>
					</div>
				</TableCell>
				<TableCell className="client-col-type">{TYPE[c.kind] ?? c.kind}</TableCell>
				<TableCell className="client-col-access">
					{off ? <span className="client-dim">Revoked {ago(c.revokedAt)}</span>
					: c.kind === "extension" ? <span className="client-dim">Save only</span>
					: <ClientWritePermission client={c} onChange={load} />}
				</TableCell>
				<TableCell className="client-col-used">{ago(c.lastUse)}</TableCell>
				<TableCell className="client-col-menu">
					{!off && (
						<DropdownMenu>
							<DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="client-more" aria-label={`More for ${c.name}`} />}>
								<MoreHorizontal {...ICON} />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="client-menu">
								<DropdownMenuItem onClick={() => { setDraft(c.name); setRename(c); }}>
									<Pencil {...ICON} />
									Rename
								</DropdownMenuItem>
								<DropdownMenuItem variant="destructive" onClick={() => setConfirm({ kind: "revoke", client: c })}>
									Revoke…
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</TableCell>
			</TableRow>
		);
	};

	const head = (
		<TableHeader>
			<TableRow>
				<TableHead>Name</TableHead>
				<TableHead className="client-col-type">Type</TableHead>
				<TableHead className="client-col-access">Access</TableHead>
				<TableHead className="client-col-used">Last used</TableHead>
				<TableHead className="client-col-menu"><span className="sr-only">Actions</span></TableHead>
			</TableRow>
		</TableHeader>
	);

	return (
		<section className="mcp-panel clients-panel" aria-labelledby="connected-title">
			<div className="mcp-panel-head">
				<h2 id="connected-title">Connected</h2>
				{data && !empty && <span className="mcp-count">{active.length + (data.legacyActive ? 1 : 0)} active</span>}
				<div className="mcp-panel-tools">{createMenu}</div>
			</div>

			{loadError && (
				<div className="mcp-panel-message" role="alert" data-tone="danger">
					<AlertCircle {...ICON} />
					<span>Couldn’t load connected clients</span>
					<Button variant="outline" onClick={load}>
						<RotateCcw {...ICON} />
						Try again
					</Button>
				</div>
			)}
			{!data && !loadError && <p className="mcp-panel-message" role="status">Loading</p>}

			{empty && (
				<div className="clients-empty">
					<p className="clients-empty-title">No agents or browsers yet</p>
					<p>Set up an agent under Connect an agent, or the extension from <a href="/sources">Sources</a></p>
				</div>
			)}

			{data && !empty && (
				<Table className="clients-table">
					{head}
					<TableBody>
						{active.map(row)}
						{data.legacyActive && (
							<TableRow>
								<TableCell>
									<div className="client-name">
										<span className="client-kind"><KeyRound {...ICON} /></span>
										<span className="client-name-text">
											<span className="client-title">Old shared token</span>
											<span className="client-meta">Shared token</span>
										</span>
									</div>
								</TableCell>
								<TableCell className="client-col-type">Shared token</TableCell>
								<TableCell className="client-col-access"><span className="client-dim">Read and save</span></TableCell>
								<TableCell className="client-col-used">—</TableCell>
								<TableCell className="client-col-menu">
									<Button variant="destructive" className="client-retire" onClick={() => setConfirm({ kind: "retire" })}>
										Retire
									</Button>
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			)}

			{revoked.length > 0 && (
				<Collapsible className="clients-revoked">
					<CollapsibleTrigger className="clients-revoked-trigger">
						<ChevronRight {...ICON} />
						{revoked.length} revoked
					</CollapsibleTrigger>
					<CollapsibleContent>
						<Table className="clients-table">
							<TableBody>{revoked.map(row)}</TableBody>
						</Table>
					</CollapsibleContent>
				</Collapsible>
			)}

			<Dialog open={create !== null} onOpenChange={(open) => { if (!open && !busy) setCreate(null); }}>
				<DialogContent className="settings-dialog">
					{create?.key ? (
						<>
							<DialogHeader>
								<DialogTitle>Copy your key now</DialogTitle>
								<DialogDescription>Shown once. Store it somewhere safe</DialogDescription>
							</DialogHeader>
							<div className="settings-joined">
								<code className="connect-value">{create.key}</code>
								<CopyValue value={create.key} label="Copy key" />
							</div>
							<DialogFooter>
								<Button variant="outline" onClick={() => setCreate(null)}>Done</Button>
							</DialogFooter>
						</>
					) : (
						<form onSubmit={submitCreate} className="client-form">
							<DialogHeader>
								<DialogTitle>{create?.kind === "extension" ? "Create a capture key" : "Create an API key"}</DialogTitle>
								<DialogDescription>
									{create?.kind === "extension" ? "Save only, for connecting the extension by hand" : "Read only until you allow changes"}
								</DialogDescription>
							</DialogHeader>
							<div className="client-field">
								<Label htmlFor="new-client-name">Name</Label>
								<Input id="new-client-name" className="client-input" autoFocus maxLength={100} value={name} placeholder="Research assistant" onChange={(e) => setName(e.target.value)} />
							</div>
							<DialogFooter>
								<Button type="button" variant="outline" disabled={busy} onClick={() => setCreate(null)}>Cancel</Button>
								<Button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating" : "Create key"}</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>

			<Dialog open={rename !== null} onOpenChange={(open) => { if (!open && !busy) setRename(null); }}>
				<DialogContent className="settings-dialog">
					<form onSubmit={submitRename} className="client-form">
						<DialogHeader>
							<DialogTitle>Rename {rename?.name}</DialogTitle>
						</DialogHeader>
						<div className="client-field">
							<Label htmlFor="rename-client">Name</Label>
							<Input id="rename-client" className="client-input" autoFocus maxLength={100} value={draft} onChange={(e) => setDraft(e.target.value)} />
						</div>
						<DialogFooter>
							<Button type="button" variant="outline" disabled={busy} onClick={() => setRename(null)}>Cancel</Button>
							<Button type="submit" disabled={busy || !draft.trim()}>{busy ? "Saving" : "Save"}</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}>
				<AlertDialogContent className="settings-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>{confirm?.kind === "retire" ? "Retire the old shared token?" : `Revoke ${confirm?.client.name ?? ""}?`}</AlertDialogTitle>
						<AlertDialogDescription>
							{confirm?.kind === "retire"
								? "Every extension and script using it stops working. Reconnect extensions and replace script keys first. Your own sign-in keeps working"
								: "It loses access right away. Your saves stay"}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>{confirm?.kind === "retire" ? "Keep it" : "Keep access"}</AlertDialogCancel>
						<Button variant="destructive" disabled={busy} onClick={runConfirm}>
							{busy ? "Removing" : confirm?.kind === "retire" ? "Retire token" : "Revoke access"}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}
