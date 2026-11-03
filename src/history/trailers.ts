/**
 * Commit trailers for sigrun-owned git history (tabs+skills plan, Task 7).
 *
 * The feed reads action/skill from trailers, never by parsing the summary —
 * the exact key set is the contract: Sigrun-Actor, Sigrun-Action,
 * Sigrun-Skill, Sigrun-Review, Sigrun-Conversation, Sigrun-Reason,
 * Sigrun-Undoes.
 *
 * Author identity rule (plan Global Constraints): author name = actor
 * (`<user>` | `curator` | `agent` | `outside sigrun`), author email
 * `<actor-slug>@sigrun.invalid` (`outside-sigrun@…`); the committer is always
 * `sigrun <sigrun@sigrun.invalid>` (set by git.ts at commit time).
 */

import type { CommitMeta, HistoryActor, HistoryCommit } from "./git.js";

export function actorName(actor: HistoryActor): string {
	switch (actor.kind) {
		case "user":
			return actor.user;
		case "curator":
			return "curator";
		case "agent":
			return "agent";
		case "outside":
			return "outside sigrun";
	}
}

export function actorEmail(actor: HistoryActor): string {
	let raw: string;
	if (actor.kind === "user") raw = actor.user;
	else if (actor.kind === "outside") raw = "outside-sigrun";
	else raw = actor.kind;
	// The sigrun slug rule (src/curation/names.ts): lowercase, map every
	// run of non-slug characters (spaces included) to one dash, trim edge
	// dashes. A name that slugs to nothing falls back to "user".
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${slug === "" ? "user" : slug}@sigrun.invalid`;
}

export function decodeActor(value: string): HistoryActor {
	if (value === "curator") return { kind: "curator" };
	if (value === "agent") return { kind: "agent" };
	if (value === "outside sigrun") return { kind: "outside" };
	return { kind: "user", user: value };
}

const TRAILER_KEY_LINE = /^Sigrun-(Actor|Action|Skill|Review|Conversation|Reason|Undoes):/;

/**
 * Sanitize a string before it enters the commit message. Blank-line
 * sequences collapse to a space: git's trailer block starts at the last
 * blank-line-separated paragraph, so an embedded "\n\nSigrun-Actor: …"
 * would otherwise decode as trusted metadata. Lines shaped like a trailer
 * key are flattened into the text.
 */
export function sanitizeField(value: string): string {
	return value
		.split("\n")
		.map((line) => {
			if (!TRAILER_KEY_LINE.test(line.trimStart())) return line;
			return line.replace(":", " -");
		})
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Every CommitMeta string that flows into the commit message. */
export function sanitizeMeta(meta: CommitMeta): CommitMeta {
	const clean = (value: string | undefined): string | undefined =>
		value === undefined ? undefined : value.replace(/[\r\n]+/g, " ").trim();
	const summary = sanitizeField(meta.summary);
	return {
		actor: meta.actor,
		summary: summary === "" ? "(no summary)" : summary,
		action: clean(meta.action),
		skill: clean(meta.skill),
		reviewId: clean(meta.reviewId),
		conversationId: meta.conversationId,
		reason: clean(meta.reason),
		undoes: clean(meta.undoes),
	};
}

export function encodeTrailers(meta: CommitMeta): string {
	const lines = [`Sigrun-Actor: ${actorName(meta.actor)}`];
	if (meta.action !== undefined) lines.push(`Sigrun-Action: ${meta.action}`);
	if (meta.skill !== undefined) lines.push(`Sigrun-Skill: ${meta.skill}`);
	if (meta.reviewId !== undefined) lines.push(`Sigrun-Review: ${meta.reviewId}`);
	if (meta.conversationId !== undefined) {
		lines.push(`Sigrun-Conversation: ${meta.conversationId}`);
	}
	if (meta.reason !== undefined) lines.push(`Sigrun-Reason: ${meta.reason}`);
	if (meta.undoes !== undefined) lines.push(`Sigrun-Undoes: ${meta.undoes}`);
	return lines.join("\n");
}

function trailer(message: string, key: string): string | undefined {
	const value = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(message)?.[1]?.trim();
	return value === undefined || value === "" ? undefined : value;
}

/**
 * Decode one commit's metadata from `git show --format=fuller` output (the
 * shape the tests produce with a plain `git show`; GitHistory.log parses its
 * own record format instead). `paths` is always empty here — fuller output
 * carries no diff.
 */
export function decodeCommit(raw: string): HistoryCommit {
	const sha = /^commit ([0-9a-f]{40})/m.exec(raw)?.[1];
	if (sha === undefined) throw new Error("decodeCommit: no commit header found");
	const authorName = /^Author:\s+(.*?)\s+<[^>]+>/m.exec(raw)?.[1] ?? "";
	const authorDate = /^AuthorDate:\s+(.+)$/m.exec(raw)?.[1]?.trim();
	const messageStart = raw.indexOf("\n\n");
	const message =
		messageStart === -1
			? ""
			: raw
					.slice(messageStart + 2)
					.split("\n")
					.map((line) => (line.startsWith("    ") ? line.slice(4) : line))
					.join("\n")
					.replace(/\n+$/, "");
	const summary = message.split("\n").find((line) => line.trim() !== "") ?? "";
	const conversationRaw = trailer(message, "Sigrun-Conversation");
	const conversationId =
		conversationRaw === undefined ? undefined : Number(conversationRaw);
	return {
		sha,
		at: authorDate === undefined ? "" : new Date(authorDate).toISOString(),
		summary,
		actor: decodeActor(trailer(message, "Sigrun-Actor") ?? authorName),
		action: trailer(message, "Sigrun-Action"),
		skill: trailer(message, "Sigrun-Skill"),
		reviewId: trailer(message, "Sigrun-Review"),
		conversationId,
		reason: trailer(message, "Sigrun-Reason"),
		undoes: trailer(message, "Sigrun-Undoes"),
		paths: [],
	};
}
