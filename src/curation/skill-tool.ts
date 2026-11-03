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
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { SkillStore } from "./store.js";
import type { FeedEntry } from "./store.js";
import {
	OVERLAY_HEADING,
	withOverlay,
	type Overlay,
	type OverlayKey,
	type OverlayStore,
} from "./overlays.js";
import { curationRun, markViewed } from "./run-doc.js";
import { SKILL_MANAGE_READ_ACTIONS } from "./targets.js";
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

/** What the tool needs from the host: the per-user store pair + upstream reads. */
export interface SkillManageDeps {
	/** The conversation owner's stores (read actions). */
	readonly storesOf: (owner: string | undefined) =>
		| { readonly store: SkillStore; readonly overlays: OverlayStore }
		| undefined;
	/**
	 * The canonical workspace path for a workspace-root overlay key
	 * (A5's `overlayForSkill` derivation: the workspace-root accessor,
	 * falling back to the conversation env's cwd).
	 */
	readonly workspaceOf: (env: ExecutionEnv | undefined) => string | undefined;
	/**
	 * The CURRENT upstream body + hash for an overlay key (A5's
	 * `resolveUpstream`, wired by the skills extension with the discovery
	 * roots): what the overlay action hashes a write against, and what
	 * the `view` fallback serves for upstream-only names. `undefined`
	 * when no upstream resolves (a vanished skill).
	 */
	readonly upstreamOf: (
		key: OverlayKey,
		env: ExecutionEnv | undefined,
		ctx: Context,
	) => Promise<{ body: string; hash: string } | undefined>;
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

/**
 * The `view` fallback for upstream-only names (the overlay lifecycle):
 * a name with no learned copy can still carry a stored overlay and/or a
 * live upstream — the exact shape an overlay update/remove decision
 * needs. Serves the upstream body with the overlay under
 * {@link OVERLAY_HEADING} (the served shape `load_skill` uses), or the
 * overlay alone when the upstream is currently absent (an orphan).
 * Returns an error message naming the skill when neither exists.
 */
async function viewUpstreamOnly(
	deps: SkillManageDeps,
	stores: { readonly overlays: OverlayStore },
	args: { name: string; overlay_root?: OverlayRoot },
	env: ExecutionEnv | undefined,
	ctx: Context,
): Promise<string> {
	// A stored overlay for this skill name: the exact root when the call
	// names one, else whichever root holds one (that key decides).
	const stored: Overlay | undefined =
		args.overlay_root !== undefined
			? await stores.overlays
					.get({ root: args.overlay_root, skill: args.name })
					.catch(() => undefined)
			: (await stores.overlays.list().catch((): readonly Overlay[] => [])).find(
					(overlay) => overlay.key.skill === args.name,
				);
	const key: OverlayKey = stored?.key ?? {
		root: args.overlay_root ?? "user dir",
		skill: args.name,
		...(args.overlay_root === "workspace"
			? { workspace: deps.workspaceOf(env) ?? "" }
			: {}),
	};
	const upstream = await deps.upstreamOf(key, env, ctx).catch(() => undefined);
	if (stored === undefined && upstream === undefined) {
		return `unknown skill "${args.name}" — no learned copy, no stored overlay, and no upstream resolved in the ${key.root} root.`;
	}
	const notes: string[] = [
		`(no learned copy of "${args.name}"; showing the ${key.root} upstream${stored === undefined ? "" : " with the stored overlay"})`,
	];
	if (stored?.orphanedSince !== undefined) {
		notes.push("(the upstream is currently ABSENT — the overlay is orphaned)");
	}
	let body: string;
	if (upstream === undefined) {
		body = `${OVERLAY_HEADING}\n\n${stored?.text ?? ""}`;
	} else if (stored === undefined) {
		body = upstream.body;
	} else {
		body = withOverlay(upstream.body, stored.text);
	}
	return `${notes.join(" ")}\n\n${body}`;
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
			if (SKILL_MANAGE_READ_ACTIONS.has(args.action)) {
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
				const learned = await stores.store
					.view(args.name, args.file_path ?? "SKILL.md")
					.then(
						(body) => body as string | undefined,
						() => undefined as string | undefined,
					);
				if (learned === undefined) {
					// Upstream-only names (the overlay lifecycle): serve the stored
					// overlay and/or the live upstream — without this fallback the
					// learned-root ENOENT traps an overlay update/remove in an
					// unrecoverable "view X first" → "unknown skill" loop.
					const served = await viewUpstreamOnly(
						deps,
						stores,
						{ name: args.name, overlay_root: args.overlay_root },
						api.env,
						context,
					);
					if (served.startsWith("unknown skill")) return error(served);
					api.output(served);
				} else {
					api.output(learned);
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
			// The overlay key: the workspace root path (A9) for a workspace
			// overlay, exactly as serving keys it.
			const overlayKey: OverlayKey | undefined =
				args.action === "overlay"
					? {
							root: args.overlay_root ?? "user dir",
							skill: args.name,
							...(args.overlay_root === "workspace"
								? { workspace: deps.workspaceOf(api.env) ?? "" }
								: {}),
						}
					: undefined;
			const meta = {
				actor: "curator" as const,
				...(run.reviewId === undefined ? {} : { reviewId: run.reviewId }),
				conversationId: api.conversationId as number,
				...(args.reason === undefined ? {} : { reason: args.reason }),
			};
			// Empty content: a create/write_file carrying no text records a
			// phantom empty entry (the cleanup-pass C1). Refuse UP FRONT, at
			// the tool boundary, naming the empty content — the store's
			// frontmatter check would otherwise answer a create with the
			// misleading "frontmatter is required", and a write_file would
			// silently land an empty support file plus its feed entry.
			if (
				(args.action === "create" || args.action === "write_file") &&
				(args.content ?? "") === ""
			) {
				return error(
					`${args.action} ${args.name}: empty content — nothing to write.`,
				);
			}
			// Read-before-write: an existing item must carry its name in the
			// run doc's viewed ledger. A skill that does not exist yet (a
			// create, or a first overlay) needs no prior view.
			const exists =
				args.action === "overlay"
					? await stores.overlays
							.get(overlayKey!)
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
				let entry: FeedEntry | undefined;
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
						const key = overlayKey!;
						if (args.remove === true) {
							entry = await stores.overlays.remove(key, meta);
							break;
						}
						// The upstream hash pins what the overlay was written
						// against: the CURRENT upstream body resolved through the
						// A5 machinery (the workspace/user-dir/package roots). The
						// learned root is by construction ABSENT for an overlay
						// target — hashing it stored `""` and the first drift
						// pass flagged every tool-written overlay.
						const upstream = await deps.upstreamOf(key, api.env, context);
						if (upstream === undefined) {
							// A vanished upstream is a user-visible problem, not a ""
							// hash: refuse the create, naming the missing skill.
							return error(
								`no upstream skill "${args.name}" resolved in the ${key.root} root — an overlay attaches to a skill the user does not own. Restore the upstream (or pass its real overlay_root) before writing an overlay for it.`,
							);
						}
						entry = await stores.overlays.put(
							key,
							args.content ?? "",
							upstream.hash,
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
