/**
 * The curation host (curator P6, A9): `host.curation` — the
 * extension-facing surface over everything Part A built.
 *
 * ONE object per boot, constructed in boot (where the per-user stores,
 * the curation registry, the jobs records and the harness live) and
 * exposed three ways: on the `OpenedHarness` (tests and server-side
 * callers), on the host bridge (`HostBridge.curation` — the
 * server-owned handle), and on every seam host (`SeamHost.curation`,
 * delegating to the bridge, the same lazy-bind discipline as
 * `conversations`).
 *
 * Read members (eligibility, modelCallsSince, takeHints, targets,
 * tools, skills, overlays, upstream, jobSkillRefs, usage) are thin
 * reads over the A1–A8 primitives. The run producers (forkReview,
 * digestRun, maintain) delegate to the run driver (runs.ts). The store
 * subsets (`skills`, `overlays`) are the REAL per-user stores narrowed
 * to the documented members — never a re-implementation.
 */

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";
import type {
	AgentChange,
	Conversation,
	ConversationId,
	EntryId,
	Harness,
	Registry,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type {
	CurationChangeDetails,
	CurationEligibility,
	CurationHint,
	CurationRunResult,
	CurationTargetInfo,
	HandlerContext,
	MaintenanceBudget,
	MaintenanceReport,
	SigrunCurationHost,
} from "../extension.js";
import { authorsOfEntries } from "./attribution.js";
import { takeHints } from "./wrap.js";
import { digestRunRun, forkReviewRun, setChangeTargetResolver } from "./runs.js";
import { resolveUpstream, type OverlayStore } from "./overlays.js";
import { type QualifiedTarget } from "./targets.js";
import { SkillStore, type FeedEntry, type SkillChange } from "./store.js";
import type { UsageCounters } from "./usage.js";
import { jobSkillRefs } from "../jobs/skills-refs.js";
import { SessionMetaDoc } from "../server/session-meta.js";
import type { Storage } from "@earendil-works/pi-durable";

/** What the curation host needs from boot. */
export interface CurationHostDeps {
	readonly harness: Harness;
	readonly registry: Registry;
	/** The records-only scan handle (run-conversation discovery). */
	readonly storage: Storage;
	/** The boot-built curation-target registry (A7). */
	readonly curation: {
		targets(): readonly QualifiedTarget[];
		byTool(tool: string): QualifiedTarget | undefined;
	};
	/** The boot default model (digest runs' fallback). */
	readonly defaultModel: { readonly provider: string; readonly modelId: string };
	/** The per-user curation wiring (the boot `curationOf`). */
	readonly stores: (
		user: string | undefined,
	) =>
		| {
				readonly store: SkillStore;
				readonly overlays: OverlayStore;
				readonly usage: UsageCounters;
		  }
		| undefined;
	/** The skills-options discovery roots (upstream resolution). */
	readonly skillsOptions: {
		readonly userDir: string;
		readonly packageRoots: () => readonly { extension: string; dir: string }[];
	};
	/**
	 * The server-default agent change (the create op's own store
	 * defaults — modelTools narrowing, per-model thinking): what a
	 * digest conversation starts from.
	 */
	readonly defaultAgent: () => AgentChange;
}

/** Build the one curation host (boot constructs exactly one). */
export function createCurationHost(deps: CurationHostDeps): SigrunCurationHost {
	const { harness, registry, curation } = deps;
	// The change-target resolver: the registry's qualified ids, with the
	// core skills store owning `skill_manage` (no target declares it).
	setChangeTargetResolver((tool: string): string => {
		if (tool === "skill_manage") return "sigrun.skills";
		return curation.byTool(tool)?.id ?? `tool:${tool}`;
	});

	/** The conversation handle (loud when the id is unknown). */
	const conversationOf = async (
		id: ConversationId,
		ctx: Context,
	): Promise<Conversation> => {
		const conversation = await harness.conversation(id, ctx);
		if (conversation === undefined) {
			throw new Error(`conversation ${id} not found`);
		}
		return conversation;
	};

	/** The per-user store pair (loud when the user is absent). */
	const storesOf = (user: string) => {
		const stores = deps.stores(user);
		if (stores === undefined) {
			throw new Error(`unknown user "${user}" — no curation stores`);
		}
		return stores;
	};

	/**
	 * The digest producer `maintain`'s budget hands the target: one
	 * digest run for the SAME user, bounded to the listed tools, with
	 * the remaining wall clock as the deadline.
	 */
	const digestFor = async (
		user: string,
		input: string,
		tools: readonly string[],
		deadline: number,
	): Promise<CurationRunResult> => {
		const remaining = Math.max(1, deadline - Date.now());
		return await digestRunRun(
			{ harness, registry },
			user,
			{
				instruction: input,
				allow: tools,
				maxToolCalls: 8,
				maxOutputTokens: 16_000,
				deadlineMs: remaining,
				reviewId: `digest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
				input,
			},
			deps.defaultModel,
			deps.defaultAgent,
		);
	};

	const host: SigrunCurationHost = {
		async eligibility(id): Promise<CurationEligibility> {
		const meta = await harness.snapshot(
			SessionMetaDoc,
			id,
			BACKGROUND_CONTEXT,
		);
			const conversation = await conversationOf(id, BACKGROUND_CONTEXT);
			const page = await conversation.entries(
				{},
				1,
				undefined,
				BACKGROUND_CONTEXT,
			);
			const authors = await authorsOfEntries(
				harness,
				id,
				BACKGROUND_CONTEXT,
			);
			let unattributed = 0;
			let ownerOnly = true;
			for (const [, author] of authors) {
				if (author === undefined) {
					unattributed += 1;
					ownerOnly = false;
					continue;
				}
				if (author !== meta?.owner) ownerOnly = false;
			}
			return {
				...(meta?.owner === undefined ? {} : { owner: meta.owner }),
				internal: meta?.internal === true,
				ownerOnly,
				unattributed,
				...(page.items[0]?.id === undefined
					? {}
					: { newestEntry: page.items[0].id }),
			};
		},

		async modelCallsSince(id, entryId): Promise<number> {
			const conversation = await conversationOf(id, BACKGROUND_CONTEXT);
			const query =
				entryId === undefined
					? {}
					: { maxEntryId: entryId, order: "descending" as const };
			const page = await conversation.entries(
				query,
				500,
				undefined,
				BACKGROUND_CONTEXT,
			);
			// Newest-first: entries STRICTLY after the anchor (the anchor
			// itself is excluded — modelCallsSince(entry) counts what
			// came after it).
			return page.items.filter(
				(entry) =>
					entry.kind === AssistantEntry.kind &&
					(entryId === undefined || entry.id !== entryId),
			).length;
		},

		async takeHints(id): Promise<readonly CurationHint[]> {
			const conversation = await conversationOf(id, BACKGROUND_CONTEXT);
			return await takeHints(conversation, BACKGROUND_CONTEXT);
		},

		async targets(user, id): Promise<readonly CurationTargetInfo[]> {
			// The selection filter: a target is served for a conversation
			// only when EVERY listed tool is model-visible in that
			// conversation's resolved agent. No id: every target.
			const visible =
				id === undefined ? undefined : await modelVisibleTools(id);
			const result: CurationTargetInfo[] = [];
			for (const target of curation.targets()) {
				if (visible !== undefined) {
					if (target.tools.some((tool) => !visible.has(tool))) continue;
				}
				const guidance = await target.guidance(user);
				if (guidance.length === 0) continue;
				result.push({
					id: target.id,
					tools: [...target.tools],
					guidance: [...guidance],
					maintain: target.maintain !== undefined,
				});
			}
			return result;
		},

		async tools(id): Promise<readonly string[]> {
			const visible = await modelVisibleTools(id);
			return [...visible];
		},

		async forkReview(id, opts): Promise<CurationRunResult> {
			return await forkReviewRun({ harness, registry }, id, opts);
		},

		async digestRun(user, opts): Promise<CurationRunResult> {
			return await digestRunRun(
				{ harness, registry },
				user,
				opts,
				deps.defaultModel,
				deps.defaultAgent,
			);
		},

		async maintain(
			user,
			targetId,
			budget,
		): Promise<MaintenanceReport> {
			const target = curation
				.targets()
				.find((one) => one.id === targetId);
			if (target === undefined) {
				throw new Error(`unknown curation target "${targetId}"`);
			}
			if (target.maintain === undefined) {
				throw new Error(`curation target "${targetId}" declares no maintain`);
			}
			// The budget's run: one digest run for the SAME user, bounded
			// to the listed tools (the target asks for operations as text
			// and applies them itself — the P6 contract).
			const digestBudget: MaintenanceBudget = {
				deadline: budget.deadline,
				runs: budget.runs,
				run: (input, tools) => digestFor(user, input, tools, budget.deadline),
			};
			const ctx: HandlerContext = { abortSignal: undefined };
			return await target.maintain(user, ctx, digestBudget);
		},

		skills(user) {
			const { store } = storesOf(user);
			return {
				list: () => store.list(),
				view: (name, file) => store.view(name, file),
				feed: (limit, before) => store.feed(limit, before),
				pin: (name, pinned) => store.pin(name, pinned),
				undo: (entryIds) => store.undo(entryIds),
				apply: (name, change, meta) =>
					store.apply(
						name,
						change as SkillChange,
						{
							actor: "curator",
							...(meta.reviewId === undefined
								? {}
								: { reviewId: meta.reviewId }),
							...(meta.reason === undefined ? {} : { reason: meta.reason }),
						},
					),
			};
		},

		overlays(user) {
			const { overlays } = storesOf(user);
			return overlays;
		},

		async upstream(user, key) {
			// The upstream read is user-independent (the skill roots are
			// the host's); the user gate only proves a real curated user.
			storesOf(user);
			return await resolveUpstream(key, undefined, BACKGROUND_CONTEXT, {
				userDir: deps.skillsOptions.userDir,
				packageRoots: deps.skillsOptions.packageRoots,
			});
		},

		async jobSkillRefs(user): Promise<ReadonlySet<string>> {
			return await jobSkillRefs(deps.storage, user, BACKGROUND_CONTEXT);
		},

		async undoReview(user, reviewId): Promise<number> {
			const { store } = storesOf(user);
			const entries = await feedOf(store, reviewId);
			// The store undo: entries with a `before` version snapshot are
			// the revertible ones; the store's own undo takes entry ids
			// and restores the snapshots (the A4 machinery).
			const revertible = entries.filter((entry) => entry.before !== undefined);
			let reverted = 0;
			if (revertible.length > 0) {
				const undone = await store.undo(revertible.map((entry) => entry.id));
				reverted = undone.length;
			}
			// The target undos: every change the review's TARGET tools
			// reported. The feed only carries the core stores' entries;
			// a target-owned change's id is the `details.curation`
			// changeId the tool reported, which the caller (the run
			// result's `changes`) holds — undoReview walks the RUN
			// conversation's tool results for them.
			await undoTargetChanges(user, reviewId);
			return reverted;
		},

		async usage(user): Promise<Readonly<Record<string, string | undefined>>> {
			const { usage, store } = storesOf(user);
			const skills = await store.list();
			const result: Record<string, string | undefined> = {};
			for (const skill of skills) {
				result[skill.name] = usage.lastUsed(skill.name);
			}
			return result;
		},
	};
	return host;

	/** The conversation's model-visible tool names. */
	async function modelVisibleTools(id: ConversationId): Promise<Set<string>> {
		const conversation = await conversationOf(id, BACKGROUND_CONTEXT);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		return new Set(agent.tools.map((tool: ToolRegistration) => tool.name));
	}

	/** The feed entries one review caused (newest-first walk). */
	async function feedOf(
		store: SkillStore,
		reviewId: string,
	): Promise<readonly FeedEntry[]> {
		const found: FeedEntry[] = [];
		let before: string | undefined;
		for (;;) {
			const page = await store.feed(100, before);
			if (page.length === 0) break;
			for (const entry of page) {
				if (entry.reviewId === reviewId) found.push(entry);
			}
			before = page[page.length - 1]?.id;
			if (page.length < 100) break;
		}
		return found;
	}

	/**
	 * Undo the target-owned changes one review caused: find the run
	 * conversation by its run doc (`reviewId`), walk its tool results
	 * for `details.curation` changeIds, and hand each to the owning
	 * target's `undo` with the curated user.
	 */
	async function undoTargetChanges(user: string, reviewId: string): Promise<void> {
		const runId = await runConversationOf(reviewId);
		if (runId === undefined) return;
		const conversation = await harness.conversation(runId, BACKGROUND_CONTEXT);
		if (conversation === undefined) return;
		const page = await conversation.entries(
			{ order: "ascending" },
			500,
			undefined,
			BACKGROUND_CONTEXT,
		);
		for (const entry of page.items) {
			if (entry.kind !== "pi.tool-result") continue;
			for (const message of entry.model ?? []) {
				if (message.role !== "toolResult") continue;
				// SAFETY: the tool-result details carry the A6/A8
				// `details.curation` shape ({changeId, summary}); the
				// structural read below only touches those two fields.
				const details = (message as { details?: unknown }).details as
					| { readonly curation?: CurationChangeDetails }
					| undefined;
				const change = details?.curation;
				if (change === undefined) continue;
				const target = curation.byTool(
					(message as { toolName: string }).toolName,
				);
				if (target === undefined) continue;
				await target.undo(user, change.changeId, { abortSignal: undefined });
			}
		}
	}

	/** The run conversation carrying one reviewId (or undefined). */
	async function runConversationOf(
		reviewId: string,
	): Promise<ConversationId | undefined> {
		const { CurationRunDoc } = await import("./run-doc.js");
		let cursor: Awaited<ReturnType<typeof deps.storage.scanConversations>>["next"];
		for (;;) {
			const page = await deps.storage.scanConversations(
				{ order: "descending" },
				50,
				cursor,
				BACKGROUND_CONTEXT,
			);
			for (const record of page.items) {
				const run = await harness.snapshot(
					CurationRunDoc,
					record.id,
					BACKGROUND_CONTEXT,
				);
				if (run?.reviewId === reviewId) return record.id;
			}
			if (page.next === undefined) return undefined;
			cursor = page.next;
		}
	}
};
