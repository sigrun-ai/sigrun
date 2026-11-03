/**
 * Tabs+skills Task 12 (tree half): the pure `core/skills` tree
 * builders (src/server/core-views/skills-tree.ts) — no server, no git.
 *
 * Pinned here:
 *
 * - the sidebar rows group Workspace / Learned / Config dir (the
 *   `<configDir>/skills` root — whole-branch review I5's spec
 *   semantics) / per-package groups (`· <pkg>`) / Deleted, with badges
 *   for packages, shadowed rows and hidden skills;
 * - a history page is 25 rows + *Load more* navigating with the last
 *   sha as `cursor`;
 * - a selected commit renders ONE `diff` block per changed file;
 * - the tree for a 3000-commit history stays under the view limits
 *   (block count < 2000, data < 4 MiB) — the paginator is the guard;
 * - row ids round-trip (openSkill's {itemId} → params).
 */

import { describe, expect, test } from "vitest";
import type { HistoryCommit } from "../src/history/git.js";
import type { RootSkill } from "../src/skills/roots.js";
import {
	buildSkillsTree,
	capCommitFiles,
	GROUP_TITLES,
	groupOfRow,
	historyPage,
	parseRowId,
	rowIdOf,
	sidebarRows,
	SKILLS_COMMIT_TOTAL_BYTES,
	SKILLS_HISTORY_PAGE_SIZE,
	skillsInstanceKey,
	skillsParamsOf,
	type SkillFormData,
	type SkillMainData,
} from "../src/server/core-views/skills-tree.js";

/** Walk every block (the page root + nested children), depth-first. */
function* walk(block: Record<string, any>): Generator<Record<string, any>> {
	yield block;
	for (const key of ["sidebar", "main", "detail", "children"] as const) {
		const children = block[key];
		if (!Array.isArray(children)) continue;
		for (const child of children) {
			const inner =
				typeof child === "object" && child !== null && "block" in child
					? child.block
					: child;
			yield* walk(inner as Record<string, any>);
		}
	}
}

/** Count the blocks in one tree. */
function blockCount(tree: { root: Record<string, any> }): number {
	let count = 0;
	for (const _ of walk(tree.root)) count += 1;
	return count;
}

/** Every block of `type` in the tree. */
function blocksOfType(tree: { root: Record<string, any> }, type: string): Record<string, any>[] {
	const out: Record<string, any>[] = [];
	for (const block of walk(tree.root)) {
		if (block.type === type) out.push(block);
	}
	return out;
}

function skillRow(overrides: Partial<RootSkill> & { name: string }): RootSkill {
	return {
		description: `${overrides.name} description`,
		root: "workspace",
		rootDir: "/acme/skills",
		dir: `/acme/skills/${overrides.name}`,
		hidden: false,
		...overrides,
	};
}

function commitOf(sha: string, overrides?: Partial<HistoryCommit>): HistoryCommit {
	return {
		sha,
		at: "2026-11-02T12:00:00.000Z",
		summary: `edit acme-deploy (${sha.slice(0, 8)})`,
		actor: { kind: "user", user: "alice" },
		paths: ["acme-deploy/SKILL.md"],
		...overrides,
	};
}

const EMPTY_FORM: SkillFormData = {
	name: "",
	description: "",
	body: "",
	where: "workspace",
};

function mainData(overrides?: Partial<SkillMainData>): SkillMainData {
	return {
		name: "acme-deploy",
		root: "workspace",
		rootDir: "/acme/skills",
		description: "deploy the acme stack",
		body: "# Acme deploy\n\nRun the deploy.",
		supportFiles: [],
		overlay: null,
		history: { available: true, reason: null, items: [], hasMore: false, nextCursor: null },
		commit: null,
		...overrides,
	};
}

