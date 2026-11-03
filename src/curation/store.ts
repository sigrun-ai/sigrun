/**
 * SkillStore (tabs+skills plan, Task 9): the per-user learned-skill
 * store on git. Every mutation is one commit in the user's curation
 * repo (`userRepoSpec(userArea)`) with the Sigrun-* trailers; the feed
 * is the log (id/before/after are commit SHAs); undo is a path-restore
 * commit (never git revert).
 *
 * The store's public methods and FeedEntry shape are unchanged; the
 * versioning feed.jsonl and withUserLock machinery are gone (git is the
 * lock and the feed).
 */

import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GitHistory, HistoryActor, HistoryCommit } from "../history/git.js";
import { curationDir, learnedSkillsDir, userRepoSpec } from "./paths.js";
import { validSkillName } from "./names.js";
import { scanContent } from "./scan.js";

export type Actor = "curator" | "agent" | "user" | "outside";
export type ChangeAction = "create" | "patch" | "write_file" | "remove_file" | "archive" | "restore" | "overlay" | "pin" | "unpin" | "undo" | "change";

export interface FeedEntry {
	id: string;
	at: string;
	actor: Actor;
	action: ChangeAction;
	skill: string;
	reason?: string;
	reviewId?: string;
	conversationId?: number;
	before?: string;
	after?: string;
}

export type SkillChange =
	| { kind: "create"; content: string }
	| { kind: "patch"; old: string; new: string; file?: string }
	| { kind: "write_file"; file: string; content: string }
	| { kind: "remove_file"; file: string }
	| { kind: "archive"; absorbedInto?: string }
	| { kind: "restore"; version?: string };

export interface LearnedSkillInfo {
	name: string;
	description: string;
	archived: boolean;
	pinned: boolean;
	bytes: number;
	createdAt: string;
}

export interface SkillStoreOptions {
	userArea: string;
	user: string;
	now: () => Date;
	nameTakenElsewhere: (name: string) => Promise<string | undefined>;
	userExists: () => boolean;
	/** The user's curation history repo (boot builds and caches it). */
	history: GitHistory;
	/**
	 * The user's pending migration (boot's curationOf): a mutating op
	 * awaits it so its commit lands AFTER the import — never swallowed
	 * by the migration's discard (review I3). Defaults to no-op.
	 */
	ready?: () => Promise<void>;
}

interface State { pins: Record<string, boolean>; archived: string[]; createdAt: Record<string, string>; }
interface ChangeMeta { actor: Actor; reviewId?: string; conversationId?: number; reason?: string; }

const SUPPORT_ROOTS = ["references", "templates", "scripts", "assets"];

function requireUser(options: SkillStoreOptions): void {
	if (!options.userExists()) throw new Error("user removed");
}

function skillName(name: string): void {
	if (!validSkillName(name)) throw new Error(`invalid skill name: ${name}`);
}

function supportFile(file: string): string {
	if (file.includes("\\") || file.startsWith("/") || file.includes("\0")) {
		throw new Error("support file must be a relative path");
	}
	const parts = file.split("/");
	if (parts.length < 2 || !SUPPORT_ROOTS.includes(parts[0]) || parts.some((part) => part === "" || part === "." || part === "..")) {
		throw new Error("support file must be under references/, templates/, scripts/ or assets/");
	}
	return join(...parts);
}

