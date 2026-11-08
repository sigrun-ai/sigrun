/**
 * The `core/skills` view's PURE tree builders (tabs+skills Task 12):
 * no I/O, no process state — sidebar rows, the data document, and the
 * page tree as pure functions of their inputs, so the tree suite pins
 * them without a server (and the 3000-commit case stays cheap).
 *
 * The tree is DATA-BOUND (the Task 4 bump contract): every list binds
 * `{$: ...}` against the data document; `bumpAllInstances("core",
 * "skills")` after any write refetches data against an unchanged tree.
 * Per-row drill-in rides the `edit`+`{itemId}` activation (`openSkill`
 * / `openCommit` handlers return the navigate — navigate params are
 * static literals and can never carry the activated row's id; the
 * core/jobs Critical-2 pattern). Actions live ONLY on blocks whose
 * contract carries them: `page`, `callout`, and card templates.
 */

import type { JsonObject, Tree } from "@sigrun/shared/blocks";
import type { HistoryCommit } from "../../history/git.js";
import type { RootSkill, SkillRootKind } from "../../skills/roots.js";
import type { Principal } from "../../extension.js";

/** The history page size (the brief's 25-per-page rule). */
export const SKILLS_HISTORY_PAGE_SIZE = 25;

/**
 * Sidebar group ids, in display order (the brief's grouping).
 * Whole-branch review I5 — the spec's semantics: the `<configDir>/skills`
 * root groups under **Config dir**; package skills get PER-PACKAGE groups
 * appended after the declared ones (the collection contract tolerates
 * unknown group keys — webui, TUI and the text renderer all title an
 * undeclared group by its key, so the key IS the display string:
 * `· <pkg>`). Workspace / Learned / Deleted are unchanged.
 */
export const SKILL_GROUPS = [
	"workspace",
	"learned",
	"config-dir",
	"deleted",
] as const;

export type SkillGroupId = (typeof SKILL_GROUPS)[number];

/** One package skill's per-package group key — `· <pkg>`. Undeclared
 *  groups render under their key, so the key doubles as the title. */
export function packageGroupKey(pkg: string): string {
	return `· ${pkg}`;
}

/** The group titles for the DECLARED groups. */
export const GROUP_TITLES: Record<SkillGroupId, string> = {
	workspace: "Workspace",
	learned: "Learned",
	"config-dir": "Config dir",
	deleted: "Deleted",
};

/** One history row in the data document. */
export interface SkillHistoryRow {
	readonly id: string;
	readonly sha: string;
	readonly at: string;
	readonly summary: string;
	readonly author: string;
	readonly curator: boolean;
	readonly reviewId?: string;
}

/** One selected commit's per-file before/after (the diff panes' data). */
export interface SkillCommitFile {
	readonly path: string;
	readonly before: string;
	readonly after: string;
	/** The elision marker row (whole-branch review I6): present ONLY on
	 *  the trailing row the total-bytes cap inserted; its `path` names
	 *  the count of omitted files. */
	readonly elided?: true;
}

/**
 * The TOTAL bytes one commit's inlined before+after texts may occupy
 * across ALL files (whole-branch review I6): `changes()` caps each side
 * per file at 64 KiB, but a many-file commit could still blow the 4 MiB
 * view cap and 500 the tab. Beyond this budget the remaining files are
 * replaced by ONE elision marker row.
 */
export const SKILLS_COMMIT_TOTAL_BYTES = 512 * 1024;

/** The elision marker text (the tree pins it; the UI shows it). */
export function elidedMarker(omitted: number): string {
	return `diff truncated — ${omitted} more file${omitted === 1 ? "" : "s"}`;
}

/**
 * Cap a commit's files to the total inline budget (review I6): files
 * embed in path order until the running before+after total would pass
 * {@link SKILLS_COMMIT_TOTAL_BYTES}; the rest collapse into one marker
 * row. A single file always embeds (its sides are already per-file
 * capped at 64 KiB) — the budget is checked BETWEEN files, never
 * against the first.
 */
