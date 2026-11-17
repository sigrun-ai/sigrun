/**
 * Attachments workstream Task 6 (spec §4.6): the deferred lean-retry
 * notice. Task 5's boot-time recovery (`OpenedHarness.leanRetries`)
 * marks the conversations whose NEXT request attempt skips extension
 * `pi.generation` request hooks — the crash guard that lets a reply
 * retry get past a hook that killed the host mid-preparation. The
 * recovery itself is headless (it runs in openHarness, before
 * `harness.resume()`); the NOTICE runs from createServer, where the
 * notices service exists.
 *
 * One notice per recovered conversation, core-owned and keyed
 * `generation.lean-retry.<conversationId>` so a repost is an idempotent
 * replace, never a stack. Recipient resolution goes through
 * `effectiveOwner`: a live declared owner wins, an absent or orphaned
 * owner falls back to the primary admin, and an empty directory
 * (single-operator mode) has no recipient at all — that arm logs one
 * line instead of posting (`NoticesService.post` rejects users outside
 * the directory). A posting failure is a side report, never a boot
 * failure: it is logged and the remaining conversations still post.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { OpenedHarness } from "../harness/boot.js";
import { effectiveOwner } from "../harness/identity/primary-admin.js";
import type { NoticesService } from "../notices/service.js";
import { SessionMetaDoc } from "./session-meta.js";

/**
 * Post the lean-retry notice for every boot-recovered conversation.
 * Each conversation's `SessionMetaDoc` snapshot supplies the display
 * name (`name` ?? `autoName` ?? "Conversation <id>") and the declared
 * owner the recipient resolves from.
 */
export async function noticeLeanRetries(deps: {
	opened: OpenedHarness;
	notices: Pick<NoticesService, "post">;
	log?: (line: string) => void;
}): Promise<void> {
	const { opened, notices } = deps;
	const log = deps.log ?? ((line: string) => console.info(line));
	for (const id of opened.leanRetries) {
		const meta = await opened.harness.snapshot(
			SessionMetaDoc,
			id,
			BACKGROUND_CONTEXT,
		);
		if (meta?.internal === true) {
			log(`lean retry: conversation ${id} is internal; no notice posted`);
			continue;
		}
		const name = meta?.name ?? meta?.autoName ?? `Conversation ${id}`;
		const body =
			`The server restarted while preparing a reply in "${name}", so the reply was retried without extension request hooks. ` +
			`Recall, reminders and similar additions were skipped for that reply.`;
		const recipient = effectiveOwner(opened.identity.users.list(), meta?.owner);
		if (recipient === undefined) {
			log(`lean retry: ${body}`);
			continue;
		}
		try {
			await notices.post("core", {
				user: recipient,
				key: `generation.lean-retry.${id}`,
				title: "Reply retried without extensions",
				body,
			});
		} catch (cause) {
			log(
				`lean retry: notice for conversation ${id} ("${name}") failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}
	}
}
