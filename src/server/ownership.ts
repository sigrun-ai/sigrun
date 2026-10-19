/**
 * Ownership transfer (core hardening W1 Task 4, spec §5.8 user ruling
 * 9): the participant seam `DELETE /v1/users/:user?transferTo=` drives.
 *
 * Core owns ONE participant — the conversation rewrite (`scanConversations`
 * → session-meta snapshot → one commit per `owner === from` hit). Anything
 * else that records owners (W4's jobs, extensions' own records via the
 * `userDeleted` lifecycle event) registers through
 * {@link registerOwnershipParticipant} and runs in registration order.
 *
 * Participants are held per {@link ServerContext} in a module `WeakMap`:
 * the context record stays the immutable boot artifact the routes
 * receive, while the registry is server-instance state.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Cursor } from "@earendil-works/pi-durable";
import type { ServerContext } from "./context.js";
import { SCAN_PAGE_SIZE } from "./helpers.js";
import { SessionMetaDoc } from "./session-meta.js";

/** One registered transfer step: rewrite everything `from` owns to `to`. */
export type OwnershipParticipant = (from: string, to: string) => Promise<void>;

/** The per-server participant lists (registration order = run order). */
const participants = new WeakMap<ServerContext, OwnershipParticipant[]>();

/**
 * Register one transfer participant on `ctx`. Callers register at boot or
 * module-init time (W4's jobs module); the registry never reorders.
 */
export function registerOwnershipParticipant(
	ctx: ServerContext,
	p: OwnershipParticipant,
): void {
	const list = participants.get(ctx) ?? [];
	list.push(p);
	participants.set(ctx, list);
}

/**
 * Run every registered participant for the `from` → `to` transfer, in
 * registration order. The core conversation participant is registered
 * first (`createServer`), so conversations transfer before extensions
 * observe `userDeleted`.
 */
export async function transferOwnership(
	ctx: ServerContext,
	from: string,
	to: string,
): Promise<void> {
	for (const p of participants.get(ctx) ?? []) {
		await p(from, to);
	}
}

/**
 * Register the core conversation-ownership participant: the durable scan
 * is authoritative (conversations other processes created all transfer),
 * and each `owner === from` hit is ONE commit that rewrites the
 * session-meta doc's owner — never a read-modify-write across commits.
 */
export function registerCoreOwnershipParticipant(ctx: ServerContext): void {
	registerOwnershipParticipant(ctx, async (from, to) => {
		const { opened } = ctx;
		let cursor: Cursor | undefined;
		do {
			const page = await opened.storage.scanConversations(
				{ order: "ascending" },
				SCAN_PAGE_SIZE,
				cursor,
				BACKGROUND_CONTEXT,
			);
			for (const record of page.items) {
				const conversation = await opened.harness.conversation(
					record.id,
					BACKGROUND_CONTEXT,
				);
				if (conversation === undefined) continue;
				const meta = await opened.harness.snapshot(
					SessionMetaDoc,
					conversation.id,
					BACKGROUND_CONTEXT,
				);
				if (meta?.owner !== from) continue;
				await conversation.commit(async (tx) => {
					const draft = await tx.doc(SessionMetaDoc, conversation.id);
					draft.owner = to;
				}, BACKGROUND_CONTEXT);
			}
			cursor = page.next;
		} while (cursor !== undefined);
	});
}
