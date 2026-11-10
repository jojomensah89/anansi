import { Button } from "@anansi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@anansi/ui/components/dialog";
import { useRouter } from "@tanstack/react-router";
import { Check, Copy, KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { requestExtensionConnect } from "../lib/extension-bridge.ts";
import { dismissPairing, pairingState, type PairingClient } from "../lib/pairing-state.ts";

const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;
const CODE_SECONDS = 300;

async function clients(path = "", method = "GET", body?: unknown) {
	const response = await fetch(`/api/clients${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) throw new Error("Couldn't reach the server. Try again");
	return response.json() as Promise<{ id: string; key: string; clients: PairingClient[] }>;
}

export function countdown(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="outline"
			aria-label={label}
			onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => setCopied(false))}
		>
			{copied ? <Check {...ICON} /> : <Copy {...ICON} />}
			{copied ? "Copied" : "Copy"}
		</Button>
	);
}

/**
 * One live pairing code at a time. Opening issues it and offers it to the
 * extension directly; the dialog closes itself once the extension redeems it.
 * Closing early revokes the code.
 */
export function ConnectExtension() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [code, setCode] = useState<{ key: string; id: string } | null>(null);
	const [seconds, setSeconds] = useState(CODE_SECONDS);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const expiresAt = useRef(0);

	const issue = async () => {
		setBusy(true);
		setError("");
		try {
			const issued = await clients("", "POST", { kind: "pairing", name: "Browser extension" });
			expiresAt.current = Date.now() + CODE_SECONDS * 1000;
			setSeconds(CODE_SECONDS);
			setCode({ key: issued.key, id: issued.id });
			void requestExtensionConnect(issued.key);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't create a code");
		} finally {
			setBusy(false);
		}
	};

	const close = (redeemed = false) => {
		setOpen(false);
		const current = code;
		setCode(null);
		setError("");
		if (current && !redeemed) void dismissPairing({ pairing: true, id: current.id }, (id) => clients(`/${id}`, "DELETE")).catch(() => undefined);
	};

	useEffect(() => {
		if (!code || seconds === 0) return;
		const timer = setInterval(() => setSeconds(Math.max(0, Math.ceil((expiresAt.current - Date.now()) / 1000))), 1000);
		return () => clearInterval(timer);
	}, [code, seconds === 0]);

	useEffect(() => {
		if (!code || seconds === 0) return;
		let cancelled = false;
		const check = async () => {
			try {
				const result = await clients();
				if (!cancelled && pairingState(result.clients, code.id, seconds) === "redeemed") {
					close(true);
					toast.success("Extension connected");
					window.dispatchEvent(new Event("anansi-connection-updated"));
					void router.invalidate();
				}
			} catch { /* Keep polling while the code is usable. */ }
		};
		void check();
		const timer = setInterval(() => void check(), 2000);
		return () => { cancelled = true; clearInterval(timer); };
	}, [code, seconds === 0, router]);

	const expired = code !== null && seconds === 0;
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) {
					setOpen(true);
					void issue();
				} else close();
			}}
		>
			<DialogTrigger render={<Button variant="outline" className="toolbar-button connect-extension-trigger" aria-label="Connect extension" />}>
				<KeyRound {...ICON} />
				<span className="toolbar-button-label">Connect extension</span>
			</DialogTrigger>
			<DialogContent className="settings-dialog connect-dialog">
				<DialogHeader>
					<DialogTitle>Connect your extension</DialogTitle>
					<DialogDescription>
						{error ? <span className="settings-inline-danger" role="alert">{error}</span>
						: !code ? (busy ? "Creating a code" : "")
						: expired ? "This code has expired"
						: <span className="tabular">Code expires in {countdown(seconds)}</span>}
					</DialogDescription>
				</DialogHeader>
				{(expired || (error && !code)) && (
					<div>
						<Button disabled={busy} onClick={() => void issue()}>Get a new code</Button>
					</div>
				)}
				{code && !expired && (
					<>
						<div className="settings-joined connect-code">
							<code className="connect-value connect-key">{code.key}</code>
							<CopyButton value={code.key} label="Copy code" />
						</div>
						<ol className="connect-steps">
							<li>Open the Anansi extension</li>
							<li>
								Paste this address and the code
								<div className="settings-joined connect-code">
									<code className="connect-value">{location.origin}</code>
									<CopyButton value={location.origin} label="Copy address" />
								</div>
							</li>
							<li>Approve access to this site</li>
						</ol>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