export function capCommitFiles(
	files: readonly SkillCommitFile[],
): SkillCommitFile[] {
	let total = 0;
	const kept: SkillCommitFile[] = [];
	for (const file of files) {
		const size = file.before.length + file.after.length;
		if (kept.length > 0 && total + size > SKILLS_COMMIT_TOTAL_BYTES) break;
		kept.push(file);
		total += size;
	}
	const omitted = files.length - kept.length;
	if (omitted === 0) return kept;
	return [
		...kept,
		{ path: elidedMarker(omitted), before: "", after: "", elided: true },
	];
}

/** The main branch of the data document for a selected skill. */
export interface SkillMainData {
	readonly name: string;
	readonly root: SkillRootKind;
	readonly pkg?: string;
	readonly rootDir: string;
	readonly description: string;
	readonly body: string;
	readonly supportFiles: readonly string[];
	/** The caller's overlay text on a non-learned root (null when none). */
	readonly overlay: string | null;
	readonly history: {
		readonly available: boolean;
		readonly reason: string | null;
		/** Rows up to and including the selected on-page commit. */
		readonly before: readonly SkillHistoryRow[];
		/** Rows after the selected commit; empty without an on-page selection. */
		readonly after: readonly SkillHistoryRow[];
		readonly hasMore: boolean;
		readonly nextCursor: string | null;
	};
	readonly commit: {
		readonly sha: string;
		readonly files: readonly SkillCommitFile[];
	} | null;
}

/** The form branch of the data document (bind target `/form`). */
export interface SkillFormData {
	readonly name: string;
	readonly description: string;
	readonly body: string;
}

/** The view's params (spec §7.3: JSON, size-capped by the route). */
export interface SkillsViewParams {
	readonly skill?: string;
	readonly root?: SkillRootKind;
	readonly pkg?: string;
	readonly commit?: string;
	readonly cursor?: string;
	readonly edit?: true;
}

/** A non-empty string, or undefined (bad types drop). */
function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** Parse the instance params (loose JSON → the typed shape). */
export function skillsParamsOf(params: JsonObject): SkillsViewParams {
	const out: {
		skill?: string;
		root?: SkillRootKind;
		pkg?: string;
		commit?: string;
		cursor?: string;
		edit?: true;
	} = {};
	const skill = stringOf(params.skill);
	const root = stringOf(params.root);
	const pkg = stringOf(params.pkg);
	const commit = stringOf(params.commit);
	const cursor = stringOf(params.cursor);
	if (skill !== undefined) out.skill = skill;
	if (
		root === "workspace" ||
		root === "learned" ||
		root === "user dir" ||
		root === "package"
	) {
		out.root = root;
	}
	if (pkg !== undefined) out.pkg = pkg;
	if (commit !== undefined) out.commit = commit;
	if (cursor !== undefined) out.cursor = cursor;
	if (params.edit === true) out.edit = true;
	return out;
}

/** The brief's instance key: principal-scoped, params-folded. */
export function skillsInstanceKey(params: JsonObject, principal: Principal): string {
	return JSON.stringify([principal.user ?? "", params]);
}

/** The row id an activated sidebar card reports as `{itemId}` (stable, parseable). */
export function rowIdOf(root: SkillRootKind, name: string, pkg?: string): string {
	return `${root}:${name}${pkg === undefined ? "" : `:${pkg}`}`;
}

/** Parse a sidebar row id back into its root/name/pkg (undefined on a foreign shape). */
export function parseRowId(id: string): { root: SkillRootKind; name: string; pkg?: string } | undefined {
	const root = id.startsWith("workspace:")
		? "workspace"
		: id.startsWith("learned:")
			? "learned"
			: id.startsWith("user dir:")
				? "user dir"
				: id.startsWith("package:")
					? "package"
					: undefined;
	if (root === undefined) return undefined;
	const rest = id.slice(root.length + 1);
	if (rest === "") return undefined;
	if (root !== "package") return { root, name: rest };
	const at = rest.lastIndexOf(":");
	if (at <= 0) return undefined;
	const pkg = rest.slice(at + 1);
	const name = rest.slice(0, at);
	return pkg === "" || name === "" ? undefined : { root, name, pkg };
}

