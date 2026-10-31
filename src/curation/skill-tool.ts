/**
 * The `skill_manage` tool (curator P3, spec §6.3): the model-facing
 * surface over the per-user {@link SkillStore} and {@link OverlayStore}.
 *
 * Read actions — `list`/`view` — work for the conversation owner
 * ANYWHERE (an ordinary owned conversation can inspect its own user's
 * learned skills; an ownerless one is answered with "there is no
 * owner").
 *
 * Mutating actions — `create`/`patch`/`write_file`/`remove_file`/
 * `archive`/`restore`/`overlay` — execute ONLY inside a curator run
 * (`CurationRunDoc` present): the store user is the run doc's `user`,
 * NEVER the calling principal (a run reviewing a bob-shared parent on
 * alice's behalf writes alice's store). Outside a run the call is
 * refused here (A8's wrapper will intercept first later — this is the
 * backstop the brief pins).
 *
 * Read-before-write: `patch`/`write_file`/`remove_file`/`archive`/
 * `overlay` on an EXISTING item require its name in the run doc's
 * `viewed` ledger (fed by `view` through `markViewed`) — the curator
 * never edits a skill it has not seen. A `create` on a name that does
 * not exist yet needs no prior view.
 *
 * Every mutating result carries `details.curation = {changeId, summary}`
 * — the change id for the P8 undo surface and a one-line summary for
 * the UI.
 */

import type { Context } from "@earendil-works/chord";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { SkillStore } from "./store.js";
import type { OverlayStore } from "./overlays.js";
import { curationRun, markViewed } from "./run-doc.js";
import { SessionMetaDoc } from "../server/session-meta.js";

/** The overlay roots (the `overlay_root` parameter's union). */
type OverlayRoot = "workspace" | "user dir" | "package";

/** The tool's parameter union (the brief's exact shape). */
const skillManageParameters = Type.Object({
	action: Type.Union(
		[
			"list",
			"view",
			"create",
			"patch",
			"write_file",
			"remove_file",
			"archive",
			"restore",
			"overlay",
		].map((action) => Type.Literal(action)),
		{ description: "The action to perform." },
	),
	name: Type.Optional(
		Type.String({ description: "The skill name." }),
	),
	file_path: Type.Optional(
		Type.String({ description: "A support file path (patch/write_file/remove_file)." }),
	),
	content: Type.Optional(
		Type.String({ description: "The full content (create) or file body (write_file)." }),
	),
	old_text: Type.Optional(
		Type.String({ description: "The unique span to replace (patch)." }),
	),
	new_text: Type.Optional(
		Type.String({ description: "The replacement span (patch)." }),
	),
	absorbed_into: Type.Optional(
		Type.String({ description: "The skill this one merges into (archive)." }),
	),
	reason: Type.Optional(
		Type.String({ description: "Why the change is made (the feed entry's reason)." }),
	),
	overlay_root: Type.Optional(
		Type.Union(
			["workspace", "user dir", "package"].map((root) => Type.Literal(root)),
			{ description: "The upstream root an overlay attaches to." },
		),
	),
	remove: Type.Optional(
		Type.Boolean({ description: "overlay: remove the stored overlay instead of writing it." }),
	),
});

/** The mutating actions (the read actions are `list` and `view`). */
const MUTATING = new Set([
	"create",
	"patch",
	"write_file",
	"remove_file",
	"archive",
	"restore",
	"overlay",
]);

/** The read-before-write actions: an EXISTING item must have been viewed. */
const READ_BEFORE_WRITE = new Set([
	"patch",
	"write_file",
	"remove_file",
	"archive",
	"overlay",
]);

/** What the tool needs from the host: the per-user store pair. */
export interface SkillManageDeps {
	/** The conversation owner's stores (read actions). */
	readonly storesOf: (owner: string | undefined) =>
		| { readonly store: SkillStore; readonly overlays: OverlayStore }
		| undefined;
}

/** An explicit tool error: text content the model can read and recover from. */
function error(message: string): ToolExecutionResult {
	return { output: [{ type: "text", text: message }], isError: true };
}

/** The resolved conversation owner through the api's document reader. */
async function ownerOf(
	api: ToolExecutionApi,
	ctx: Context,
): Promise<string | undefined> {
	try {
		const meta = await api.snapshot(SessionMetaDoc, api.conversationId, ctx);
		return meta?.owner;
	} catch {
		return undefined;
	}
}

/** Render the store's `list` result as the model-facing text. */
function renderList(
	skills: readonly {
		name: string;
		description: string;
		archived: boolean;
		pinned: boolean;
	}[],
): string {
	if (skills.length === 0) return "No learned skills.";
	return skills
		.map(
			(skill) =>
				`- ${skill.name}: ${skill.description}${skill.archived ? " (archived)" : ""}${skill.pinned ? " (pinned)" : ""}`,
		)
		.join("\n");
}

/**
 * Build the `skill_manage` tool. Installed by the skills extension
 * (`src/skills/index.ts`) once its options carry the curation wiring —
 * ordinary conversations get the read actions, curator runs get
 * everything.
 */
