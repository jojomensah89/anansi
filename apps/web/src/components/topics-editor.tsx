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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@anansi/ui/components/dialog";
import { Input } from "@anansi/ui/components/input";
import { Label } from "@anansi/ui/components/label";
import { Switch } from "@anansi/ui/components/switch";
import { Textarea } from "@anansi/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@anansi/ui/components/tooltip";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { type AiTopic, type AiTopicsResponse, api } from "../lib/api.ts";
import { frameKeys } from "../lib/frame-status.ts";
import { refreshTagKinds, topicColor } from "../lib/tag-colors.ts";
import { SettingsRow, SettingsSection } from "./settings-panel.tsx";
import { SettingsSkeleton } from "./skeleton.tsx";

const ICON = { "aria-hidden": true, strokeWidth: 1.5 } as const;
export const TOPIC_NAME_MAX = 32;
export const TOPIC_DESCRIPTION_MAX = 160;
export const topicsKey = ["ai-topics"] as const;

const fail = (title: string, error: unknown) =>
	toast.error(title, { description: error instanceof Error && error.message ? error.message : undefined });

/** "1 save", "1,204 saves". */
export function saveCount(count: number): string {
	return `${count.toLocaleString()} ${count === 1 ? "save" : "saves"}`;
}

/** A built-in whose description is no longer the shipped one. */
export function topicEdited(topic: Pick<AiTopic, "builtIn" | "description" | "defaultDescription">): boolean {
	return topic.builtIn && topic.defaultDescription !== undefined && topic.description !== topic.defaultDescription;
}

/**
 * Settings › AI › Topics: the list automatic tags file saves under.
 *
 * Every change saves at once. Saves already tagged keep their topics until
 * the owner asks for everything to be tagged again, so after any change a
 * quiet line offers exactly that.
 */