describe("sidebar rows: groups, badges, shadowed row", () => {
	test("every root groups correctly; packages name their group; losers are shadowed", () => {
		const skills: RootSkill[] = [
			skillRow({ name: "acme-deploy", root: "workspace" }),
			skillRow({ name: "acme-notes", root: "learned", rootDir: "/users/alice/skills", dir: "/users/alice/skills/acme-notes" }),
			skillRow({ name: "acme-shared", root: "user dir", rootDir: "/config/skills", dir: "/config/skills/acme-shared" }),
			skillRow({ name: "acme-packaged", root: "package", packageName: "acme-ext", rootDir: "/pkgs/acme-ext/skills", dir: "/pkgs/acme-ext/skills/acme-packaged" }),
			skillRow({ name: "acme-deploy", root: "package", packageName: "acme-ext", shadowedBy: "workspace", rootDir: "/pkgs/acme-ext/skills", dir: "/pkgs/acme-ext/skills/acme-deploy" }),
			skillRow({ name: "acme-hidden", root: "workspace", hidden: true }),
			skillRow({ name: "acme-archived", root: "learned", rootDir: "/users/alice/skills", dir: "/users/alice/skills/acme-archived" }),
		];
		const rows = sidebarRows(skills, { deleted: new Set(["acme-archived"]) });
		const byName = (name: string, group?: string) =>
			rows.find((row) => row.name === name && (group === undefined || row.group === group));
		expect(byName("acme-deploy", "workspace")).toBeDefined();
		expect(byName("acme-notes")?.group).toBe("learned");
		// Review I5 (the spec's semantics): the `<configDir>/skills` root
		// groups under Config dir; a package skill groups under its own
		// package (`· <pkg>` — the undeclared-group key IS the title).
		expect(byName("acme-shared")?.group).toBe("config-dir");
		expect(byName("acme-packaged")?.group).toBe("· acme-ext");
		// The shadowed loser: the package row, with the winner named.
		const shadowed = rows.filter((row) => row.name === "acme-deploy" && row.group === "· acme-ext");
		expect(shadowed).toHaveLength(1);
		expect(shadowed[0]?.shadowedBy).toBe("shadowed by workspace");
		expect(shadowed[0]?.pkg).toBe("acme-ext");
		// A second package gets its OWN group.
		const other = sidebarRows([
			skillRow({ name: "acme-other", root: "package", packageName: "acme-tools", rootDir: "/pkgs/acme-tools/skills", dir: "/pkgs/acme-tools/skills/acme-other" }),
		]);
		expect(other[0]?.group).toBe("· acme-tools");
		// The hidden flag and the deleted group.
		expect(byName("acme-hidden")?.hidden).toBe(true);
		expect(byName("acme-archived")?.group).toBe("deleted");
		// Error rows surface (never read further).
		const errorSkill = skillRow({ name: "acme-broken", error: "symlinks are not allowed in skill files", description: "" });
		const errorRow = sidebarRows([errorSkill])[0];
		expect(errorRow?.error).toContain("symlinks");
		// Group titles cover the DECLARED groups (per-package groups are
		// undeclared — their key is the title).
		expect(Object.keys(GROUP_TITLES)).toEqual(["workspace", "learned", "config-dir", "deleted"]);
		expect(GROUP_TITLES["config-dir"]).toBe("Config dir");
		expect(groupOfRow(skills[2]!, false)).toBe("config-dir");
		expect(groupOfRow(skills[3]!, false)).toBe("· acme-ext");
	});

	test("row ids round-trip through parseRowId (openSkill's {itemId})", () => {
		expect(parseRowId(rowIdOf("workspace", "acme-deploy"))).toEqual({ root: "workspace", name: "acme-deploy" });
		expect(parseRowId(rowIdOf("user dir", "acme-shared"))).toEqual({ root: "user dir", name: "acme-shared" });
		expect(parseRowId(rowIdOf("package", "acme-packaged", "acme-ext"))).toEqual({ root: "package", name: "acme-packaged", pkg: "acme-ext" });
		expect(parseRowId("nonsense")).toBeUndefined();
	});
});

