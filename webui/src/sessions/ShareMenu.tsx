/**
 * ShareMenu (core hardening W1 Task 8, spec §5.9): the owner's sharing
 * editor, opened from the sidebar row's ⋯ menu ("Share…" — owner-only;
 * the server independently enforces owner-or-superuser on `sharing`
 * patches, so a recipient can never re-share).
 *
 * Three scopes (the shared leaf's `Sharing`): private (just you),
 * household (everyone signed in), people (a named list). A level —
 * "Can view" (read) / "Can edit" (write) — rides household and people;
 * household DEFAULTS to read. Every choice applies IMMEDIATELY as its
 * own `PATCH …/meta {sharing}` (a click lands its own patch — no apply
 * button except People's, whose input must commit as one list). Write
 * levels carry the warning: a write share lets others ask the agent to
 * act as the owner.
 */

import { useState } from "react";
import type { ConversationSummary, Sharing, SigrunClient } from "../api";
import { messageOf } from "../auth/Onboarding";

/** Parse the people input: commas or whitespace separate usernames. */
function parseUsers(raw: string): string[] {
	return raw
		.split(/[\s,]+/)
		.map((user) => user.trim())
		.filter((user) => user !== "");
}

export function ShareMenu(props: {
	readonly client: SigrunClient;
	/** The row being shared (its current `sharing` seeds the state). */
	readonly conversation: ConversationSummary;
	readonly onClose: () => void;
	/** A patch landed; App reloads the lifted list. */
	readonly onSaved: () => void | Promise<void>;
}) {
	const { client, conversation, onClose, onSaved } = props;
	const current = conversation.sharing;
	const [scope, setScope] = useState<Sharing["scope"]>(
		current?.scope ?? "private",
	);
	const [level, setLevel] = useState<"read" | "write">(
		current?.scope === "household" || current?.scope === "people"
			? current.level
			: "read",
	);
	const [users, setUsers] = useState(
		current?.scope === "people" ? current.users.join(", ") : "",
	);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function apply(next: Sharing): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			await client.patchConversationMeta(conversation.id, { sharing: next });
			await onSaved();
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setBusy(false);
		}
	}

	/** A scope click: private and household apply at once (household at
	 *  the SELECTED level — read by default); people only selects (its
	 *  input commits through the Share button). */
	function pickScope(next: Sharing["scope"]): void {
		if (busy) return;
		setScope(next);
		if (next === "private") {
			void apply({ scope: "private" });
		} else if (next === "household") {
			void apply({ scope: "household", level });
		}
	}

	/** The level control: read/write for the household scope applies at
	 *  once; under people it stages (the Share button commits the list). */
	function pickLevel(next: "read" | "write"): void {
		if (busy) return;
		setLevel(next);
		if (scope === "household") {
			void apply({ scope: "household", level: next });
		}
	}

	function shareWithPeople(): void {
		if (busy) return;
		const list = parseUsers(users);
		if (list.length === 0) {
			setError("enter at least one username to share with");
			return;
		}
		void apply({
			scope: "people",
			users: list,
			...(current?.scope === "people" && current.groups !== undefined
				? { groups: [...current.groups] }
				: {}),
			level,
		});
	}

	return (
		<div className="share-menu" role="dialog" aria-label="share conversation">
			<div className="share-head">
				<h2>Share</h2>
				<button
					type="button"
					className="share-close"
					aria-label="close share dialog"
					onClick={onClose}
				>
					Close
				</button>
			</div>
			<div className="share-scopes">
				<button
					type="button"
					className="share-scope"
					data-share-scope="private"
					data-selected={scope === "private" || undefined}
					aria-pressed={scope === "private"}
					disabled={busy}
					onClick={() => pickScope("private")}
				>
					Private
					<span className="share-scope-hint">only you</span>
				</button>
				<button
					type="button"
					className="share-scope"
					data-share-scope="household"
					data-selected={scope === "household" || undefined}
					aria-pressed={scope === "household"}
					disabled={busy}
					onClick={() => pickScope("household")}
				>
					Household
					<span className="share-scope-hint">everyone signed in</span>
				</button>
				<button
					type="button"
					className="share-scope"
					data-share-scope="people"
					data-selected={scope === "people" || undefined}
					aria-pressed={scope === "people"}
					disabled={busy}
					onClick={() => pickScope("people")}
				>
					People
					<span className="share-scope-hint">named users</span>
				</button>
			</div>
			{scope !== "private" && (
				<div className="share-level" role="group" aria-label="access level">
					<button
						type="button"
						className="share-level-btn"
						data-share-level="read"
						data-selected={level === "read" || undefined}
						aria-pressed={level === "read"}
						disabled={busy}
						onClick={() => pickLevel("read")}
					>
						Can view
					</button>
					<button
						type="button"
						className="share-level-btn"
						data-share-level="write"
						data-selected={level === "write" || undefined}
						aria-pressed={level === "write"}
						disabled={busy}
						onClick={() => pickLevel("write")}
					>
						Can edit
					</button>
				</div>
			)}
			{scope === "people" && (
				<label className="share-field">
					Usernames
					<input
						data-share-field="users"
						placeholder="carol, dave"
						value={users}
						onChange={(event) => setUsers(event.target.value)}
					/>
					<button
						type="button"
						className="auth-submit"
						disabled={busy}
						onClick={shareWithPeople}
					>
						Share with people
					</button>
				</label>
			)}
			{scope !== "private" && level === "write" && (
				<p className="share-warning" role="alert">
					Others can ask the agent to act as you.
				</p>
			)}
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