export function TopicsEditor({ onRetagged }: { onRetagged?: () => void }) {
	const queryClient = useQueryClient();
	const list = useQuery({ queryKey: topicsKey, queryFn: ({ signal }) => api.aiTopics(signal), retry: 1 });
	const [changed, setChanged] = useState(false);
	const [retagging, setRetagging] = useState(false);
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<AiTopic | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const apply = (next: AiTopicsResponse) => {
		queryClient.setQueryData(topicsKey, next);
		setChanged(true);
		// Chips across the library learn about a new or removed topic.
		refreshTagKinds(true);
	};

	/** One write at a time per topic; the server's words come back as a toast. */
	const run = async (id: string, title: string, work: () => Promise<AiTopicsResponse>) => {
		setBusy(id);
		try {
			apply(await work());
			return true;
		} catch (error) {
			fail(title, error);
			return false;
		} finally {
			setBusy(null);
		}
	};

	const toggle = (topic: AiTopic, enabled: boolean) => {
		// Flip at once; put it back if the server says no.
		queryClient.setQueryData<AiTopicsResponse>(topicsKey, (previous) =>
			previous && { ...previous, topics: previous.topics.map((entry) => (entry.id === topic.id ? { ...entry, enabled } : entry)) });
		void run(topic.id, `Couldn’t turn ${enabled ? "on" : "off"} ${topic.label}`, () => api.updateAiTopic(topic.id, { enabled })).then((ok) => {
			if (!ok) void list.refetch();
		});
	};

	const retag = async () => {
		setRetagging(true);
		try {
			const { queued } = await api.retagAi();
			setChanged(false);
			toast.success(queued > 0 ? `${saveCount(queued)} queued for tagging` : "Nothing to tag again");
			void queryClient.invalidateQueries({ queryKey: frameKeys.ai });
			onRetagged?.();
		} catch (error) {
			fail("Couldn’t start tagging again", error);
		} finally {
			setRetagging(false);
		}
	};

	const data = list.data;
	const on = data?.topics.filter((topic) => topic.enabled).length ?? 0;

	return (
		<SettingsSection
			id="topics"
			title="Topics"
			lead="What automatic tags can file a save under"
			action={
				data && (
					<>
						<span className="settings-count" aria-label={`${on} of ${data.limit} topics on`}>{on} of {data.limit}</span>
						<Button variant="outline" onClick={() => setAdding(true)} disabled={on >= data.limit}>
							<Plus {...ICON} />
							Add topic
						</Button>
					</>
				)
			}
		>
			{list.isPending && <SettingsSkeleton label="Loading topics" />}
			{list.isError && (
				<SettingsRow
					title="Couldn’t load topics"
					description={list.error instanceof Error ? list.error.message : undefined}
					control={<Button variant="outline" onClick={() => void list.refetch()}><RotateCcw {...ICON} />Try again</Button>}
				/>
			)}
			{changed && (
				<div className="topics-banner" role="status">
					<span className="topics-banner-copy">
						<span className="topics-banner-title">Topics changed</span>
						<span className="topics-banner-note">Saves keep their topics until tagged again</span>
					</span>
					<Button variant="outline" disabled={retagging} onClick={() => void retag()}>
						{retagging ? "Queuing" : "Re-tag everything"}
					</Button>
				</div>
			)}
			{data && (
				<ul className="topics-list" aria-label="Topics">
					{data.topics.map((topic) => (
						<TopicRow
							key={topic.id}
							topic={topic}
							busy={busy === topic.id}
							editing={editing === topic.id}
							onEdit={() => setEditing(topic.id)}
							onCancel={() => setEditing(null)}
							onSave={async (description) => {
								const ok = await run(topic.id, `Couldn’t save ${topic.label}`, () => api.updateAiTopic(topic.id, { description }));
								if (ok) setEditing(null);
							}}
							onReset={() => void run(topic.id, `Couldn’t reset ${topic.label}`, () => api.updateAiTopic(topic.id, { description: null }))}
							onToggle={(enabled) => toggle(topic, enabled)}
							onDelete={() => setDeleting(topic)}
						/>
					))}
				</ul>
			)}

			<AddTopicDialog
				open={adding}
				onOpenChange={setAdding}
				onCreate={async (label, description) => {
					const ok = await run("new", "Couldn’t add the topic", () => api.createAiTopic(label, description));
					if (ok) setAdding(false);
				}}
				busy={busy === "new"}
			/>

			<AlertDialog open={deleting !== null} onOpenChange={(open) => { if (!open && busy === null) setDeleting(null); }}>
				<AlertDialogContent className="settings-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>Delete {deleting?.label}?</AlertDialogTitle>
						<AlertDialogDescription>
							{deleting && deleting.count > 0
								? `Its automatic tag comes off ${saveCount(deleting.count)}. Tags you added by hand stay`
								: "It leaves the list. Tags you added by hand stay"}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy !== null}>Keep it</AlertDialogCancel>
						<Button
							variant="destructive"
							disabled={busy !== null}
							onClick={() => {
								const topic = deleting;
								if (!topic) return;
								void run(topic.id, `Couldn’t delete ${topic.label}`, () => api.deleteAiTopic(topic.id)).then((ok) => ok && setDeleting(null));
							}}
						>
							{busy !== null ? "Deleting" : "Delete topic"}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SettingsSection>
	);
}

function TopicRow({
	topic,
	busy,
	editing,
	onEdit,
	onCancel,
	onSave,
	onReset,
	onToggle,
	onDelete,
}: {
	topic: AiTopic;
	busy: boolean;
	editing: boolean;
	onEdit: () => void;
	onCancel: () => void;
	onSave: (description: string) => Promise<void>;
	onReset: () => void;
	onToggle: (enabled: boolean) => void;
	onDelete: () => void;
}) {
	const edited = topicEdited(topic);
	return (
		<li className="topic-row" data-off={!topic.enabled || undefined} data-editing={editing || undefined}>
			<span className="topic-dot" aria-hidden="true" style={{ background: topicColor(topic.label) }} />
			<div className="topic-copy">
				<div className="topic-line">
					<span className="topic-name">{topic.label}</span>
					<span className="topic-count">{saveCount(topic.count)}</span>
				</div>
				{editing ? (
					// A custom topic is deleted from here, so every row keeps one edit button and one switch.
					<DescriptionForm topic={topic} busy={busy} onSave={onSave} onCancel={onCancel} onDelete={topic.builtIn ? undefined : onDelete} />
				) : (
					<p className="topic-description">{topic.description || <span className="topic-empty">No description</span>}</p>
				)}
			</div>
			{!editing && (
				<div className="topic-actions">
					{edited && (
						<Button variant="ghost" className="topic-reset" disabled={busy} onClick={onReset}>
							Reset
						</Button>
					)}
					<IconAction label={`Edit ${topic.label}`} onClick={onEdit} disabled={busy}>
						<Pencil {...ICON} />
					</IconAction>
					<Switch aria-label={`Use ${topic.label}`} checked={topic.enabled} disabled={busy} onCheckedChange={onToggle} />
				</div>
			)}
		</li>
	);
}