describe("history paging", () => {
	test("a page of 25 rows + Load more navigating with the last sha as cursor", () => {
		const commits = Array.from({ length: 26 }, (_, index) =>
			commitOf(`${String(index).padStart(40, "0")}`),
		);
		const page = historyPage(commits);
		expect(page.items).toHaveLength(SKILLS_HISTORY_PAGE_SIZE);
		expect(page.hasMore).toBe(true);
		expect(page.nextCursor).toBe(commits[SKILLS_HISTORY_PAGE_SIZE - 1]?.sha);
		// Under one page: no Load more.
		const short = historyPage(commits.slice(0, 3));
		expect(short.hasMore).toBe(false);
		expect(short.items.map((row) => row.sha)).toEqual(commits.slice(0, 3).map((one) => one.sha));

		const tree = buildSkillsTree(
			{ skill: "acme-deploy", root: "workspace" },
			mainData({
				history: {
					available: true,
					reason: null,
					items: page.items,
					hasMore: page.hasMore,
					nextCursor: page.nextCursor,
				},
			}),
			EMPTY_FORM,
			{ writable: true, historyAvailable: true, selectedExists: true },
		);
		const more = blocksOfType(tree, "callout").find((block) => block.id === "history-more");
		expect(more).toBeDefined();
		expect(more?.actions?.[0]?.label).toBe("Load more");
		expect(more?.actions?.[0]?.action).toEqual({
			type: "navigate",
			params: { skill: "acme-deploy", root: "workspace", cursor: commits[24]?.sha },
		});
		// The history collection is data-bound and drills in per row.
		const history = blocksOfType(tree, "collection").find((block) => block.id === "history");
		expect(history?.items).toEqual({ $: "/main/history/items" });
		expect(history?.onActivate).toEqual({ type: "edit", name: "openCommit" });
	});

	test("a curator commit row carries the curator review navigation", () => {
		const page = historyPage([
			commitOf("a".repeat(40), { actor: { kind: "curator" }, reviewId: "rev-1" }),
			commitOf("b".repeat(40)),
		]);
		expect(page.items[0]?.curator).toBe(true);
		expect(page.items[0]?.reviewId).toBe("rev-1");
		expect(page.items[1]?.curator).toBe(false);
		const tree = buildSkillsTree(
			{ skill: "acme-deploy", root: "workspace" },
			mainData({
				history: { available: true, reason: null, items: page.items, hasMore: false, nextCursor: null },
			}),
			EMPTY_FORM,
			{ writable: true, historyAvailable: true, selectedExists: true },
		);
		const history = blocksOfType(tree, "collection").find((block) => block.id === "history");
		const reviewButton = (history?.item?.actions ?? []).find((button: any) => button.id === `curator-${"a".repeat(40)}`);
		expect(reviewButton?.action).toEqual({
			type: "navigate",
			target: { view: { extension: "curator", id: "curator", params: { review: "rev-1" } } },
		});
	});
});

describe("a selected commit", () => {
	test("renders ONE diff block per changed file", () => {
		const files = [
			{ path: "acme-deploy/SKILL.md", before: "# Old\n", after: "# New\n" },
			{ path: "acme-deploy/references/ops.md", before: "", after: "ops notes\n" },
		];
		const tree = buildSkillsTree(
			{ skill: "acme-deploy", root: "workspace", commit: "c".repeat(40) },
			mainData({ commit: { sha: "c".repeat(40), files } }),
			EMPTY_FORM,
			{ writable: true, historyAvailable: true, selectedExists: true },
		);
		const diffs = blocksOfType(tree, "diff");
		expect(diffs).toHaveLength(2);
		expect(diffs[0]).toMatchObject({ before: "# Old\n", after: "# New\n", lang: "markdown" });
		expect(diffs[1]).toMatchObject({ before: "", after: "ops notes\n" });
		expect(diffs[0]?.id).not.toBe(diffs[1]?.id);
		// The selected commit's restore action rides the actions callout.
		const actions = blocksOfType(tree, "callout").find((block) => block.id === "skill-actions");
		const restore = (actions?.actions ?? []).find((button: any) => button.id === "skill-restore");
		expect(restore?.action).toMatchObject({ type: "submit", name: "restoreVersion" });
	});

	test("a wide commit stays under the total-bytes cap with an elision marker (review I6)", () => {
		// changes() caps each side per file at 64 KiB, but a many-file
		// commit would blow the 4 MiB view cap if every file embedded.
		// The TOTAL inline budget is 512 KiB across files; the overflow
		// collapses into ONE marker row.
		// 30 files × 64 KiB/side ≈ 3.8 MiB raw — far over the budget.
		const wide = Array.from({ length: 30 }, (_, index) => ({
			path: `acme-wide/file-${index}.md`,
			before: "b".repeat(64 * 1024),
			after: "a".repeat(64 * 1024),
		}));
		const capped = capCommitFiles(wide);
		// The marker row is last, names the omitted count, and is flagged.
		const marker = capped[capped.length - 1];
		expect(marker?.elided).toBe(true);
		expect(marker?.path).toBe(`diff truncated — ${30 - (capped.length - 1)} more files`);
		// The embedded total is within the budget (one file always embeds).
		const inlined = capped
			.filter((file) => file.elided !== true)
			.reduce((sum, file) => sum + file.before.length + file.after.length, 0);
		expect(inlined).toBeLessThanOrEqual(SKILLS_COMMIT_TOTAL_BYTES);
		expect(inlined).toBeGreaterThan(0);
		// The data document (tree's bind target) is far under the 4 MiB cap.
		const data = { main: { commit: { sha: "c".repeat(40), files: capped } } };
		expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBeLessThan(4 * 1024 * 1024);
		// The tree renders the marker as a markdown note, the kept files as diffs.
		const tree = buildSkillsTree(
			{ skill: "acme-wide", root: "workspace", commit: "c".repeat(40) },
			mainData({ name: "acme-wide", commit: { sha: "c".repeat(40), files: capped } }),
			EMPTY_FORM,
			{ writable: true, historyAvailable: true, selectedExists: true },
		);
		expect(blocksOfType(tree, "diff")).toHaveLength(capped.length - 1);
		const notes = blocksOfType(tree, "markdown");
		expect(notes.some((block) => typeof block.text === "string" && block.text.includes("diff truncated"))).toBe(true);
		expect(blockCount(tree)).toBeLessThan(2000);
	});

	test("a small commit embeds every file (no marker); a single oversize file always embeds", () => {
		const small = [
			{ path: "a/SKILL.md", before: "x", after: "y" },
			{ path: "a/notes.md", before: "", after: "n" },
		];
		expect(capCommitFiles(small).map((file) => file.path)).toEqual(["a/SKILL.md", "a/notes.md"]);
		// One file over the whole budget on its own: it still embeds (the
		// per-file 64 KiB side caps bound it) — the budget is BETWEEN files.
		const solo = [{ path: "big/SKILL.md", before: "b".repeat(600 * 1024), after: "" }];
		expect(capCommitFiles(solo)).toHaveLength(1);
		expect(capCommitFiles(solo)[0]?.elided).toBeUndefined();
	});
});