/** One skill's sidebar group (a per-package id for package skills). */
export function groupOfRow(skill: RootSkill, deleted: boolean): SkillGroupId | string {
	if (deleted) return "deleted";
	switch (skill.root) {
		case "workspace":
			return "workspace";
		case "learned":
			return "learned";
		// Review I5: the spec's semantics — `<configDir>/skills` IS the
		// Config dir group; a package skill groups under its own package.
		case "user dir":
			return "config-dir";
		case "package":
			return packageGroupKey(skill.packageName ?? "unknown");
	}
}

/** The data rows the sidebar collection binds (grouped by {@link groupOfRow}). */
export function sidebarRows(
	skills: readonly RootSkill[],
	opts?: { deleted?: ReadonlySet<string> },
): JsonObject[] {
	const deleted = opts?.deleted ?? new Set<string>();
	return skills.map((skill) => ({
		id: rowIdOf(skill.root, skill.name, skill.packageName),
		name: skill.name,
		description: skill.description,
		group: groupOfRow(skill, deleted.has(skill.name)),
		...(skill.packageName === undefined ? {} : { pkg: skill.packageName }),
		...(skill.shadowedBy === undefined
			? {}
			: { shadowedBy: `shadowed by ${skill.shadowedBy}` }),
		...(skill.hidden ? { hidden: true } : {}),
		...(skill.error === undefined ? {} : { error: skill.error }),
	}));
}

/** The ordered `groups` declaration. The DECLARED groups order the
 *  sidebar; per-package groups (`· <pkg>`) are undeclared and append
 *  after them, rendered under their key (the collection contract
 *  tolerates unknown group keys). */
function sidebarGroups(): JsonObject[] {
	return [
		{ id: "workspace", title: "Workspace" },
		{ id: "learned", title: "Learned" },
		{ id: "config-dir", title: "Config dir" },
		{ id: "deleted", title: "Deleted" },
	];
}

/** One history row (curator commits flag the review navigation). */
export function historyRowOf(commit: HistoryCommit): SkillHistoryRow {
	const curator = commit.actor.kind === "curator" || commit.reviewId !== undefined;
	return {
		id: commit.sha,
		sha: commit.sha,
		at: commit.at,
		summary: commit.summary,
		author:
			commit.actor.kind === "user" ? commit.actor.user : commit.actor.kind,
		...(curator ? { curator: true } : { curator: false }),
		...(commit.reviewId === undefined ? {} : { reviewId: commit.reviewId }),
	};
}

/** The history page for the data document (the brief's 25-per-page + cursor). */
export function historyPage(
	commits: readonly HistoryCommit[],
): { items: SkillHistoryRow[]; hasMore: boolean; nextCursor: string | null } {
	const page = commits.slice(0, SKILLS_HISTORY_PAGE_SIZE).map(historyRowOf);
	const last = page[page.length - 1];
	return {
		items: page,
		hasMore: commits.length > SKILLS_HISTORY_PAGE_SIZE,
		nextCursor: last === undefined ? null : last.sha,
	};
}

/** Whether the caller can write the selected root (the view's surface access). */
export function canWrite(
	selection: { root: SkillRootKind } | undefined,
	historyAvailable: boolean,
): boolean {
	if (selection === undefined) return true;
	if (selection.root === "workspace") return historyAvailable;
	return selection.root === "learned";
}

/** One bound history card action; rows without a review id hide it. */
function historyRowActions(): JsonObject[] {
	return [
		{
			id: "review",
			label: "Review",
			icon: "link",
			action: {
				type: "navigate",
				target: {
					view: {
						extension: "curator",
						id: "curator",
						params: { review: { $: "./reviewId" } },
					},
				},
			},
		},
	];
}