function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger render={<Button variant="ghost" size="icon" className="topic-icon" aria-label={label} disabled={disabled} onClick={onClick} />}>
				{children}
			</TooltipTrigger>
			<TooltipContent side="top" sideOffset={6} className="frame-tooltip">{label}</TooltipContent>
		</Tooltip>
	);
}

function DescriptionForm({
	topic,
	busy,
	onSave,
	onCancel,
	onDelete,
}: {
	topic: AiTopic;
	busy: boolean;
	onSave: (description: string) => Promise<void>;
	onCancel: () => void;
	onDelete?: () => void;
}) {
	const [draft, setDraft] = useState(topic.description);
	const trimmed = draft.trim();
	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		if (trimmed === topic.description) return onCancel();
		void onSave(trimmed);
	};
	const keys = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onCancel();
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};
	return (
		<form className="topic-form" onSubmit={submit} onKeyDown={keys}>
			<Textarea
				aria-label={`Description of ${topic.label}`}
				className="topic-textarea"
				autoFocus
				rows={2}
				maxLength={TOPIC_DESCRIPTION_MAX}
				value={draft}
				disabled={busy}
				onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
				onChange={(event) => setDraft(event.target.value)}
			/>
			<div className="topic-form-foot">
				<span className="topic-form-count">{draft.length} / {TOPIC_DESCRIPTION_MAX}</span>
				{onDelete && (
					<Button type="button" variant="ghost" className="topic-delete" disabled={busy} onClick={onDelete}>
						<Trash2 {...ICON} />
						Delete
					</Button>
				)}
				<Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
				<Button type="submit" disabled={busy || (!trimmed && !topic.builtIn)}>{busy ? "Saving" : "Save"}</Button>
			</div>
		</form>
	);
}

function AddTopicDialog({
	open,
	onOpenChange,
	onCreate,
	busy,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreate: (label: string, description: string) => Promise<void>;
	busy: boolean;
}) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		void onCreate(name.trim(), description.trim());
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (busy) return;
				if (next) {
					setName("");
					setDescription("");
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="settings-dialog">
				<form onSubmit={submit} className="client-form">
					<DialogHeader>
						<DialogTitle>Add a topic</DialogTitle>
						<DialogDescription>New saves can be filed under it straight away</DialogDescription>
					</DialogHeader>
					<div className="client-field">
						<Label htmlFor="new-topic-name">Name</Label>
						<Input id="new-topic-name" className="client-input" autoFocus maxLength={TOPIC_NAME_MAX} value={name} placeholder="Rust" onChange={(event) => setName(event.target.value)} />
					</div>
					<div className="client-field">
						<div className="topic-field-head">
							<Label htmlFor="new-topic-description">Description</Label>
							<span className="topic-form-count">{description.length} / {TOPIC_DESCRIPTION_MAX}</span>
						</div>
						<Textarea
							id="new-topic-description"
							className="topic-textarea"
							rows={3}
							maxLength={TOPIC_DESCRIPTION_MAX}
							value={description}
							placeholder="The Rust language, its crates and tooling"
							onChange={(event) => setDescription(event.target.value)}
						/>
					</div>
					<DialogFooter>
						<Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
						<Button type="submit" disabled={busy || !name.trim()}>{busy ? "Adding" : "Add topic"}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