export function buildSkillManageTool(deps: SkillManageDeps) {
	return defineTool({
		name: "skill_manage",
		description:
			"Inspect and manage the user's learned skills. list/view work for the conversation owner anywhere; every other action runs only inside a curator run.",
		parameters: skillManageParameters,
		async execute(
			args: {
				action: string;
				name?: string;
				file_path?: string;
				content?: string;
				old_text?: string;
				new_text?: string;
				absorbed_into?: string;
				reason?: string;
				overlay_root?: OverlayRoot;
				remove?: boolean;
			},
			api: ToolExecutionApi,
			context: Context,
		): Promise<ToolExecutionResult> {
			const owner = await ownerOf(api, context);
			// Ownerless conversations: nothing to read (and no user to write
			// for — the mutating refusal below covers those too, but the read
			// answer is the one the brief pins).
			if (args.action === "list" || args.action === "view") {
				if (owner === undefined) {
					return error("This conversation has no owner, so there are no learned skills to inspect.");
				}
				const stores = deps.storesOf(owner);
				if (stores === undefined) {
					return error("No skill store is configured for this owner.");
				}
				if (args.action === "list") {
					api.output(renderList(await stores.store.list()));
					return {};
				}
				if (args.name === undefined) return error("view requires a skill name.");
				try {
					api.output(await stores.store.view(args.name, args.file_path ?? "SKILL.md"));
				} catch (cause) {
					return error(cause instanceof Error ? cause.message : String(cause));
				}
				// A view inside a curator run feeds the read-before-write ledger.
				const run = await curationRun(api, api.conversationId, context);
				if (run !== undefined) await markViewed(api, args.name, context);
				return {};
			}

			if (!MUTATING.has(args.action)) {
				return error(`Unknown action: ${args.action}`);
			}
			// Mutating actions run only inside a curator run; the store user
			// is the run doc's user, never the calling principal.
			const run = await curationRun(api, api.conversationId, context);
			if (run === undefined || run.user === "") {
				return error(
					"Mutating skill changes run only inside a curator run; this conversation carries no run.",
				);
			}
			const stores = deps.storesOf(run.user);
			if (stores === undefined) {
				return error(`No skill store is configured for ${run.user}.`);
			}
			if (args.name === undefined) return error(`${args.action} requires a skill name.`);
			const meta = {
				actor: "curator" as const,
				...(run.reviewId === undefined ? {} : { reviewId: run.reviewId }),
				conversationId: api.conversationId as number,
				...(args.reason === undefined ? {} : { reason: args.reason }),
			};
			// Read-before-write: an existing item must carry its name in the
			// run doc's viewed ledger. A skill that does not exist yet (a
			// create, or a first overlay) needs no prior view.
			const exists =
				args.action === "overlay"
					? await stores.overlays
							.get({ root: args.overlay_root ?? "user dir", skill: args.name })
							.then((overlay) => overlay !== undefined)
							.catch(() => false)
					: (await stores.store.list().catch(() => []))
							.some((skill) => skill.name === args.name);
			if (exists && READ_BEFORE_WRITE.has(args.action) && !run.viewed.includes(args.name)) {
				return error(
					`Read-before-write: view "${args.name}" before changing it in this run.`,
				);
			}
			try {
				let entry;
				switch (args.action) {
					case "create":
						entry = await stores.store.apply(
							args.name,
							{ kind: "create", content: args.content ?? "" },
							meta,
						);
						break;
					case "patch":
						entry = await stores.store.apply(
							args.name,
							{
								kind: "patch",
								old: args.old_text ?? "",
								new: args.new_text ?? "",
								...(args.file_path === undefined ? {} : { file: args.file_path }),
							},
							meta,
						);
						break;
					case "write_file":
						entry = await stores.store.apply(
							args.name,
							{ kind: "write_file", file: args.file_path ?? "", content: args.content ?? "" },
							meta,
						);
						break;
					case "remove_file":
						entry = await stores.store.apply(
							args.name,
							{ kind: "remove_file", file: args.file_path ?? "" },
							meta,
						);
						break;
					case "archive":
						entry = await stores.store.apply(
							args.name,
							{
								kind: "archive",
								...(args.absorbed_into === undefined ? {} : { absorbedInto: args.absorbed_into }),
							},
							meta,
						);
						break;
					case "restore":
						entry = await stores.store.apply(args.name, { kind: "restore" }, meta);
						break;
					case "overlay": {
						if (args.remove === true) {
							entry = await stores.overlays.remove(
								{ root: args.overlay_root ?? "user dir", skill: args.name },
								meta,
							);
							break;
						}
						// The upstream hash pins what the overlay was written
						// against: the CURRENT upstream body, when one is served.
						const body = await stores.store.view(args.name).catch(() => undefined);
						entry = await stores.overlays.put(
							{ root: args.overlay_root ?? "user dir", skill: args.name },
							args.content ?? "",
							// A missing body (no learned copy) still writes the
							// overlay — drift detection simply has nothing to
							// compare against until the upstream exists.
							body === undefined
								? ""
								: createHash("sha256").update(body, "utf8").digest("hex"),
							meta,
						);
						break;
					}
				}
				if (entry === undefined) {
					return error(`Unknown action: ${args.action}`);
				}
				api.output(`${args.action} ${args.name}: recorded as ${entry.id}`);
				return {
					details: {
						curation: {
							changeId: entry.id,
							summary: `${args.action} ${args.name}${args.reason === undefined ? "" : ` — ${args.reason}`}`,
						},
					} as never,
				};
			} catch (cause) {
				return error(cause instanceof Error ? cause.message : String(cause));
			}
		},
	});
}