/** One selected-skill callout's action buttons (per-page literals; handlers resolve params). */
function skillActions(params: SkillsViewParams, historyAvailable: boolean, deleted: boolean, deletionSha?: string): JsonObject[] {
	// A deleted selection: NO edit/delete/restore — the dir is gone
	// (Edit's save would error "skill not found") — only the
	// restore-deleted affordance, anchored on the SERVER-resolved
	// deletion commit (never a caller-selected history commit).
	if (deleted) {
		if (!historyAvailable) return [];
		if (deletionSha === undefined) return [];
		return [
			{
				id: "skill-restore-deleted",
				label: "Restore deleted",
				icon: "refresh",
				action: {
					type: "submit",
					name: "restoreDeleted",
					confirm: {
						title: "Restore this deleted skill?",
						body: "Bring the skill back exactly as it was before the deletion commit.",
					},
				},
			},
		];
	}
	const nav = (extra: Record<string, unknown>): JsonObject => {
		const navParams: Record<string, string | true> = {};
		if (params.skill !== undefined) navParams.skill = params.skill;
		if (params.root !== undefined) navParams.root = params.root;
		if (params.pkg !== undefined) navParams.pkg = params.pkg;
		for (const [key, value] of Object.entries(extra)) {
			if (value === true || typeof value === "string") navParams[key] = value;
		}
		return { type: "navigate", params: navParams } as JsonObject;
	};
	// Read-only roots (user dir / package) are overlay-only: no edit,
	// no delete, no restore — the caller never owns those files.
	if (params.root === "user dir" || params.root === "package") {
		return [
			{
				id: "skill-overlay",
				label: "Write an overlay",
				icon: "edit",
				action: { type: "submit", name: "overlayPut" },
			},
			{
				id: "skill-overlay-remove",
				label: "Remove the overlay",
				icon: "delete",
				action: {
					type: "submit",
					name: "overlayRemove",
					confirm: { title: "Remove the overlay?", body: "Remove your note from this skill? The skill itself is untouched." },
				},
			},
		];
	}
	const buttons: JsonObject[] = [
		{
			id: "skill-edit",
			label: "Edit",
			icon: "edit",
			action: nav({ edit: true }),
		},
		{
			id: "skill-delete",
			label: "Delete",
			icon: "delete",
			action: {
				type: "submit",
				name: "delete",
				confirm: {
					title: "Delete skill?",
					body: "Delete this skill? Its history keeps every version.",
					tone: "bad",
				},
			},
		},
	];
	if (params.root === "learned") {
		buttons.push({
			id: "skill-pin",
			label: "Pin",
			icon: "tag",
			action: { type: "submit", name: "pin" },
		});
	}
	if (params.commit !== undefined && params.root !== undefined && historyAvailable) {
		buttons.push({
			id: "skill-restore",
			label: "Restore this version",
			icon: "refresh",
			action: {
				type: "submit",
				name: "restoreVersion",
				confirm: {
					title: "Restore this version?",
					body: "Make the skill exactly as it was at this commit (a new commit records the restore).",
				},
			},
		});
	}
	return buttons;
}

/** The form fields (new skill vs edit: the name is read-only on an
 *  existing skill). A new skill always lands in the workspace: the
 *  learned root is the curator's, so the form offers no choice. */
function formFields(editingExisting: boolean): JsonObject[] {
	return [
		{
			type: "text",
			name: "name",
			label: "Name",
			required: true,
			pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
			help: "lowercase letters, digits, dashes",
			...(editingExisting ? { disabled: true } : {}),
		},
		{
			type: "text",
			name: "description",
			label: "Description",
			required: true,
		},
		{
			type: "longtext",
			name: "body",
			label: "Body",
			syntax: "markdown",
			rows: 16,
			fill: true,
		},
	];
}