describe("the 3000-commit guard (view limits: < 2000 blocks, < 4 MiB data)", () => {
	test("the tree stays bounded however deep the history", () => {
		// A 3000-commit history pages at 25 — the data document carries
		// one page, never the whole log.
		const commits = Array.from({ length: 3000 }, (_, index) =>
			commitOf(`${String(index).padStart(40, "0")}`),
		);
		const page = historyPage(commits);
		expect(page.items).toHaveLength(SKILLS_HISTORY_PAGE_SIZE);
		const data = {
			skills: sidebarRows(
				Array.from({ length: 40 }, (_, index) =>
					skillRow({ name: `acme-skill-${index}`, description: "x".repeat(80) }),
				),
			),
			main: mainData({
				history: { available: true, reason: null, items: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor },
				supportFiles: Array.from({ length: 30 }, (_, index) => `references/file-${index}.md`),
				body: "body ".repeat(2000),
			}),
			form: EMPTY_FORM,
		};
		const tree = buildSkillsTree(
			{ skill: "acme-deploy", root: "workspace" },
			mainData(),
			EMPTY_FORM,
			{ writable: true, historyAvailable: true, selectedExists: true },
		);
		expect(blockCount(tree)).toBeLessThan(2000);
		expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBeLessThan(4 * 1024 * 1024);
	});
});

describe("params + instance key", () => {
	test("skillsParamsOf keeps the typed fields; bad types drop", () => {
		expect(skillsParamsOf({ skill: "acme-deploy", root: "package", pkg: "acme-ext", commit: "abc", cursor: "def", edit: true })).toEqual({
			skill: "acme-deploy",
			root: "package",
			pkg: "acme-ext",
			commit: "abc",
			cursor: "def",
			edit: true,
		});
		expect(skillsParamsOf({ skill: "", root: "nope", edit: "yes", commit: 3 })).toEqual({});
		expect(skillsInstanceKey({ skill: "acme-deploy" }, { user: "alice", admin: false, service: false, method: "token" })).toBe(
			'["alice",{"skill":"acme-deploy"}]',
		);
		expect(skillsInstanceKey({}, { user: undefined, admin: false, service: false, method: "none" })).toBe('["",{}]');
	});
});