function frontmatter(text: string): { name: string; description: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (match === null) throw new Error("SKILL.md frontmatter is required");
	const fields: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (field !== null) fields[field[1]] = field[2].trim().replace(/^(["'])(.*)\1$/, "$2");
	}
	if (!fields.name) throw new Error("SKILL.md frontmatter name is required");
	if (!fields.description) throw new Error("SKILL.md frontmatter description is required");
	return { name: fields.name, description: fields.description };
}

function checkContent(text: string): void {
	const result = scanContent(text);
	if (!result.ok) throw new Error(`content scan refused line ${result.line}: ${result.rule}`);
}

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function assertNoSymlinks(root: string, file: string): Promise<void> {
	const parts = file.split("/");
	let path = root;
	for (const part of parts) {
		path = join(path, part);
		try {
			if ((await lstat(path)).isSymbolicLink()) throw new Error("symlinks are not allowed in skill files");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

async function readState(dir: string): Promise<State> {
	try {
		const value = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as Partial<State>;
		return { pins: value.pins ?? {}, archived: value.archived ?? [], createdAt: value.createdAt ?? {} };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pins: {}, archived: [], createdAt: {} };
		throw error;
	}
}

async function writeState(dir: string, state: State): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFileAtomic(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

async function writeFileAtomic(path: string, text: string): Promise<void> {
	const temp = `${path}.${randomUUID()}.tmp`;
	await writeFile(temp, text);
	await rename(temp, path);
}

/** The Sigrun actor shape the store's FeedEntry carries. */
function actorOf(meta: ChangeMeta, user: string): HistoryActor {
	switch (meta.actor) {
		case "user": return { kind: "user", user };
		case "curator": return { kind: "curator" };
		case "agent": return { kind: "agent" };
		case "outside": return { kind: "outside" };
	}
}

/** Map one history commit to a feed entry; untrailered commits get action "change", skill "". */
function entryOf(commit: HistoryCommit, user: string): FeedEntry {
	const actor: Actor =
		commit.actor.kind === "user"
			? (commit.actor.user === user ? "user" : "outside")
			: commit.actor.kind;
	const action = (commit.action ?? "change") as ChangeAction;
	const skill = commit.skill ?? "";
	return {
		id: commit.sha,
		at: commit.at,
		actor,
		action,
		skill,
		...(commit.reason === undefined ? {} : { reason: commit.reason }),
		...(commit.reviewId === undefined ? {} : { reviewId: commit.reviewId }),
		...(commit.conversationId === undefined ? {} : { conversationId: commit.conversationId }),
	};
}

export class SkillStore {
	private readonly options: SkillStoreOptions;
	private readonly root: string;
	private readonly skills: string;
	private readonly archive: string;

	constructor(options: SkillStoreOptions) {
		this.options = options;
		this.root = curationDir(options.userArea);
		this.skills = learnedSkillsDir(options.userArea);
		this.archive = join(this.root, "archive");
	}

	private get history(): GitHistory {
		return this.options.history;
	}

	async list(): Promise<readonly LearnedSkillInfo[]> {
		requireUser(this.options);
		const state = await readState(this.root);
		const names = new Set<string>();
		for (const root of [this.skills, this.archive]) {
			try {
				for (const entry of await readdir(root, { withFileTypes: true })) {
					if (entry.isDirectory() && validSkillName(entry.name)) names.add(entry.name);
				}
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		const result: LearnedSkillInfo[] = [];
		for (const name of [...names].sort()) {
			const archived = state.archived.includes(name);
			const path = join(archived ? this.archive : this.skills, name, "SKILL.md");
			try {
				const text = await readFile(path, "utf8");
				const meta = frontmatter(text);
				result.push({ name, description: meta.description, archived, pinned: state.pins[name] === true, bytes: Buffer.byteLength(text), createdAt: state.createdAt[name] ?? (await stat(path)).birthtime.toISOString() });
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		return result;
	}

	async view(name: string, file = "SKILL.md"): Promise<string> {
		requireUser(this.options);
		skillName(name);
		const path = file === "SKILL.md" ? file : supportFile(file);
		await assertNoSymlinks(join(this.skills, name), path);
		return readFile(join(this.skills, name, path), "utf8");
	}

	async apply(name: string, change: SkillChange, meta: ChangeMeta): Promise<FeedEntry> {
		requireUser(this.options);
		await this.options.ready?.();
		skillName(name);
		// The mutation's validations run BEFORE the history write: a thrown
		// validation must not become a commit (the fail-soft rule is for git
		// failures, not store rejections).
		const state = await readState(this.root);
		const archived = state.archived.includes(name);
		const root = join(archived ? this.archive : this.skills, name);
		if (change.kind === "create") {
			if (await exists(root)) throw new Error(`skill already exists: ${name}`);
			const taken = await this.options.nameTakenElsewhere(name);
			if (taken !== undefined) throw new Error(`skill name ${name} is already used by ${taken}; use overlay instead`);
			checkContent(change.content);
			if (frontmatter(change.content).name !== name) throw new Error(`frontmatter name must match the directory ${name}`);
		} else {
			if (!(await exists(root))) throw new Error(`unknown skill: ${name}`);
			if (change.kind === "archive" && archived) throw new Error(`skill is archived: ${name}`);
			if (change.kind === "restore" && !archived) throw new Error(`skill is not archived: ${name}`);
			if (change.kind !== "archive" && change.kind !== "restore") {
				if (archived) throw new Error(`skill is archived: ${name}`);
				if (change.kind !== "patch" && change.kind !== "write_file" && change.kind !== "remove_file") {
					throw new Error("unsupported skill change");
				}
			}
		}
		const before = await this.headSha();
		// The repo's work tree must exist before the git dir can init
		// inside it (mkdir the root, never the work tree itself).
		await mkdir(this.root, { recursive: true });
		const sha = await this.history.write(
			{
				actor: actorOf(meta, this.options.user),
				summary: `${change.kind} ${name}`,
				action: change.kind,
				skill: name,
				...(meta.reviewId === undefined ? {} : { reviewId: meta.reviewId }),
				...(meta.conversationId === undefined ? {} : { conversationId: meta.conversationId }),
				...(meta.reason === undefined && !(change.kind === "archive" && change.absorbedInto !== undefined)
					? {}
					: { reason: change.kind === "archive" && change.absorbedInto !== undefined ? change.absorbedInto : meta.reason! }),
			},
			async () => {
				requireUser(this.options);
				await this.mutate(name, change);
			},
			{ kind: "outside" },
		);
		return this.entry(
			sha,
			change.kind,
			name,
			meta,
			before,
			change.kind === "archive" ? change.absorbedInto : undefined,
		);
	}

	async pin(name: string, pinned: boolean, reviewId?: string): Promise<FeedEntry> {
		requireUser(this.options);
		await this.options.ready?.();
		skillName(name);
		if (!(await this.list()).some((skill) => skill.name === name)) throw new Error(`unknown skill: ${name}`);
		const before = await this.headSha();
		const action = pinned ? "pin" : "unpin";
		const sha = await this.history.write(
			{
				actor: { kind: "user", user: this.options.user },
				summary: `${action} ${name}`,
				action,
				skill: name,
				...(reviewId === undefined ? {} : { reviewId }),
			},
			async () => {
				requireUser(this.options);
				const state = await readState(this.root);
				state.pins[name] = pinned;
				await writeState(this.root, state);
			},
			{ kind: "outside" },
		);
		return this.entry(sha, action, name, { actor: "user", reviewId }, before);
	}

	async feed(limit: number, before?: string): Promise<readonly FeedEntry[]> {
		requireUser(this.options);
		// Over-fetch: feed skips untrailered commits (catch-ups, the
		// import), so a page may hold fewer than limit entries.
		const commits = await this.history.log({ limit: limit * 4, ...(before === undefined ? {} : { before }) });
		const entries: FeedEntry[] = [];
		for (const commit of commits) {
			if (commit.action === undefined && commit.skill === undefined) continue;
			const entry = entryOf(commit, this.options.user);
			const parent = await this.history.parentOf(commit.sha);
			entries.push({
				...entry,
				...(parent === undefined ? {} : { before: parent }),
				after: commit.sha,
			});
			if (entries.length >= limit) break;
		}
		return entries;
	}

	async undo(entryIds: readonly string[]): Promise<readonly FeedEntry[]> {
		requireUser(this.options);
		await this.options.ready?.();
		// The selected commits, oldest first (the restore target is the
		// earliest one's parent).
		const log = await this.history.log({ limit: 1000 });
		// The selected commits, OLDEST first (the restore target is the
		// earliest one's parent): the log is newest-first.
		const selected = log
			.filter((commit) => entryIds.includes(commit.sha))
			.reverse();
		if (selected.length === 0) return [];
		// Already undone: a commit whose Sigrun-Undoes names a selected
		// commit's sha. (The earlier reviewId comparison was dead code:
		// undoes carry SHAs, never reviewIds.)
		const selectedShas = new Set(selected.map((commit) => commit.sha));
		const already = log.some(
			(commit) =>
				commit.undoes !== undefined &&
				commit.undoes.split(",").map((part) => part.trim()).some((sha) => selectedShas.has(sha)),
		);
		if (already) return [];
		const reviewIds = new Set(
			selected.map((commit) => commit.reviewId).filter((id): id is string => id !== undefined),
		);
		const createOnly: HistoryCommit[] = [];
		const restorable: HistoryCommit[] = [];
		for (const commit of selected) {
			// An undo-of-create ARCHIVED the skill: the redo must restore
			// those paths too, so an undo commit whose undoes point at a
			// create is restorable, not create-only.
			if (commit.action === "create" && commit.skill !== undefined) createOnly.push(commit);
			else restorable.push(commit);
		}
		// Oldest first → the earliest selected commit is FIRST.
		const earliest = restorable[0];
		// The restore is scoped to the SELECTED commits' skills: for each
		// skill, both of its homes (skills/ AND curation/archive/ — a state
		// move only ever names one side in a commit's path list), plus
		// curation/state.json only when a selected commit touched it.
		// Non-selected state under the roots is never reverted.
		const selectedSkills = new Set(
			selected.map((commit) => commit.skill).filter((name): name is string => name !== undefined && name !== ""),
		);
		const paths: string[] = [];
		for (const name of selectedSkills) {
			paths.push(`skills/${name}`, `curation/archive/${name}`);
		}
		if (selected.some((commit) => commit.paths.includes("curation/state.json"))) {
			paths.push("curation/state.json");
		}
		const undoes = selected.map((commit) => commit.sha).sort().join(",");
		const reviewId = [...reviewIds].sort().join(",");
		const skill = earliest?.skill ?? selected[0]!.skill ?? "";
		const before = await this.headSha();
		// The restore target: the earliest selected commit's PARENT's tree,
		// restricted to the touched paths. Computed OUTSIDE the write's lock
		// (pure git reads), applied inside it.
		const parent = restorable.length > 0 && earliest !== undefined
			? await this.history.parentOf(earliest.sha)
			: undefined;
		const atParent: Map<string, Buffer> = new Map();
		if (restorable.length > 0 && parent !== undefined) {
			for (const path of await this.lsTree(parent, paths)) {
				atParent.set(path, await this.catFile(parent, path));
			}
		}
		await mkdir(this.root, { recursive: true });
		const sha = await this.history.write(
			{
				actor: { kind: "user", user: this.options.user },
				summary: `undo ${skill}`.trim(),
				action: "undo",
				skill,
				...(reviewId === "" ? {} : { reviewId }),
				undoes,
			},
			async () => {
				requireUser(this.options);
				if (restorable.length > 0) {
					await this.restorePaths(atParent, paths);
				}
				if (createOnly.length > 0) {
					const state = await readState(this.root);
					for (const commit of createOnly) {
						const name = commit.skill!;
						if (state.archived.includes(name)) continue;
						const from = join(this.skills, name);
						if (!(await exists(from))) continue;
						await mkdir(this.archive, { recursive: true });
						await renameForce(from, join(this.archive, name));
						state.archived = [...new Set([...state.archived, name])];
					}
					await writeState(this.root, state);
				}
			},
			{ kind: "outside" },
		);
		if (sha === undefined) return [];
		// One FeedEntry per skill touched, all carrying the undo commit's sha.
		const skills = [...new Set(selected.map((commit) => commit.skill ?? ""))];
		return skills.map((one) =>
			this.entry(sha, "undo", one, { actor: "user", ...(reviewId === "" ? {} : { reviewId }) }, before),
		);
	}

	/** Restore a learned skill's files AND its state.json archived/pin entries to `sha`, in one commit. Restoring a version of an archived skill un-archives it. */
	async restoreVersion(name: string, sha: string, meta: ChangeMeta): Promise<FeedEntry> {
		requireUser(this.options);
		await this.options.ready?.();
		skillName(name);
		const before = await this.headSha();
		// The skill's own dirs plus state.json: the restore puts the files
		// back where they were at sha (skills/ when live, archive/ when
		// archived) and state.json carries the archived/pin rows.
		const paths = [`skills/${name}`, `curation/archive/${name}`, "curation/state.json"];
		// The snapshot is computed BEFORE the write (the write's own
		// staging moves HEAD; reading "the tree at sha" inside the mutate
		// would follow it).
		const snapshot: Map<string, Buffer> = new Map();
		for (const path of await this.lsTree(sha, paths)) {
			snapshot.set(path, await this.catFile(sha, path));
		}
		await mkdir(this.root, { recursive: true });
		const undoSha = await this.history.write(
			{
				actor: actorOf(meta, this.options.user),
				summary: `restore ${name}@${sha.slice(0, 8)}`,
				action: "restore",
				skill: name,
				...(meta.reviewId === undefined ? {} : { reviewId: meta.reviewId }),
				...(meta.conversationId === undefined ? {} : { conversationId: meta.conversationId }),
				...(meta.reason === undefined ? {} : { reason: meta.reason }),
			},
			async () => {
				requireUser(this.options);
				await this.restorePaths(snapshot, paths);
			},
			{ kind: "outside" },
		);
		return this.entry(undoSha, "restore", name, meta, before);
	}

	// ---- internals ------------------------------------------------------

	/**
	 * Inside a history write: make `paths` exactly as the snapshot
	 * (path → content at the target commit). Removes every tracked path
	 * under `paths` absent from the snapshot, writes the rest. Deepest
	 * first so a moved-away directory's old path never shadows the
	 * restore of its new location.
	 */
	private async restorePaths(
		snapshot: ReadonlyMap<string, Buffer>,
		paths: readonly string[],
	): Promise<void> {
		const head = new Set(await this.lsTree("HEAD", paths));
		const remove = [...head].filter(
			(path) => !snapshot.has(path) && paths.some((entry) => path === entry || path.startsWith(`${entry}/`)),
		);
		for (const path of remove.sort((a, b) => b.length - a.length)) {
			await rm(join(this.options.userArea, path), { recursive: true, force: true });
		}
		for (const [path, content] of snapshot) {
			const target = join(this.options.userArea, path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content);
		}
	}

	/** git ls-tree -r --name-only <tree> -- <paths>, via the history's own git. */
	private async lsTree(tree: string, paths: readonly string[]): Promise<string[]> {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const spec = userRepoSpec(this.options.userArea);
		const { stdout } = await promisify(execFile)(
			"git",
			[`--git-dir=${spec.gitDir}`, `--work-tree=${spec.workTree}`, "-c", `safe.directory=${spec.workTree}`, "ls-tree", "-r", "--name-only", tree, "--", ...paths],
			{ env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
		);
		return stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	}

	/** git cat-file blob <sha>:<path>, via the history's own git. */
	private async catFile(sha: string, path: string): Promise<Buffer> {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const spec = userRepoSpec(this.options.userArea);
		const { stdout } = await promisify(execFile)(
			"git",
			[`--git-dir=${spec.gitDir}`, `--work-tree=${spec.workTree}`, "-c", `safe.directory=${spec.workTree}`, "cat-file", "blob", `${sha}:${path}`],
			{ env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "buffer" },
		);
		return stdout;
	}

	// ---- internals ------------------------------------------------------

	private async mutate(name: string, change: SkillChange): Promise<void> {
		// Validations already ran in apply(); this replays the decision tree
		// against the (possibly catch-up-shifted) on-disk state.
		const state = await readState(this.root);
		const archived = state.archived.includes(name);
		const root = join(archived ? this.archive : this.skills, name);
		if (change.kind === "create") {
			// Re-validate against the post-catch-up state: two concurrent
			// same-name creates both pass the pre-write check; the second
			// must not clobber the first.
			if (await exists(root)) throw new Error(`skill already exists: ${name}`);
			await mkdir(root, { recursive: true });
			await writeFile(join(root, "SKILL.md"), change.content);
			state.createdAt[name] = this.options.now().toISOString();
			await writeState(this.root, state);
			return;
		}
		if (change.kind === "archive") {
			await mkdir(this.archive, { recursive: true });
			await renameForce(root, join(this.archive, name));
			state.archived = [...new Set([...state.archived, name])];
			await writeState(this.root, state);
			return;
		}
		if (change.kind === "restore") {
			await mkdir(this.skills, { recursive: true });
			await renameForce(root, join(this.skills, name));
			state.archived = state.archived.filter((item) => item !== name);
			await writeState(this.root, state);
			return;
		}
		if (change.kind === "patch") {
			const file = change.file === undefined ? "SKILL.md" : supportFile(change.file);
			await assertNoSymlinks(root, file);
			const oldText = await readFile(join(root, file), "utf8");
			const first = oldText.indexOf(change.old);
			if (first < 0 || oldText.indexOf(change.old, first + 1) >= 0 || change.old === "") throw new Error("patch old text must be a unique span");
			const text = oldText.slice(0, first) + change.new + oldText.slice(first + change.old.length);
			checkContent(text);
			if (file === "SKILL.md" && frontmatter(text).name !== name) throw new Error(`frontmatter name must match the directory ${name}`);
			await writeFile(join(root, file), text);
		} else if (change.kind === "write_file") {
			const file = supportFile(change.file);
			await assertNoSymlinks(root, file);
			checkContent(change.content);
			await mkdir(join(root, file, ".."), { recursive: true });
			await writeFile(join(root, file), change.content);
		} else {
			const file = supportFile(change.file);
			await assertNoSymlinks(root, file);
			await rm(join(root, file));
		}
	}

	/** Build the returned FeedEntry: sha-backed, with before/after. */
	private entry(
		sha: string | undefined,
		action: ChangeAction,
		skill: string,
		meta: ChangeMeta,
		before: string | undefined,
		absorbedInto?: string,
	): FeedEntry {
		const id = sha ?? `(no-commit-${randomUUID()})`;
		const reason = absorbedInto ?? meta.reason;
		return {
			id,
			// The write clock: feed() serves the commit's authored-at on
			// read-back; the returned entry carries the write's own time.
			at: this.options.now().toISOString(),
			actor: meta.actor,
			action,
			skill,
			...(reason === undefined ? {} : { reason }),
			...(meta.reviewId === undefined ? {} : { reviewId: meta.reviewId }),
			...(meta.conversationId === undefined ? {} : { conversationId: meta.conversationId }),
			...(before === undefined ? {} : { before }),
			...(sha === undefined ? {} : { after: sha }),
		};
	}

	/** HEAD's sha, or undefined on an empty/failed repo. */
	private async headSha(): Promise<string | undefined> {
		const log = await this.history.log({ limit: 1 });
		return log[0]?.sha;
	}
}

/** rename(2) with the destination's parent ensured. */
async function renameForce(from: string, to: string): Promise<void> {
	await mkdir(dirname(to), { recursive: true });
	await rename(from, to);
}
