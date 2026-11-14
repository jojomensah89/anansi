import { Button } from "@anansi/ui/components/button";
import { AlertTriangle, Check, X } from "lucide-react";
import { consentTools } from "../lib/consent-tools.ts";
import { AnansiMark, AuthCard } from "./connection-gate.tsx";

const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;

export type ConsentRequest =
	| { state: "loading" }
	| { state: "invalid"; message: string }
	| { state: "ready"; name: string; destination: string; write: boolean };

/** Anansi and the app, joined by the link being asked for. */
function Pair({ name }: { name: string }) {
	const initial = name.trim().charAt(0).toUpperCase() || "?";
	return (
		<div className="auth-pair">
			<AnansiMark />
			<span className="auth-pair-link" aria-hidden="true" />
			<span className="auth-monogram" aria-hidden="true">{initial}</span>
		</div>
	);
}

function ToolList({ title, tools, off }: { title: string; tools: string[]; off?: boolean }) {
	const id = off ? "consent-denied" : "consent-allowed";
	return (
		<div className="consent-group">
			<h2 id={id}>{title}</h2>
			<ul className="consent-tools" aria-labelledby={id} data-off={off || undefined}>
				{tools.map((tool) => (
					<li key={tool}>
						{off ? <X {...ICON} /> : <Check {...ICON} />}
						<code>{tool}</code>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Consent for an OAuth app: who is asking, the exact tools it gets and does
 * not get, and where approval sends you. The name is the app's own claim.
 */
export function ConsentView({
	request,
	pending = null,
	error,
	onDecide,
}: {
	request: ConsentRequest;
	/** The decision being sent, if any. */
	pending?: "allow" | "deny" | null;
	error?: string;
	onDecide: (allow: boolean) => void;
}) {
	if (request.state === "loading") {
		return (
			<AuthCard size="sm" title="Checking this request">
				<p className="auth-lead" role="status">Loading</p>
			</AuthCard>
		);
	}
	if (request.state === "invalid") {
		return (
			<AuthCard size="sm" title="Can’t connect this app">
				<p className="auth-lead" role="alert">{request.message}</p>
			</AuthCard>
		);
	}

	const { allowed, denied } = consentTools(request.write);
	return (
		<AuthCard
			size="lg"
			logo={<Pair name={request.name} />}
			title={<>Allow <span className="consent-name">{request.name}</span> to {request.write ? "use" : "read"} your library?</>}
		>
			<div className="consent-warn" role="note">
				<AlertTriangle {...ICON} />
				<span>Anansi can’t verify this name. The app chose it. Check where it returns before you allow</span>
			</div>
			<div className="consent-body">
				<ToolList title="It can use" tools={allowed} />
				{denied.length > 0 && <ToolList title="Not allowed" tools={denied} off />}
				<p className="auth-meta">
					{request.write ? "You allowed changes earlier. Nothing can delete" : "Changes stay off until you allow them. Nothing can delete"}
				</p>
			</div>
			<div className="consent-returns">
				<span className="auth-meta">Returns to</span>
				<code>{request.destination}</code>
			</div>
			{error && (
				<p className="auth-error" role="alert">
					<AlertTriangle {...ICON} />
					{error}
				</p>
			)}
			<div className="consent-actions">
				<span className="auth-meta">Revoke any time on the <a href="/mcp">MCP server</a> page</span>
				<Button variant="outline" disabled={pending !== null} onClick={() => onDecide(false)}>{pending === "deny" ? "Denying" : "Deny"}</Button>
				<Button disabled={pending !== null} onClick={() => onDecide(true)}>{pending === "allow" ? "Allowing" : "Allow"}</Button>
			</div>
		</AuthCard>
	);
}
