import { useEffect, useRef, useState, type FormEvent } from "react";
import {
	LICENCE_CHECKOUT_URL,
	type LicenceError,
	type LicenceGate,
	licenceErrorMessage,
} from "../../lib/licence.ts";
import { MESSAGE_PROTOCOL_VERSION } from "../../lib/messages.ts";
import { Icon } from "./icons.tsx";

/**
 * Store build only. App renders these behind __ANANSI_REQUIRE_LICENCE__, so
 * public and private bundles drop this file, the checkout link with it.
 *
 * The key goes to the worker, which is the only place that talks to Polar and
 * the only place the gate is enforced; the popup just shows where it stands.
 */

interface LicenceReply {
	ok?: boolean;
	licence?: LicenceGate;
	licenceError?: LicenceError;
}

const licenceCommand = (message: Record<string, unknown>) =>
	browser.runtime
		.sendMessage({ anansi: "popup-command", messageVersion: MESSAGE_PROTOCOL_VERSION, ...message })
		.catch(() => undefined) as Promise<LicenceReply | undefined>;

export const readLicence = () => licenceCommand({ action: "licence-status" });

const shortDate = (at: number) =>
	new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Shown instead of everything else while the store build has no usable licence. */
export function LicenceScreen({
	gate,
	onGate,
}: {
	gate: LicenceGate;
	onGate: (gate: LicenceGate) => void;
}) {
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState<null | "activate" | "check">(null);
	const [error, setError] = useState<LicenceError | null>(null);

	const activate = async (event: FormEvent) => {
		event.preventDefault();
		if (busy) return;
		if (!key.trim()) {
			setError("empty");
			return;
		}
		setBusy("activate");
		setError(null);
		const reply = await licenceCommand({ action: "licence-activate", licenceKey: key.trim() });
		setBusy(null);
		if (reply?.ok && reply.licence) {
			onGate(reply.licence);
			return;
		}
		setError(reply?.licenceError ?? "offline");
	};

	const checkAgain = async () => {
		setBusy("check");
		setError(null);
		const reply = await licenceCommand({ action: "licence-check" });
		setBusy(null);
		if (reply?.licence) onGate(reply.licence);
		const stillUnverified =
			!reply?.licence || (reply.licence.state === "invalid" && reply.licence.reason === "unverified");
		if (stillUnverified) setError("offline");
	};

	const invalid = gate.state === "invalid" ? gate : null;

	return (
		<div className="anansi-popup">
			<header className="pop-head">
				<img className="logo" src="/icon/48.png" width="20" height="20" alt="" aria-hidden="true" />
				<span className="name">Anansi</span>
			</header>

			<form className="connect" onSubmit={(event) => void activate(event)} noValidate>
				<div>
					<div className="heading">Activate Anansi</div>
					<div className="meta">Paste the key from your purchase email</div>
				</div>

				{invalid?.reason === "revoked" && (
					<div className="notice" role="note">
						<Icon name="alert" />
						<span className="body">
							Key <span className="licence-key">{invalid.displayKey}</span> was revoked or has expired
						</span>
					</div>
				)}

				{invalid?.reason === "unverified" && (
					<div className="notice notice-row">
						<span className="body">Couldn't confirm your licence for 30 days</span>
						<button
							type="button"
							className="btn sm"
							disabled={busy !== null}
							aria-busy={busy === "check"}
							onClick={() => void checkAgain()}
						>
							{busy === "check" ? "Checking…" : "Check again"}
						</button>
					</div>
				)}

				<div className="field">
					<label htmlFor="anansi-licence-key">Licence key</label>
					<input
						id="anansi-licence-key"
						className="input mono"
						type="text"
						value={key}
						onChange={(event) => {
							setKey(event.target.value);
							if (error) setError(null);
						}}
						placeholder="ANANSI-…"
						autoComplete="off"
						autoCapitalize="characters"
						spellCheck={false}
						// biome-ignore lint/a11y/noAutofocus: the popup exists to take this one key.
						autoFocus
						aria-invalid={error !== null && error !== "offline"}
						aria-describedby={error ? "anansi-licence-error" : undefined}
					/>
				</div>

				{error && (
					<div className="notice" role="alert" id="anansi-licence-error">
						<Icon name="alert" />
						<span className="body">{licenceErrorMessage(error)}</span>
					</div>
				)}

				<div className="actions">
					<button type="submit" className="btn primary" disabled={busy !== null} aria-busy={busy === "activate"}>
						{busy === "activate" ? "Activating…" : "Activate"}
					</button>
				</div>
			</form>

			<footer className="pop-foot">
				<span className="meta">One payment, up to 5 browsers</span>
				<a className="btn ghost sm" href={LICENCE_CHECKOUT_URL} target="_blank" rel="noreferrer">
					Buy for $5
					<Icon name="arrowUpRight" />
				</a>
			</footer>
		</div>
	);
}

/** The Options row once a key is active: which key, and how to free this browser's slot. */
export function LicenceRow({
	gate,
	onGate,
}: {
	gate: Extract<LicenceGate, { state: "active" | "grace" }>;
	onGate: (gate: LicenceGate) => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [error, setError] = useState<LicenceError | null>(null);
	const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const noteRef = useRef<HTMLDivElement>(null);

	useEffect(() => () => clearTimeout(confirmTimer.current), []);

	// The row is the last thing in a scrolling popup; a failure must not land below the fold.
	useEffect(() => {
		if (error) noteRef.current?.scrollIntoView({ block: "nearest" });
	}, [error]);

	const remove = async () => {
		if (!confirming) {
			// One deliberate second press, since a removed key has to be pasted again.
			setConfirming(true);
			setError(null);
			confirmTimer.current = setTimeout(() => setConfirming(false), 4000);
			return;
		}
		clearTimeout(confirmTimer.current);
		setRemoving(true);
		const reply = await licenceCommand({ action: "licence-deactivate" });
		setRemoving(false);
		setConfirming(false);
		if (reply?.ok && reply.licence) {
			onGate(reply.licence);
			return;
		}
		setError(reply?.licenceError ?? "offline");
	};

	const note = error
		? licenceErrorMessage(error)
		: gate.state === "grace"
			? `Can't reach Polar · works until ${shortDate(gate.graceEndsAt)}`
			: null;

	return (
		<div className="opt licence-row">
			<div className="text">
				<div className="title" id="opt-licence">
					Licence
				</div>
				<div className="meta licence-key">{gate.displayKey}</div>
			</div>
			<button
				type="button"
				className={confirming ? "btn sm danger" : "btn sm"}
				disabled={removing}
				aria-busy={removing}
				aria-describedby="opt-licence"
				onClick={() => void remove()}
			>
				{removing ? "Removing…" : confirming ? "Confirm remove" : "Remove from this browser"}
			</button>
			{note && (
				<div ref={noteRef} className="meta warn licence-note" role={error ? "alert" : undefined}>
					{note}
				</div>
			)}
		</div>
	);
}
