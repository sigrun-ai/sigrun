/**
 * The `core/skills` view (tabs+skills Task 12): every skill root the
 * deployment serves — Workspace / Learned / Config dir / Packages ·
 * <pkg> / Deleted — with owned-skill CRUD, git history with per-file
 * diffs, and overlays for the read-only roots.
 *
 * - The caller sees THEIR OWN roots: workspace skills under
 *   `workspaceRoot(user)`, learned skills + overlays + the learned
 *   history through `curationOf(user)` (Task 9), the workspace history
 *   through `workspaceHistoryFor(user)` (Task 10), and the deployment's
 *   shared roots (`userDir`, the package roots) through Task 11's
 *   `listAllRoots` / `readSkillFile` / `listSupportFiles`. A principal
 *   without a user gets access `none`.
 * - The tree is DATA-BOUND (the Task 4 bump contract): every action
 *   ends with `bumpAllInstances("core","skills")`; the tree itself
 *   carries no per-render rows.
 * - Catch-up of outside edits runs on BOTH of the caller's repos at
 *   most once per repo per 30 s (an in-memory per-repo timestamp —
 *   renders re-run on every data refetch, and the throttle is what
 *   keeps "when the tab opens" true without spawning git per render),
 *   bounded at 5 s with errors swallowed (a broken repo shows its
 *   reason in the history pane; listing and editing still work).
 * - Writes: workspace skills live in the workspace repo
 *   (`workspaceHistory.write`, frontmatter + `scanContent` + the name
 *   rule, refuse-if-exists); learned skills go through the SkillStore
 *   (`apply` create/patch/archive, `restoreVersion`, `pin`); user-dir
 *   and package skills are READ-ONLY here — the caller's per-user
 *   overlay (`resolveUpstream` → `OverlayStore.put` with the upstream
 *   hash) is their only write.
 * - `restoreDeleted` refuses a reused name with "a skill named <name>
 *   exists in <root>; rename or delete it first" (Review Focus 5) — and
 *   a deleted selection's ONLY action is the *Restore deleted* button
 *   that dispatches it (whole-branch review I2: Edit/Delete/restore a
 *   version never render there). `restoreVersion` on a workspace skill
 *   refuses the same way when the target commit predates the name's
 *   newest delete while a live row holds the name (the reused skill's
 *   history chain spans the old skill's commits; a plain restore would
 *   silently overwrite it).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@sigrun/shared/blocks";
import type { GitHistory } from "../../history/git.js";
import type { OverlayStore } from "../../curation/overlays.js";
import { resolveUpstream } from "../../curation/overlays.js";
import { validSkillName } from "../../curation/names.js";
import { scanContent } from "../../curation/scan.js";
import type { SkillStore } from "../../curation/store.js";
import {
	listAllRoots,
	listSupportFiles,
	readSkillFile,
	type RootSkill,
	type SkillRootKind,
} from "../../skills/roots.js";
import { parseSkillFile } from "../../skills/index.js";
import type {
	ActionResult,
	Principal,
	SurfaceContext,
	SurfaceDef,
	SurfaceRenderResult,
} from "../../extension.js";
import {
	buildSkillsTree,
	parseRowId,
	rowIdOf,
	SKILLS_HISTORY_PAGE_SIZE,
	skillsInstanceKey,
	skillsParamsOf,
	skillsNoneTree,
	historyPage,
	sidebarRows,
	type SkillFormData,
	type SkillMainData,
	type SkillsViewParams,
} from "./skills-tree.js";

/** The deps the view needs (the brief's SkillsViewDeps shape). */
export interface SkillsViewDeps {
	curationOf(
		user: string,
	): { store: SkillStore; overlays: OverlayStore; history: GitHistory } | undefined;
	workspaceRoot(user: string | undefined): string | undefined;
	workspaceHistoryFor(user: string): GitHistory | undefined;
	/** The learned discovery root (`<userArea>/skills`) — the store's own
	 *  layout, threaded because the store's public surface hides the path. */
	learnedDirOf(user: string): string | undefined;
	userDir: string;
	packageRoots(): readonly { extension: string; dir: string }[];
	/** Every action ends with `bumpAllInstances("core","skills")`. */
	bump(): void;
	/** The clock (the catch-up throttle + form defaults). */
	now?(): Date;
	/** Whole-branch review I3: the caller the USERLESS SUPERUSER acts as.
	 *  The naive single-operator loopback principal owns no skills of its
	 *  own (skills are per-user), so the view resolves it to the PRIMARY
	 *  ADMIN — the same fallback the jail uses (the earliest-created
	 *  directory user with the admin flag). Absent (an empty directory),
	 *  the superuser sees the deployment's shared roots with its own
	 *  (empty) workspace/learned scope — the pre-I3 posture. The dep
	 *  receives the full principal: only the userless SUPERUSER resolves;
	 *  an anonymous non-superuser stays undefined (access none). */
	resolveUserlessCaller?(principal: Principal): string | undefined;
}

/** The catch-up contract (the brief, verbatim): once per repo per 30 s, 5 s bound. */
export const SKILLS_CATCHUP_INTERVAL_MS = 30_000;
export const SKILLS_CATCHUP_DEADLINE_MS = 5_000;

