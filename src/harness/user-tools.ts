/**
 * Multi-user M2 Task 3: per-user extension entries and owner-driven
 * selection.
 *
 * A per-user entry is an ordinary pi-durable Extension named
 * `<slug>@<user>`. It is deliberately NOT part of the host default
 * selection: create/fork/owner-transfer commits add the caller's entries.
 * A late install resolves by name on the next agent read, so no stored
 * selection needs to be edited at publish time.
 *
 * SELECTION IS NOT ENFORCEMENT. Every published tool is wrapped, and the
 * wrapper reads the conversation's COMMITTED SessionMeta owner on every
 * execution. A hand-written array selection can select another user's
 * extension (including its hooks); it still cannot execute its tools.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type ConversationId,
	type Extension,
	type Cursor,
	type Harness,
	type Registry,
	type Storage,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { SessionMetaDoc } from "../server/session-meta.js";

/** The registry name for one extension's publication to one user. */
export function userEntryName(slug: string, user: string): string {
	return `${slug}@${user}`;
}

/** Per-user names are core-computed and never operator-authored. */
export function isUserEntryName(name: string): boolean {
	return name.includes("@");
}

/** Parse a per-user name into its extension slug and owning user. */
export function parseUserEntryName(
	name: string,
): { readonly slug: string; readonly user: string } | undefined {
	const at = name.indexOf("@");
	if (at <= 0 || at === name.length - 1) return undefined;
	return { slug: name.slice(0, at), user: name.slice(at + 1) };
}

/**
 * Publish per-user tools over pi-durable's application-owned Registry.
 * `install` replaces the same name in place; an empty tool list removes
 * the entry altogether. Core owns the per-user slug set (the loader's
 * declarations), not the publishing extension.
 */
export class UserToolRegistry {
	constructor(
		private readonly registry: Registry,
		private readonly perUserSlugs: () => readonly string[],
	) {}

	set(slug: string, user: string, tools: readonly ToolRegistration[]): void {
		if (!this.perUserSlugs().includes(slug)) {
			throw new Error(`perUserTools not declared: ${slug}`);
		}
		const name = userEntryName(slug, user);
		if (tools.length === 0) {
			const installed = this.registry.snapshot().extension(name);
			if (installed !== undefined) this.registry.uninstall(installed);
			return;
		}
		const extension: Extension = {
			name,
			tools: tools.map((tool) => this.wrap(tool, user)),
		};
		this.registry.install(extension);
	}

	removeUser(user: string): void {
		for (const installed of this.registry.snapshot().installed()) {
			if (parseUserEntryName(installed.name)?.user === user) {
				this.registry.uninstall(installed);
			}
		}
	}

	removeSlug(slug: string): void {
		for (const installed of this.registry.snapshot().installed()) {
			if (parseUserEntryName(installed.name)?.slug === slug) {
				this.registry.uninstall(installed);
			}
		}
	}

	private wrap(tool: ToolRegistration, user: string): ToolRegistration {
		return {
			...tool,
			execute: async (args, api, context) => {
				const meta = await api.snapshot(
					SessionMetaDoc,
					api.conversationId,
					context,
				);
				if (meta?.owner !== user) {
					return {
						output: [
							{ type: "text", text: "This tool belongs to another user." },
						],
						isError: true,
					};
				}
				return tool.execute(args, api, context);
			},
		};
	}
}

/** Remove every per-user entry belonging to `from` from a name list. */
function withoutOldOwner(
	names: readonly string[],
	from: string | undefined,
): string[] {
	if (from === undefined) return [...names];
	const suffix = `@${from}`;
	return names.filter((name) => !name.endsWith(suffix));
}

/**
 * Rewrite the stored extension selection alongside an owner write.
 *
 * Object/absent selections edit the host default: remove the old owner's
 * entries and add the new owner's declared entries. ARRAY selections are
 * exact: they lose every old-owner name and gain NOTHING. `to: undefined`
 * removes old entries without adding any (ownerless create/stamp paths).
 */
export async function rewriteSelection(
	tx: Tx,
	conversationId: ConversationId,
	from: string | undefined,
	to: string | undefined,
	perUserSlugs: readonly string[],
): Promise<void> {
	// Re-stamping/forking for the SAME owner is a true no-op: arrays are
	// exact and object edits must not drop then duplicate-check away the
	// owner's existing entries.
	if (from !== undefined && from === to) return;
	const agent = await tx.doc(AgentDoc, conversationId);
	const stored = agent.extensions;
	const additions =
		to === undefined ? [] : perUserSlugs.map((slug) => userEntryName(slug, to));
	if (Array.isArray(stored)) {
		const next = withoutOldOwner(stored, from);
		if (next.length !== stored.length) agent.extensions = next;
		return;
	}
	const add = [
		...withoutOldOwner(stored?.add ?? [], from),
		...additions.filter((name) => !(stored?.add ?? []).includes(name)),
	];
	const nextRemove = withoutOldOwner(stored?.remove ?? [], from).filter(
		(name) => !additions.includes(name),
	);
	if (stored === undefined && additions.length === 0) return;
	agent.extensions = {
		add,
		...(nextRemove.length === 0 ? {} : { remove: nextRemove }),
	};
}

/** Page size for the boot's durable conversation scan. */
const USER_SWEEP_PAGE_SIZE = 1_000;

/**
 * Boot reconciliation over durable conversations. Only conversations whose
 * SessionMeta owner exists and whose Agent selection is object/absent are
 * considered. Exact arrays remain exact. The returned count is the number
 * of conversation commits actually needed; a second boot must report zero.
 */
export async function sweepUserSelections(
	harness: Harness,
	storage: Storage,
	perUserSlugs: readonly string[],
): Promise<{ readonly scanned: number; readonly changed: number }> {
	if (perUserSlugs.length === 0) return { scanned: 0, changed: 0 };
	let scanned = 0;
	let changed = 0;
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanConversations(
			{ order: "ascending" },
			USER_SWEEP_PAGE_SIZE,
			cursor,
			BACKGROUND_CONTEXT,
		);
		for (const record of page.items) {
			scanned += 1;
			const meta = await harness.snapshot(
				SessionMetaDoc,
				record.id,
				BACKGROUND_CONTEXT,
			);
			if (meta?.owner === undefined) continue;
			const agent = await harness.snapshot(
				AgentDoc,
				record.id,
				BACKGROUND_CONTEXT,
			);
			if (Array.isArray(agent?.extensions)) continue;
			const selected = agent?.extensions?.add ?? [];
			const owner = meta.owner;
			const wanted = perUserSlugs.map((slug) => userEntryName(slug, owner));
			if (wanted.every((name) => selected.includes(name))) continue;
			const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);
			if (conversation === undefined) continue;
			await conversation.commit(async (tx) => {
				const draft = await tx.doc(SessionMetaDoc, record.id);
				if (draft.owner === undefined) return;
				await addOwnerSelection(tx, record.id, draft.owner, perUserSlugs);
			}, BACKGROUND_CONTEXT);
			changed += 1;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return { scanned, changed };
}

/** Add the current owner's declared entries to a default-edited selection. */
export async function addOwnerSelection(
	tx: Tx,
	conversationId: ConversationId,
	owner: string | undefined,
	perUserSlugs: readonly string[],
): Promise<void> {
	if (owner === undefined) return;
	await rewriteSelection(tx, conversationId, undefined, owner, perUserSlugs);
}