/** The anonymous/none-access tree (an empty page; the route 404s it). */
export function skillsNoneTree(): Tree {
	// SAFETY: the tree object is a JSON literal built here; `Tree`'s
	// interfaces lack the index signature the wire type requires, so the
	// cast only restores that erased identity.
	return {
		v: 1,
		root: {
			type: "page",
			id: "skills-root",
			title: "Skills",
			main: [{ type: "markdown", text: "Sign in to see skills." }],
		},
	} as unknown as Tree;
}

/**
 * The full tree for one render: the sidebar collection (bound,
 * grouped), the main column for the selection state (list / edit form /
 * selected skill with history + diffs), and the compact-drill-in
 * `selection` contract (Task 3). Blocks are built as loose JSON
 * objects; the service validates every tree before serving.
 */
export function buildSkillsTree(
	params: SkillsViewParams,
	main: SkillMainData | undefined,
	// The form VALUES ride the data document (bind "/form"); the tree
	// declares the fields only — the parameter pins the signature the
	// render path fills (pre-filled edit values land in data, not the tree).
	_form: SkillFormData,
	opts: {
		readonly writable: boolean;
		readonly historyAvailable: boolean;
		readonly selectedExists: boolean;
		/** A Deleted-group selection (review I2): the action set is the
		 *  restore-deleted affordance only — never Edit/Delete. */
		readonly deleted?: boolean;
		/** The server-resolved deletion commit the restore anchors on. */
		readonly deletionSha?: string;
	},
): Tree {
	const editing = params.edit === true && (params.skill === undefined || opts.selectedExists);
	const editingExisting = editing && params.skill !== undefined;
	const selected = !editing && params.skill !== undefined && main !== undefined;

	const sidebar: JsonObject[] = [
		{
			type: "collection",
			id: "skills",
			display: "list",
			items: { $: "/skills" },
			groupBy: "group",
			groups: sidebarGroups(),
			// Per-row drill-in (the core/jobs Critical-2 pattern): the
			// `edit` activation carries {itemId} (the row id) to `openSkill`,
			// whose accepted result carries the navigate back.
			onActivate: { type: "edit", name: "openSkill" },
			item: {
				title: { $: "./name" },
				subtitle: { $: "./description" },
				body: { $: "./error" },
				badges: [
					{ text: { $: "./pkg" }, tone: "neutral" },
					{ text: { $: "./shadowedBy" }, tone: "neutral" },
					{ text: { $: "./hidden" }, tone: "neutral" },
				],
			},
		},
	];

	const mainBlocks: JsonObject[] = [];
	if (editing) {
		mainBlocks.push({
			type: "form",
			id: "skill-form",
			bind: "/form",
			mode: "submit",
			onSubmit: editingExisting ? "save" : "create",
			submitLabel: editingExisting ? "Save" : "Create",
			children: formFields(editingExisting),
		});
	} else if (selected && main !== undefined) {
		const historyNav: Record<string, string> = {};
		if (params.skill !== undefined) historyNav.skill = params.skill;
		if (params.root !== undefined) historyNav.root = params.root;
		if (params.pkg !== undefined) historyNav.pkg = params.pkg;
		mainBlocks.push(
			{
				type: "section",
				id: "skill-summary",
				title: { $: "/main/name" },
				actions: opts.writable
					? skillActions(params, opts.historyAvailable, opts.deleted === true, opts.deletionSha)
					: [],
				children: [
					{
						type: "fields",
						rows: [
							{ label: "Root", value: { $: "/main/root" } },
							{ label: "Description", value: { $: "/main/description" } },
							{ label: "Path", value: { $: "/main/rootDir" } },
						],
					},
				],
			},
			...(opts.writable && opts.deleted === true && opts.deletionSha === undefined
				? [
						{
							type: "callout",
							id: "skill-actions",
							tone: "neutral",
							title: "Actions",
							body: "No deletion commit was found for this skill.",
						},
					]
				: []),
			{
				type: "section",
				id: "skill-body",
				title: "SKILL.md",
				children: [{ type: "markdown", text: { $: "/main/body" } }],
			},
			...(main.overlay === null
				? []
				: [
						{
							type: "section",
							id: "skill-overlay",
							title: "Your notes",
							children: [{ type: "markdown", text: { $: "/main/overlay" } }],
						},
					]),
			{
				type: "section",
				id: "skill-files",
				title: "Support files",
				children: [
					{
						type: "collection",
						id: "support-files",
						display: "list",
						items: { $: "/main/supportFiles" },
						item: { title: { $: "./" } },
					},
				],
			},
		);
		if (main.history.available) {
			const historyCard: JsonObject = {
				title: { $: "./summary" },
				subtitle: { $: "./author" },
				meta: [{ time: { $: "./at" }, format: "relative" }],
				badges: [{ text: { $: "./curator" }, tone: "neutral" }],
				actions: historyRowActions(),
			};
			const historyCollection = (id: string, pointer: string): JsonObject => ({
				type: "collection",
				id,
				display: "list",
				items: { $: pointer },
				onActivate: { type: "edit", name: "openCommit" },
				item: historyCard,
			});
			const before = historyCollection("history-before", "/main/history/before");
			const after = historyCollection("history-after", "/main/history/after");
			// An on-page split puts the selected commit's diffs directly
			// below its row; an off-page selection puts them at the end.
			const inline = main.commit !== null && main.history.after.length > 0;
			const commitChildren: JsonObject[] = [];
			if (main.commit !== null) {
				const files: JsonObject[] = main.commit.files.map((file, index): JsonObject =>
					file.elided === true
						? { type: "markdown", id: `commit-elided-${index}`, text: `_${file.path}_` }
						: {
								type: "diff",
								id: `commit-diff-${index}`,
								before: file.before,
								after: file.after,
								lang: "markdown",
							},
				);
				commitChildren.push(
					...(files.length === 0
						? [{ type: "markdown", id: "commit-empty", text: "No changes to this skill in this commit." }]
						: files),
				);
			}
			const historyChildren: JsonObject[] = inline
				? [before, ...commitChildren, after]
				: [before, after, ...commitChildren];
			if (main.history.hasMore && main.history.nextCursor !== null) {
				historyChildren.push({
					type: "callout",
					id: "history-more",
					tone: "neutral",
					title: "More history",
					actions: [
						{
							id: "history-more-load",
							label: "Load more",
							icon: "more",
							action: {
								type: "navigate",
								params: { ...historyNav, cursor: main.history.nextCursor },
							},
						},
					],
				});
			}
			mainBlocks.push({
				type: "section",
				id: "skill-history",
				title: "History",
				children: historyChildren,
			});
		} else {
			mainBlocks.push({
				type: "callout",
				id: "history-unavailable",
				tone: "neutral",
				title: "History unavailable",
				body: { $: "/main/history/reason" },
			});
		}
	} else {
		mainBlocks.push({
			type: "section",
			id: "skill-empty",
			children: [{ type: "markdown", text: "Select a skill" }],
		});
	}

	// SAFETY: the tree object is a JSON literal built here; `Tree`'s
	// interfaces lack the index signature the wire type requires, so the
	// cast only restores that erased identity.
	return {
		v: 1,
		root: {
			type: "page",
			id: "skills-root",
			title: "Skills",
			...(opts.writable
				? {
						actions: [
							{
								id: "skill-new",
								label: "New skill",
								icon: "add",
								action: { type: "navigate", params: { edit: true } },
							},
						],
					}
				: {}),
			sidebar,
			main: mainBlocks,
			selection: {
				selected: editing || (params.skill !== undefined && opts.selectedExists),
				back: {},
			},
			...(params.skill !== undefined && !editing && !opts.selectedExists
				? { empty: { icon: "info", title: "Skill not found" } }
				: {}),
		},
	} as unknown as Tree;
}