/** The one SKILL.md (frontmatter + body) for a write. */
function skillFileText(name: string, description: string, body: string): string {
	const trimmed = body.replace(/^\s+/, "").replace(/\s+$/, "");
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n${trimmed === "" ? "" : `${trimmed}\n`}`;
}

/** Whether `payload` is a plain object. */
function isObject(payload: unknown): payload is Record<string, unknown> {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

/**
 * One string field of the payload. Form dispatches wrap the fields as
 * `{values: {...}, rev}` (the webui FormBlock contract); callout-level
 * buttons dispatch a null payload and their targets ride the instance
 * params. This reads the top level first, then the `values` envelope,
 * so both shapes resolve.
 */
function fieldOf(payload: unknown, key: string): string | undefined {
	if (!isObject(payload)) return undefined;
	const top = payload[key];
	if (typeof top === "string") return top;
	const values = payload.values;
	if (isObject(values)) {
		const nested = values[key];
		if (typeof nested === "string") return nested;
	}
	return undefined;
}

/** The `{itemId}` a collection activation carries. */
function itemIdOf(payload: unknown): string | undefined {
	return fieldOf(payload, "itemId");
}

/** The action result for a thrown error. */
function failure(error: unknown): ActionResult {
	return {
		ok: false,
		error: { message: error instanceof Error ? error.message : String(error) },
	};
}

/** One skill's combined "is present anywhere" check (the restoreDeleted refusal). */
function presentRootOf(
	skills: readonly RootSkill[],
	name: string,
): SkillRootKind | undefined {
	return skills.find((skill) => skill.name === name)?.root;
}

/** The root kind one RootSkill's name belongs to in an overlay key. */
type OverlayRootKind = Exclude<SkillRootKind, "learned">;

/** `git log --format=%H -- <pathspec>` rows, oldest-order irrelevant. */
async function logShas(
	history: GitHistory,
	path: string,
	limit: number,
): Promise<readonly { sha: string; summary: string }[]> {
	const commits = await history.log({ path, limit });
	return commits.map((commit) => ({ sha: commit.sha, summary: commit.summary }));
}

	/**
	 * Names the workspace repo's log touches that have NO live row AND
	 * whose newest commit REMOVED the dir (a deleted skill). A name the
	 * log touches that is LIVE again (deleted then re-created) stays
	 * live — its newest commit re-adds files, so the newest-summary
	 * check excludes it.
	 */
	async function deletedWorkspaceSkills(
		history: GitHistory,
		liveNames: ReadonlySet<string>,
	): Promise<string[]> {
		const touched = new Set<string>();
		for (const commit of await history.log({ limit: 1000 })) {
			for (const path of commit.paths) {
				const name = path.split("/")[0] ?? "";
				if (name !== "" && validSkillName(name)) touched.add(name);
			}
		}
		const names: string[] = [];
		for (const name of touched) {
			if (liveNames.has(name)) continue;
			const newest = (await history.log({ path: `${name}/`, limit: 1 }))[0];
			if (newest === undefined) continue;
			if (newest.summary === `delete ${name}`) names.push(name);
		}
		return names.sort();
	}

/** The newest deletion commit's sha for one workspace skill (`{deletionSha}` row field). */
async function deletionShaOf(
	history: GitHistory,
	name: string,
): Promise<{ deletionSha?: string }> {
	const newest = (await history.log({ path: `${name}/`, limit: 1 }))[0];
	return newest !== undefined && newest.summary === `delete ${name}`
? { deletionSha: newest.sha }
: {};
}

/**
 * The newest `delete <name>` commit's sha for one WORKSPACE skill, or
 * undefined when the name was never deleted (whole-branch review I2's
 * reused-name refusal needs the anchor independent of the newest-touch
 * rule {@link deletionShaOf} applies).
 */
async function newestDeletionSha(
	history: GitHistory,
	name: string,
): Promise<string | undefined> {
	// A name's commits are few; the cap only bounds a pathological repo.
	for (const commit of await history.log({ path: `${name}/`, limit: 1000 })) {
		if (commit.summary === `delete ${name}`) return commit.sha;
	}
	return undefined;
}

/**
 * The exact reused-name refusal text (restoreDeleted's existing message,
 * shared with restoreVersion's workspace branch — whole-branch review I2).
 */
function reusedNameError(name: string, root: string): string {
	return `a skill named ${name} exists in ${root}; rename or delete it first`;
}

/** One sha's index in a log page (-1 when absent). */
function pathLogIndex(
	log: readonly { sha: string }[],
	sha: string,
): number {
	return log.findIndex((one) => one.sha === sha);
}

/** The newest commit's sha on one path (the learned archive's restore anchor). */
async function lastActionSha(history: GitHistory, path: string): Promise<string | undefined> {
	const commits = await logShas(history, path, 1);
	return commits[0]?.sha;
}

/** The selection the params point at: the row + how to read/write it. */
interface Selection {
	readonly params: SkillsViewParams;
	readonly skill: RootSkill;
	readonly history: GitHistory | undefined;
	readonly historyAvailable: boolean;
	readonly historyReason: string | null;
	/** The git paths the skill's history pages by (repo-relative; an
	 *  archived learned skill spans both its live and archive homes). */
	readonly historyPaths: readonly string[];
	/** Deleted-group selection (the dir is gone; the pane is the
	 *  history + restore affordance, never a file read). */
	readonly deleted: boolean;
}

/** The view surface (`SurfaceDef<"view">`), built over the Task 9/10/11 deps. */
export function createSkillsView(deps: SkillsViewDeps): SurfaceDef<"view"> {
	const now = deps.now ?? (() => new Date());
	// The per-repo catch-up throttle (the brief's once-per-30s rule).
	const lastCatchUp = new Map<GitHistory, number>();

	/** The caller's EFFECTIVE username (review I3): an anonymous
	 *  principal → undefined (the surface 404s); the userless superuser
	 *  resolves through {@link SkillsViewDeps.resolveUserlessCaller} to
	 *  the primary admin when the dep is wired (else it keeps its own
	 *  undefined scope — the empty-workspace posture). */
	const userOf = (ctx: SurfaceContext): string | undefined =>
		deps.resolveUserlessCaller === undefined
			? ctx.principal.user
			: deps.resolveUserlessCaller(ctx.principal);

	/** The caller's shared root listing (workspace/learned scoped to them). */
	const listFor = (user: string): Promise<readonly RootSkill[]> => {
		const workspace = deps.workspaceRoot(user);
		const learned = deps.learnedDirOf(user);
		return listAllRoots({
			...(workspace === undefined ? {} : { workspace: join(workspace, "skills") }),
			...(learned === undefined ? {} : { learned }),
			userDir: deps.userDir,
			packageRoots: deps.packageRoots(),
		});
	};

	/** One caller's FULL sidebar: the live rows plus a Deleted-group row
	 *  for every skill gone from disk whose history still holds it. */
	const rowsFor = async (user: string): Promise<JsonObject[]> => {
		const skills = await listFor(user);
		const curation = deps.curationOf(user);
		const archived = new Set(
			curation === undefined
				? []
				: (await curation.store.list()).filter((info) => info.archived).map((info) => info.name),
		);
		const rows = sidebarRows(skills, { deleted: archived });
		// Deleted-group rows: a name with NO live row whose repo log still
		// holds the skill. WORKSPACE: the workspace repo's log names it
		// (its dir is gone for good — a present live name stays live).
		// LEARNED: an archived skill's files moved to curation/archive,
		// OUTSIDE the learned discovery root, so its row is synthesized
		// from the store's archived list (listAllRoots never sees it).
		const liveNames = new Set(
			rows.map((row) => row.name).filter((name): name is string => typeof name === "string"),
		);
		const workspaceHistory = deps.workspaceHistoryFor(user);
		if (workspaceHistory !== undefined) {
			for (const name of await deletedWorkspaceSkills(workspaceHistory, liveNames)) {
				rows.push({
					id: rowIdOf("workspace", name),
					name,
					description: "",
					group: "deleted",
					...(await deletionShaOf(workspaceHistory, name)),
				});
			}
		}
		if (curation !== undefined) {
			const infos = await curation.store.list();
			for (const info of infos) {
				if (!info.archived) continue;
				const existing = rows.find(
					(one) => typeof one.id === "string" && one.id === rowIdOf("learned", info.name),
				);
				const sha = await lastActionSha(curation.history, `curation/archive/${info.name}`);
				if (existing === undefined) {
					rows.push({
						id: rowIdOf("learned", info.name),
						name: info.name,
						description: info.description,
						group: "deleted",
						...(sha === undefined ? {} : { deletionSha: sha }),
					});
				} else {
					existing.group = "deleted";
					if (sha !== undefined) existing.deletionSha = sha;
				}
			}
		}
		return rows;
	};

	/** Catch up ONE repo, throttled (once per 30 s) + deadline-bounded + fail-swallowed. */
	async function catchUpThrottled(history: GitHistory): Promise<void> {
		const last = lastCatchUp.get(history);
		const at = now().getTime();
		if (last !== undefined && at - last < SKILLS_CATCHUP_INTERVAL_MS) return;
		lastCatchUp.set(history, at);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), SKILLS_CATCHUP_DEADLINE_MS);
		void controller;
		try {
			await Promise.race([
				history.catchUp({ actor: { kind: "outside" }, summary: "outside changes" }),
				new Promise<undefined>((resolve) => setTimeout(resolve, SKILLS_CATCHUP_DEADLINE_MS)),
			]);
		} catch {
			// Swallowed by design: a broken repo shows its reason in the
			// history pane (availability below); rendering never fails.
		} finally {
			clearTimeout(timer);
		}
	}

	/** The outside-edits catch-up for BOTH of the caller's repos. */
	async function catchUpBoth(user: string): Promise<void> {
		const repos: (GitHistory | undefined)[] = [
			deps.curationOf(user)?.history,
			deps.workspaceHistoryFor(user),
		];
		for (const history of repos) {
			if (history === undefined) continue;
			await catchUpThrottled(history);
		}
	}

	/** The selected skill's history availability (the pane's reason when down). */
	async function availabilityOf(
		history: GitHistory | undefined,
		missingReason: string,
	): Promise<{ available: boolean; reason: string | null }> {
		if (history === undefined) return { available: false, reason: missingReason };
		const state = await history.availability();
		return state.ok ? { available: true, reason: null } : { available: false, reason: state.reason };
	}

	/** Resolve the params' selection against the caller's rows. */
	async function resolveSelection(
		user: string,
		params: SkillsViewParams,
		skills: readonly RootSkill[],
	): Promise<Selection | undefined> {
		if (params.skill === undefined) return undefined;
		const row = skills.find((skill) => {
			if (skill.name !== params.skill) return false;
			if (params.root !== undefined && skill.root !== params.root) return false;
			if (params.root === "package" || skill.root === "package") {
				return skill.root === "package" && skill.packageName === params.pkg;
			}
			return true;
		});
		if (row === undefined) return undefined;
		const workspace = deps.workspaceRoot(user);
		const curation = deps.curationOf(user);
		let history: GitHistory | undefined;
		let missingReason: string;
		let historyPath: string;
		if (row.root === "workspace") {
			history = deps.workspaceHistoryFor(user);
			missingReason =
				workspace === undefined
					? "no workspace is configured for this user"
					: "workspace history is unavailable";
			historyPath = `${row.name}/`;
		} else if (row.root === "learned") {
			history = curation?.history;
			missingReason = "learned history is unavailable";
			// An archived skill's history spans BOTH homes (the archive
			// move's commit names curation/archive/<name>; everything
			// earlier names skills/<name>) — the log runs pathless and
			// filters to commits that touched either side.
			historyPath = `skills/${row.name}`;
		} else {
			history = undefined;
			missingReason =
				row.root === "package"
					? "package skills ship with their extension — no local history"
					: "the config dir has no history";
			historyPath = `${row.name}/`;
		}
		const availability = await availabilityOf(history, missingReason);
		return {
			params,
			skill: row,
			history,
			historyAvailable: availability.available,
			historyReason: availability.reason,
			historyPaths:
				row.root === "learned"
					? [`skills/${row.name}`, `curation/archive/${row.name}`, "curation/state.json"]
					: [historyPath],
			deleted: false,
		};
	}

	/** The caller's overlay key for one non-learned selection. */
	function overlayKeyOf(user: string, row: RootSkill) {
		const workspace = deps.workspaceRoot(user);
		return {
			root: row.root as OverlayRootKind,
			skill: row.name,
			...(row.root === "workspace" && workspace !== undefined ? { workspace } : {}),
		};
	}

	/** The main data branch for a resolved selection. */
	async function mainDataOf(user: string, selection: Selection): Promise<SkillMainData> {
		const row = selection.skill;
		let text = "";
		let description = row.description;
		let body = "";
		if (!selection.deleted && row.error === undefined) {
			try {
				text = await readSkillFile(row.rootDir, row.name, "SKILL.md");
				const parsed = parseSkillFile(text);
				description = parsed?.description ?? row.description;
				body = parsed?.body ?? "";
			} catch (error) {
				body = `(unreadable: ${error instanceof Error ? error.message : String(error)})`;
			}
		}
		const supportFiles = await listSupportFiles(row.rootDir, row.name).catch(() => []);
		let overlay: string | null = null;
		if (row.root !== "learned") {
			const curation = deps.curationOf(user);
			const stored = curation === undefined ? undefined : await curation.overlays.get(overlayKeyOf(user, row)).catch(() => undefined);
			overlay = stored === undefined || stored.orphanedSince !== undefined ? null : stored.text;
		}

		let history: SkillMainData["history"] = {
			available: selection.historyAvailable,
			reason: selection.historyReason,
			items: [],
			hasMore: false,
			nextCursor: null,
		};
		let commit: SkillMainData["commit"] = null;
		if (selection.historyAvailable && selection.history !== undefined) {
			// Multi-path selections (an archived learned skill) page
			// pathless and filter: git's own -- <path> can only take ONE
			// pathspec through history.log, and the union matters more
			// than the fetch margin (the log is per-repo, bounded).
			const pathless = selection.historyPaths.length > 1;
			const raw = await selection.history.log({
				...(pathless ? {} : { path: selection.historyPaths[0] }),
				limit: pathless
					? (SKILLS_HISTORY_PAGE_SIZE + 1) * 4
					: SKILLS_HISTORY_PAGE_SIZE + 1,
				...(selection.params.cursor === undefined
					? {}
					: { before: selection.params.cursor }),
			});
			const commits = pathless
				? raw.filter((one) =>
						one.paths.some((path) =>
							selection.historyPaths.some(
								(root) => path === root || path.startsWith(`${root}/`),
							),
						),
					)
					: raw;
			const page = historyPage(commits);
			history = {
				available: true,
				reason: null,
				items: page.items,
				hasMore: page.hasMore,
				nextCursor: page.nextCursor,
			};
			if (selection.params.commit !== undefined) {
				const files = await selection.history.changes(
					selection.params.commit,
					selection.historyPaths[0],
				);
				commit = { sha: selection.params.commit, files: files.map((file) => ({ ...file })) };
			}
		}
		return {
			name: row.name,
			root: row.root,
			...(row.packageName === undefined ? {} : { pkg: row.packageName }),
			rootDir: row.dir,
			description,
			body,
			supportFiles: [...supportFiles],
			overlay,
			history,
			commit,
		};
	}

	/** The form's pre-filled values (a new skill starts empty; an edit reads the current text). */
	async function formDataOf(
		params: SkillsViewParams,
		selection: Selection | undefined,
	): Promise<SkillFormData> {
		if (params.skill === undefined || selection === undefined) {
			return { name: "", description: "", body: "", where: "workspace" };
		}
		try {
			const text = await readSkillFile(selection.skill.rootDir, selection.skill.name, "SKILL.md");
			const parsed = parseSkillFile(text);
			return {
				name: selection.skill.name,
				description: parsed?.description ?? selection.skill.description,
				body: parsed?.body ?? "",
				where: "workspace",
			};
		} catch {
			return {
				name: selection.skill.name,
				description: selection.skill.description,
				body: "",
				where: "workspace",
			};
		}
	}

	/** One render's full data document (the tree binds it). */
	async function readData(
		user: string,
		params: SkillsViewParams,
	): Promise<{
		data: JsonObject;
		selection: Selection | undefined;
		main: SkillMainData | undefined;
		form: SkillFormData;
		writable: boolean;
	}> {
		const skills = await listFor(user);
		const rows = await rowsFor(user);
		let selection = await resolveSelection(user, params, skills);
		// A Deleted-group row's selection: no live dir, but the repo log
		// still holds the skill — the pane renders its history (and the
		// restore affordance), never a content read.
		if (selection === undefined && params.skill !== undefined) {
			const deletedRow = rows.find(
				(row) =>
					typeof row === "object" &&
					row !== null &&
					(row as JsonObject).group === "deleted" &&
					(row as JsonObject).name === params.skill &&
					(params.root === undefined ||
						(row as JsonObject).id ===
							rowIdOf(params.root, params.skill, params.pkg)),
			) as JsonObject | undefined;
			if (deletedRow !== undefined) {
				const root = params.root ?? "workspace";
				const history =
					root === "learned"
						? deps.curationOf(user)?.history
						: deps.workspaceHistoryFor(user);
				const missingReason =
					root === "learned"
						? "learned history is unavailable"
						: "workspace history is unavailable";
				const availability = await availabilityOf(history, missingReason);
				const synthetic: RootSkill = {
					name: params.skill,
					description: "",
					root,
					rootDir: "",
					dir: "",
					hidden: false,
				};
				selection = {
					params,
					skill: synthetic,
					history,
					historyAvailable: availability.available,
					historyReason: availability.reason,
					historyPaths:
						root === "learned"
							? [`skills/${params.skill}`, `curation/archive/${params.skill}`, "curation/state.json"]
							: [`${params.skill}/`],
					deleted: true,
				};
			}
		}
		const main = selection === undefined ? undefined : await mainDataOf(user, selection);
		const form = await formDataOf(params, selection);
		const writable =
			selection === undefined || selection.skill.root === "learned" || selection.skill.root === "workspace";
		// The actions callout shows for overlay-capable roots too (their
		// buttons are overlay-only) — `writable` is the OWN-roots gate.
		const actionable = writable || selection?.skill.root === "user dir" || selection?.skill.root === "package";
		const data = {
			skills: rows,
			main: main ?? null,
			form,
		};
		// SAFETY: the data document is a JSON mirror (every field a
		// literal); the interfaces lack the index signature JsonObject
		// requires, so the cast only restores that erased identity.
		return { data: data as unknown as JsonObject, selection, main, form, writable: actionable };
	}

	/** The caller's own-root write gate for actions (read-only roots refuse). */
	const selectedParams = (ctx: SurfaceContext): SkillsViewParams => skillsParamsOf(ctx.params);

	/** One action's SELECTION: the params' row, or the archived/deleted
	 *  synthetic row the params name (restoreVersion/restoreDeleted reach
	 *  skills whose live dir is gone — listAllRoots never sees them). */
	async function actionSelection(
		user: string,
		root: SkillRootKind,
		name: string,
	): Promise<Selection | undefined> {
		const skills = await listFor(user);
		const live = await resolveSelection(user, { skill: name, root }, skills);
		if (live !== undefined) return live;
		// The archived/deleted synthetic (the Deleted-group selection):
		// learned → the curation repo; anything else → the workspace repo.
		if (root !== "learned" && root !== "workspace") return undefined;
		const history =
			root === "learned" ? deps.curationOf(user)?.history : deps.workspaceHistoryFor(user);
		const missingReason =
			root === "learned" ? "learned history is unavailable" : "workspace history is unavailable";
		const availability = await availabilityOf(history, missingReason);
		if (!availability.available) return undefined;
		const synthetic: RootSkill = {
			name,
			description: "",
			root,
			rootDir: "",
			dir: "",
			hidden: false,
		};
		return {
			params: { skill: name, root },
			skill: synthetic,
			history,
			historyAvailable: true,
			historyReason: null,
			historyPaths:
				root === "learned"
					? [`skills/${name}`, `curation/archive/${name}`, "curation/state.json"]
					: [`${name}/`],
			deleted: true,
		};
	}

	/** The row an action targets: payload override, else the instance params. */
	async function targetRow(
		ctx: SurfaceContext,
		payload: unknown,
	): Promise<
		| { user: string; skills: readonly RootSkill[]; selection: Selection }
		| { error: ActionResult }
	> {
		const user = userOf(ctx);
		if (user === undefined) return { error: { ok: false, error: { message: "forbidden" } } };
		const skills = await listFor(user);
		const root = (fieldOf(payload, "root") ?? selectedParams(ctx).root) as SkillRootKind | undefined;
		const name = fieldOf(payload, "name") ?? selectedParams(ctx).skill;
		const pkg = fieldOf(payload, "pkg") ?? selectedParams(ctx).pkg;
		if (name === undefined || root === undefined) {
			return { error: { ok: false, error: { message: "the action needs a selected skill (params.skill + params.root)" } } };
		}
		const selection =
			pkg === undefined
				? await actionSelection(user, root, name)
				: await resolveSelection(
						user,
						{ ...selectedParams(ctx), skill: name, root, pkg },
						skills,
					);
		if (selection === undefined) {
			return { error: { ok: false, error: { message: `skill not found: ${name}` } } };
		}
		return { user, skills, selection };
	}

	/** The workspace write: content checks + refuse-if-exists (create) + history write. */
	async function workspaceWrite(
		ctx: SurfaceContext,
		payload: unknown,
		opts: { mode: "create" | "save" },
	): Promise<ActionResult> {
		const user = userOf(ctx);
		if (user === undefined) return { ok: false, error: { message: "forbidden" } };
		const history = deps.workspaceHistoryFor(user);
		const workspace = deps.workspaceRoot(user);
		if (history === undefined || workspace === undefined) {
			return { ok: false, error: { message: "workspace history is unavailable" } };
		}
		const name = fieldOf(payload, "name") ?? selectedParams(ctx).skill;
		const description = fieldOf(payload, "description");
		const body = fieldOf(payload, "body");
		if (name === undefined || !validSkillName(name)) {
			return { ok: false, error: { message: "a valid skill name is required (lowercase letters, digits, dashes)", field: "name" } };
		}
		if (description === undefined || description.trim() === "") {
			return { ok: false, error: { message: "a description is required", field: "description" } };
		}
		const text = skillFileText(name, description.trim(), body ?? "");
		const scanned = scanContent(text);
		if (!scanned.ok) {
			return { ok: false, error: { message: `content scan refused line ${scanned.line}: ${scanned.rule}`, field: "body" } };
		}
		// The work tree (<workspace>/skills) must exist BEFORE the
		// history write: prepare()'s access check fails a missing tree,
		// and the mutation would land with no commit (the e2e race: a
		// fresh workspace has no skills dir until the first skill).
		const skillsRoot = join(workspace, "skills");
		await mkdir(skillsRoot, { recursive: true });
		const skills = await listFor(user);
		const existing = skills.find((skill) => skill.name === name && skill.root === "workspace");
		if (opts.mode === "create" && existing !== undefined) {
			return { ok: false, error: { message: `skill already exists: ${name}`, field: "name" } };
		}
		if (opts.mode === "save" && existing === undefined) {
			return { ok: false, error: { message: `skill not found: ${name}` } };
		}
		try {
			const sha = await history.write(
				{
					actor: { kind: "user", user },
					summary: opts.mode === "create" ? `create ${name}` : `edit ${name}`,
					action: opts.mode === "create" ? "create" : "patch",
					skill: name,
				},
				async () => {
					const dir = join(skillsRoot, name);
					await mkdir(dir, { recursive: true });
					await writeFile(join(dir, "SKILL.md"), text);
				},
				{ kind: "outside" },
			);
			void sha;
			deps.bump();
			return {
				ok: true,
				toast: `${opts.mode === "create" ? "Created" : "Saved"} ${name}`,
				navigate: { type: "navigate", params: { skill: name, root: "workspace" } },
			};
		} catch (error) {
			return failure(error);
		}
	}

	return {
		id: "skills",
		title: "Skills",
		icon: "book",
		placement: "view",
		instanceKey: skillsInstanceKey,
		render: async (ctx: SurfaceContext) => {
			const user = userOf(ctx);
			if (user === undefined) {
				return { tree: skillsNoneTree(), data: {}, access: "none" };
			}
			await catchUpBoth(user);
			const params = skillsParamsOf(ctx.params);
			const { data, selection, main, form, writable } = await readData(user, params);
			return {
				tree: buildSkillsTree(params, main, form, {
					writable,
					historyAvailable: selection?.historyAvailable ?? false,
					selectedExists: selection !== undefined,
					...(selection?.deleted === true ? { deleted: true } : {}),
				}),
				data,
				access: "write",
			};
		},
		data: async (ctx: SurfaceContext) => {
			const user = userOf(ctx);
			if (user === undefined) return { data: {}, access: "none" };
			// The data path renders too (a refetch IS a tab-open cycle), so
			// the throttle — not the route — is the git-spawn guard.
			await catchUpBoth(user);
			const params = skillsParamsOf(ctx.params);
			const { data } = await readData(user, params);
			return { data, access: "write" };
		},
		actions: {
			// The sidebar row's drill-in: {itemId} = the row id (root:name[:pkg]).
			openSkill: async (ctx: SurfaceContext, payload: unknown): Promise<ActionResult> => {
				if (userOf(ctx) === undefined) return { ok: false, error: { message: "forbidden" } };
				const parsed = parseRowId(itemIdOf(payload) ?? "");
				if (parsed === undefined) {
					return { ok: false, error: { message: "openSkill expects {itemId}" } };
				}
				return {
					ok: true,
					navigate: {
						type: "navigate",
						params: {
							skill: parsed.name,
							root: parsed.root,
							...(parsed.pkg === undefined ? {} : { pkg: parsed.pkg }),
						},
					},
				};
			},
			// A history row's drill-in: {itemId} = the commit sha.
			openCommit: async (ctx: SurfaceContext, payload: unknown): Promise<ActionResult> => {
				if (userOf(ctx) === undefined) return { ok: false, error: { message: "forbidden" } };
				const sha = itemIdOf(payload);
				if (sha === undefined) {
					return { ok: false, error: { message: "openCommit expects {itemId}" } };
				}
				const params = selectedParams(ctx);
				return {
					ok: true,
					navigate: {
						type: "navigate",
						params: {
							...(params.skill === undefined ? {} : { skill: params.skill }),
							...(params.root === undefined ? {} : { root: params.root }),
							...(params.pkg === undefined ? {} : { pkg: params.pkg }),
							commit: sha,
						},
					},
				};
			},
			create: async (ctx: SurfaceContext, payload: unknown): Promise<ActionResult> => {
				const user = userOf(ctx);
				if (user === undefined) return { ok: false, error: { message: "forbidden" } };
				const where = fieldOf(payload, "where") ?? "workspace";
				const name = fieldOf(payload, "name");
				const description = fieldOf(payload, "description");
				const body = fieldOf(payload, "body");
				if (name === undefined || !validSkillName(name)) {
					return { ok: false, error: { message: "a valid skill name is required (lowercase letters, digits, dashes)", field: "name" } };
				}
				if (description === undefined || description.trim() === "") {
					return { ok: false, error: { message: "a description is required", field: "description" } };
				}
				if (where === "learned") {
					const curation = deps.curationOf(user);
					if (curation === undefined) {
						return { ok: false, error: { message: "learned skills are unavailable" } };
					}
					try {
						await curation.store.apply(
							name,
							{ kind: "create", content: skillFileText(name, description.trim(), body ?? "") },
							{ actor: "user" },
						);
					} catch (error) {
						return failure(error);
					}
					deps.bump();
					return {
						ok: true,
						toast: `Created ${name}`,
						navigate: { type: "navigate", params: { skill: name, root: "learned" } },
					};
				}
				return workspaceWrite(ctx, payload, { mode: "create" });
			},
			save: async (ctx: SurfaceContext, payload: unknown): Promise<ActionResult> => {
				const user = userOf(ctx);
				if (user === undefined) return { ok: false, error: { message: "forbidden" } };
				// The form's name field is DISABLED on an existing skill
				// (names are read-only after creation) — a disabled field never
				// rides the submit envelope, so the name comes from the params.
				const name = selectedParams(ctx).skill ?? fieldOf(payload, "name");
				const description = fieldOf(payload, "description");
				const body = fieldOf(payload, "body");
				if (name === undefined) {
					return { ok: false, error: { message: "save needs a selected skill (params.skill)" } };
				}
				if (description === undefined || description.trim() === "") {
					return { ok: false, error: { message: "a description is required", field: "description" } };
				}
				const root = (fieldOf(payload, "root") ?? selectedParams(ctx).root) as SkillRootKind | undefined;
				if (root === "learned") {
					const curation = deps.curationOf(user);
					if (curation === undefined) {
						return { ok: false, error: { message: "learned skills are unavailable" } };
					}
					try {
						const current = await curation.store.view(name);
						const next = skillFileText(name, description.trim(), body ?? "");
						await curation.store.apply(
							name,
							{ kind: "patch", old: current, new: next },
							{ actor: "user" },
						);
					} catch (error) {
						return failure(error);
					}
					deps.bump();
					return {
						ok: true,
						toast: `Saved ${name}`,
						navigate: { type: "navigate", params: { skill: name, root: "learned" } },
					};
				}
				return workspaceWrite(ctx, { ...(isObject(payload) ? payload : {}), name }, { mode: "save" });
			},
			delete: async (ctx: SurfaceContext, payload: unknown): Promise<ActionResult> => {
				const targeted = await targetRow(ctx, payload);
				if ("error" in targeted) return targeted.error;
				const { user, selection } = targeted;
				const name = selection.skill.name;
				if (selection.skill.root === "learned") {
					const curation = deps.curationOf(user);
					if (curation === undefined) return { ok: false, error: { message: "learned skills are unavailable" } };
					try {
						await curation.store.apply(name, { kind: "archive" }, { actor: "user" });
					} catch (error) {
						return failure(error);
					}
					deps.bump();
					return { ok: true, toast: `Deleted ${name} (archived)`, navigate: { type: "navigate", params: {} } };
				}
				if (selection.skill.root === "workspace") {
					const workspace = deps.workspaceRoot(user);
					if (workspace === undefined) {
						return { ok: false, error: { message: "no workspace is configured for this user" } };
					}
					try {
						const history = deps.workspaceHistoryFor(user);
						// The mutation runs with or without the repo (GitHistory's
						// fail-soft contract): no history → the delete still lands.
						if (history === undefined) {
							await rm(join(workspace, "skills", name), { recursive: true, force: true });
						} else {
							await history.write(
								{
									actor: { kind: "user", user },
									summary: `delete ${name}`,
									action: "remove_file",
									skill: name,
								},
								async () => {
									await rm(join(workspace, "skills", name), { recursive: true, force: true });
								},
								{ kind: "outside" },
							);
						}
					} catch (error) {
						return failure(error);
					}
					deps.bump();
					return { ok: true, toast: `Deleted ${name}`, navigate: { type: "navigate", params: {} } };
				}
				return { ok: false, error: { message: `${selection.skill.root} skills are read-only here` } };
			},
			restoreVersion: async (ctx: SurfaceContext, payload: unknown): Promise<ActionResult> => {
				const targeted = await targetRow(ctx, payload);
				if ("error" in targeted) return targeted.error;
				const { user, selection } = targeted;
				const sha = fieldOf(payload, "sha") ?? selectedParams(ctx).commit;
				if (sha === undefined) {
					return { ok: false, error: { message: "restoreVersion needs a commit (params.commit)" } };
				}
				const name = selection.skill.name;
				if (selection.skill.root === "learned") {
					const curation = deps.curationOf(user);
					if (curation === undefined) return { ok: false, error: { message: "learned skills are unavailable" } };
					try {
						await curation.store.restoreVersion(name, sha, { actor: "user" });
					} catch (error) {
						return failure(error);
					}
					deps.bump();
					return { ok: true, toast: `Restored ${name} to ${sha.slice(0, 8)}` };
				}
				if (selection.skill.root === "workspace") {
					const history = deps.workspaceHistoryFor(user);
					if (history === undefined) {
						return { ok: false, error: { message: "workspace history is unavailable" } };
					}
					// Whole-branch review I2: the reused-name hole. When the
					// name was deleted and then RE-created, the live skill's
					// history chain includes the old skill's commits (same
					// path), so a restore anchored on a PRE-DELETE commit would
					// silently overwrite the live (reused) skill. Refuse the
					// moment the target predates the newest delete while the
					// live row exists — restoreDeleted's refusal, applied to
					// the reachable path.
					const skills = await listFor(user);
					const live = skills.some(
						(one) => one.name === name && one.root === "workspace",
					);
					if (live) {
						const deletionSha = await newestDeletionSha(history, name);
						if (deletionSha !== undefined) {
							// The name's own history, newest-first: every commit
							// listed AFTER the delete is older than it (the
							// pre-reuse chain — restoring from it would silently
							// overwrite the live, reused skill).
							const pathLog = await history.log({ path: `${name}/`, limit: 10_000 });
							const deleteAt = pathLogIndex(pathLog, deletionSha);
							const targetAt = pathLogIndex(pathLog, sha);
							if (
								deleteAt !== -1 &&
								(targetAt === -1 || targetAt > deleteAt)
							) {
								return {
									ok: false,
									error: { message: reusedNameError(name, "workspace") },
								};
							}
						}
					}
					try {
						await history.restore(sha, [name], {
							actor: { kind: "user", user },
							summary: `restore ${name}@${sha.slice(0, 8)}`,
							action: "restore",
							skill: name,
						});
					} catch (error) {
						return failure(error);
					}
					deps.bump();
					return { ok: true, toast: `Restored ${name} to ${sha.slice(0, 8)}` };
				}
				return { ok: false, error: { message: `${selection.skill.root} skills are read-only here` } };
			},
			restoreDeleted: async (ctx: SurfaceContext, payload: unknown): Promise<ActionResult> => {
				const user = userOf(ctx);
				if (user === undefined) return { ok: false, error: { message: "forbidden" } };
				const name = fieldOf(payload, "name") ?? selectedParams(ctx).skill;
				const sha = fieldOf(payload, "sha") ?? selectedParams(ctx).commit;
				if (name === undefined || sha === undefined) {
					return { ok: false, error: { message: "restoreDeleted needs a name and a commit sha" } };
				}
				const skills = await listFor(user);
				// Review Focus 5: a reused name refuses, naming the root that has it.
				const present = presentRootOf(skills, name);
				if (present !== undefined) {
					return {
						ok: false,
						error: { message: reusedNameError(name, present) },
					};
				}
				const root = (fieldOf(payload, "root") ?? selectedParams(ctx).root ?? "workspace") as SkillRootKind;
				if (root === "learned") {
					const curation = deps.curationOf(user);
					if (curation === undefined) return { ok: false, error: { message: "learned skills are unavailable" } };
					try {
						// The anchor: the row's sha is the newest commit touching
						// the ARCHIVE path — the archive-move commit itself. The
						// live state (files in skills/ + the state.json row) is
						// its PARENT's tree; restoring it un-archives the name.
						const parent = await curation.history.parentOf(sha);
						if (parent === undefined) {
							return { ok: false, error: { message: "the deletion commit has no parent to restore from" } };
						}
						await curation.store.restoreVersion(name, parent, { actor: "user" });
					} catch (error) {
						return failure(error);
					}
					deps.bump();
					return { ok: true, toast: `Restored ${name}`, navigate: { type: "navigate", params: { skill: name, root: "learned" } } };
				}
				const history = deps.workspaceHistoryFor(user);
				if (history === undefined) {
					return { ok: false, error: { message: "workspace history is unavailable" } };
				}
				try {
					const parent = await history.parentOf(sha);
					await history.restore(parent, [name], {
						actor: { kind: "user", user },
						summary: `restore ${name} (was deleted)`,
						action: "restore",
						skill: name,
					});
				} catch (error) {
					return failure(error);
				}
				deps.bump();
				return { ok: true, toast: `Restored ${name}`, navigate: { type: "navigate", params: { skill: name, root: "workspace" } } };
			},
			pin: async (ctx: SurfaceContext, payload: unknown): Promise<ActionResult> => {
				const targeted = await targetRow(ctx, payload);
				if ("error" in targeted) return targeted.error;
				const { user, selection } = targeted;
				if (selection.skill.root !== "learned") {
					return { ok: false, error: { message: "only learned skills pin" } };
				}
				const curation = deps.curationOf(user);
				if (curation === undefined) return { ok: false, error: { message: "learned skills are unavailable" } };
				try {
					await curation.store.pin(selection.skill.name, true);
				} catch (error) {
					return failure(error);
				}
				deps.bump();
				return { ok: true, toast: `Pinned ${selection.skill.name}` };
			},
			archive: async (ctx: SurfaceContext, payload: unknown): Promise<ActionResult> => {
				const targeted = await targetRow(ctx, payload);
				if ("error" in targeted) return targeted.error;
				const { user, selection } = targeted;
				if (selection.skill.root !== "learned") {
					return { ok: false, error: { message: "only learned skills archive" } };
				}
				const curation = deps.curationOf(user);
				if (curation === undefined) return { ok: false, error: { message: "learned skills are unavailable" } };
				try {
					await curation.store.apply(selection.skill.name, { kind: "archive" }, { actor: "user" });
				} catch (error) {
					return failure(error);
				}
				deps.bump();
				return { ok: true, toast: `Archived ${selection.skill.name}` };
			},
			overlayPut: async (ctx: SurfaceContext, payload: unknown): Promise<ActionResult> => {
				const targeted = await targetRow(ctx, payload);
				if ("error" in targeted) return targeted.error;
				const { user, selection } = targeted;
				if (selection.skill.root === "learned") {
					return { ok: false, error: { message: "an overlay never applies to a learned skill" } };
				}
				const curation = deps.curationOf(user);
				if (curation === undefined) return { ok: false, error: { message: "overlays are unavailable" } };
				const text = fieldOf(payload, "text");
				if (text === undefined || text.trim() === "") {
					return { ok: false, error: { message: "overlay text is required", field: "text" } };
				}
				const workspace = deps.workspaceRoot(user);
				const key = {
					root: selection.skill.root as OverlayRootKind,
					skill: selection.skill.name,
					...(selection.skill.root === "workspace" && workspace !== undefined
						? { workspace }
						: {}),
				};
				try {
					const upstream = await resolveUpstream(key, undefined, BACKGROUND, {
						userDir: deps.userDir,
						packageRoots: deps.packageRoots,
					});
					if (upstream === undefined) {
						return { ok: false, error: { message: `the upstream skill is absent: ${selection.skill.name}` } };
					}
					await curation.overlays.put(key, text, upstream.hash, { actor: "user" });
				} catch (error) {
					return failure(error);
				}
				deps.bump();
				return { ok: true, toast: `Overlay saved for ${selection.skill.name}` };
			},
			overlayRemove: async (ctx: SurfaceContext, payload: unknown): Promise<ActionResult> => {
				const targeted = await targetRow(ctx, payload);
				if ("error" in targeted) return targeted.error;
				const { user, selection } = targeted;
				if (selection.skill.root === "learned") {
					return { ok: false, error: { message: "an overlay never applies to a learned skill" } };
				}
				const curation = deps.curationOf(user);
				if (curation === undefined) return { ok: false, error: { message: "overlays are unavailable" } };
				const workspace = deps.workspaceRoot(user);
				const key = {
					root: selection.skill.root as OverlayRootKind,
					skill: selection.skill.name,
					...(selection.skill.root === "workspace" && workspace !== undefined
						? { workspace }
						: {}),
				};
				try {
					await curation.overlays.remove(key, { actor: "user" });
				} catch (error) {
					return failure(error);
				}
				deps.bump();
				return { ok: true, toast: `Overlay removed for ${selection.skill.name}` };
			},
		},
	};
}

/** The chord background context for overlay resolution (no conversation env). */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
const BACKGROUND = BACKGROUND_CONTEXT;

// Re-exported so the server's attach and the tests share the row-id shape.
export { rowIdOf };
