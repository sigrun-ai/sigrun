import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { curationDir, learnedSkillsDir } from "./paths.js";
import { validSkillName } from "./names.js";
import { scanContent } from "./scan.js";

export type Actor = "curator" | "agent" | "user";
export type ChangeAction = "create" | "patch" | "write_file" | "remove_file" | "archive" | "restore" | "overlay" | "pin" | "unpin" | "undo";

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
}

interface State { pins: Record<string, boolean>; archived: string[]; createdAt: Record<string, string>; }
interface ChangeMeta { actor: Actor; reviewId?: string; conversationId?: number; reason?: string; }

const VERSIONS = 10;
const FEED_ENTRIES = 500;
const SUPPORT_ROOTS = ["references", "templates", "scripts", "assets"];
const locks = new Map<string, Promise<void>>();

async function withUserLock<T>(user: string, fn: () => Promise<T>): Promise<T> {
	const previous = locks.get(user) ?? Promise.resolve();
	const current = previous.then(fn, fn);
	const tail = current.then(() => undefined, () => undefined);
	locks.set(user, tail);
	try { return await current; }
	finally { if (locks.get(user) === tail) locks.delete(user); }
}

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

async function copyTree(source: string, target: string): Promise<void> {
	const info = await lstat(source);
	if (info.isSymbolicLink()) throw new Error(`symlinks are not allowed: ${source}`);
	if (info.isDirectory()) {
		await mkdir(target, { recursive: true });
		for (const entry of await readdir(source)) await copyTree(join(source, entry), join(target, entry));
	} else if (info.isFile()) {
		await cp(source, target);
	} else throw new Error(`unsupported file type: ${source}`);
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

async function readFeed(dir: string): Promise<FeedEntry[]> {
	try {
		const text = await readFile(join(dir, "feed.jsonl"), "utf8");
		return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as FeedEntry).reverse();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function nextVersion(dir: string, name: string): Promise<string> {
	const root = join(dir, "versions", name);
	let entries: string[] = [];
	try { entries = await readdir(root); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const highest = entries.reduce((max, entry) => Math.max(max, /^v(\d+)$/.exec(entry)?.[1] === undefined ? 0 : Number(/^v(\d+)$/.exec(entry)![1])), 0);
	return `v${highest + 1}`;
}

async function versionLocation(version: string): Promise<"skills" | "archive" | undefined> {
	try { return (await readFile(join(version, ".location"), "utf8")).trim() === "archive" ? "archive" : "skills"; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
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

	async list(): Promise<readonly LearnedSkillInfo[]> {
		requireUser(this.options);
		const state = await readState(this.root);
		const names = new Set<string>();
		for (const root of [this.skills, join(this.root, "archive")]) {
			try {
				for (const entry of await readdir(root, { withFileTypes: true })) {
					if (entry.isDirectory() && validSkillName(entry.name)) names.add(entry.name);
				}
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		const result: LearnedSkillInfo[] = [];
		for (const name of [...names].sort()) {
			const archived = state.archived.includes(name);
			const path = join(archived ? join(this.root, "archive") : this.skills, name, "SKILL.md");
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
		return withUserLock(this.options.user, async () => {
			requireUser(this.options);
			skillName(name);
			const state = await readState(this.root);
			const archived = state.archived.includes(name);
			const root = join(archived ? this.archive : this.skills, name);
			if (change.kind === "create") {
				if (await exists(root)) throw new Error(`skill already exists: ${name}`);
				const taken = await this.options.nameTakenElsewhere(name);
				if (taken !== undefined) throw new Error(`skill name ${name} is already used by ${taken}; use overlay instead`);
				checkContent(change.content);
				if (frontmatter(change.content).name !== name) throw new Error(`frontmatter name must match the directory ${name}`);
				await mkdir(root, { recursive: true });
				await writeFile(join(root, "SKILL.md"), change.content);
				state.createdAt[name] = this.options.now().toISOString();
				return this.commit(name, "create", meta, state, undefined, root);
			}
			if (!(await exists(root))) throw new Error(`unknown skill: ${name}`);
			if (change.kind === "archive") {
				if (archived) throw new Error(`skill is archived: ${name}`);
				return this.commit(name, "archive", meta, state, root, join(this.root, "archive", name), change.absorbedInto);
			}
			if (change.kind === "restore") {
				if (!archived) throw new Error(`skill is not archived: ${name}`);
				const version = change.version === undefined ? undefined : join(this.root, "versions", name, change.version);
				if (version !== undefined && !(await exists(version))) throw new Error(`unknown version: ${change.version}`);
				return this.commit(name, "restore", meta, state, root, join(this.skills, name), undefined, version);
			}
			if (archived) throw new Error(`skill is archived: ${name}`);
			if (change.kind !== "patch" && change.kind !== "write_file" && change.kind !== "remove_file") throw new Error("unsupported skill change");
			return this.commit(name, change.kind, meta, state, root, root, undefined, undefined, async () => {
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
			});
		});
	}

	async pin(name: string, pinned: boolean): Promise<void> {
		requireUser(this.options);
		await withUserLock(this.options.user, async () => {
			requireUser(this.options);
			skillName(name);
			const state = await readState(this.root);
			if (!(await this.list()).some((skill) => skill.name === name)) throw new Error(`unknown skill: ${name}`);
			state.pins[name] = pinned;
			await writeState(this.root, state);
			await this.appendFeed({ id: randomUUID(), at: this.options.now().toISOString(), actor: "user", action: pinned ? "pin" : "unpin", skill: name });
		});
	}

	async feed(limit: number, before?: string): Promise<readonly FeedEntry[]> {
		requireUser(this.options);
		const entries = await readFeed(this.root);
		const start = before === undefined ? 0 : entries.findIndex((entry) => entry.id === before);
		if (start < 0) return [];
		return entries.slice(start + (before === undefined ? 0 : 1), start + (before === undefined ? 0 : 1) + Math.max(0, limit));
	}

	async undo(entryIds: readonly string[]): Promise<readonly FeedEntry[]> {
		requireUser(this.options);
		return withUserLock(this.options.user, async () => {
			requireUser(this.options);
			const all = await readFeed(this.root);
			const selected = all.filter((entry) => entryIds.includes(entry.id) && entry.before !== undefined);
			const earliest = new Map<string, FeedEntry>();
			for (const entry of selected) {
				const previous = earliest.get(entry.skill);
				if (previous === undefined || all.indexOf(entry) > all.indexOf(previous)) earliest.set(entry.skill, entry);
			}
			const result: FeedEntry[] = [];
			const state = await readState(this.root);
			for (const entry of earliest.values()) {
				const current = join(state.archived.includes(entry.skill) ? this.archive : this.skills, entry.skill);
				const previous = join(this.root, "versions", entry.skill, entry.before!);
				if (!(await exists(previous)) || !(await exists(current))) continue;
				const location = await versionLocation(previous);
				if (location === undefined) throw new Error(`unknown version location: ${entry.before}`);
				const destination = join(location === "archive" ? this.archive : this.skills, entry.skill);
				const next = await this.commit(entry.skill, "undo", { actor: "user" }, state, current, destination, undefined, previous);
				result.push(next);
			}
			return result;
		});
	}

	/**
	 * Append one feed entry verbatim — the A5 overlay seam. OverlayStore
	 * owns its files but records every change in the SAME per-user feed
	 * (action `"overlay"`), so retention, the per-user lock and the P8
	 * view hold for overlay changes too. Entry ids/at values are the
	 * caller's.
	 */
	async appendFeedEntry(entry: FeedEntry): Promise<void> {
		requireUser(this.options);
		await withUserLock(this.options.user, async () => {
			requireUser(this.options);
			await this.appendFeed(entry);
		});
	}

	/**
	 * Persists a change: snapshots the before state, applies the mutation,
	 * snapshots the after state, records the feed entry and runs retention.
	 * Every version directory carries a `.location` file recording where its
	 * content lived (skills or archive) when the snapshot was taken, so undo
	 * can pick the right destination and retention removes the metadata with
	 * the snapshot it belongs to.
	 */
	private async commit(name: string, action: ChangeAction, meta: ChangeMeta, state: State, beforeRoot?: string, afterRoot?: string, absorbedInto?: string, restoreFrom?: string, mutate?: () => Promise<void>): Promise<FeedEntry> {
		const versionRoot = join(this.root, "versions", name);
		let before: string | undefined;
		if (beforeRoot !== undefined && await exists(beforeRoot)) {
			before = await nextVersion(this.root, name);
			await copyTree(beforeRoot, join(versionRoot, before));
			await writeFile(join(versionRoot, before, ".location"), beforeRoot.startsWith(this.archive + "/") ? "archive" : "skills");
		}
		if (mutate !== undefined) await mutate();
		if (action === "archive") {
			await mkdir(this.archive, { recursive: true });
			await rename(beforeRoot!, afterRoot!);
			state.archived = [...new Set([...state.archived, name])];
		} else if (action === "restore") {
			await mkdir(this.skills, { recursive: true });
			if (restoreFrom === undefined) {
				await rename(beforeRoot!, afterRoot!);
			} else {
				const staged = await this.stageVersion(restoreFrom);
				await rm(beforeRoot!, { recursive: true, force: true });
				await rename(staged, afterRoot!);
			}
			state.archived = state.archived.filter((item) => item !== name);
		} else if (action === "undo") {
			const staged = await this.stageVersion(restoreFrom!);
			await rm(beforeRoot!, { recursive: true, force: true });
			await mkdir(dirname(afterRoot!), { recursive: true });
			await rename(staged, afterRoot!);
			if (afterRoot!.startsWith(this.archive + "/")) state.archived = [...new Set([...state.archived, name])];
			else state.archived = state.archived.filter((item) => item !== name);
		}
		let after: string | undefined;
		if (action !== "archive") {
			after = await nextVersion(this.root, name);
			const current = afterRoot ?? beforeRoot!;
			await copyTree(current, join(versionRoot, after));
			await writeFile(join(versionRoot, after, ".location"), state.archived.includes(name) ? "archive" : "skills");
		}
		await writeState(this.root, state);
		const entry: FeedEntry = { id: randomUUID(), at: this.options.now().toISOString(), actor: meta.actor, action, skill: name, ...(absorbedInto === undefined && meta.reason === undefined ? {} : { reason: absorbedInto ?? meta.reason }), ...(meta.reviewId === undefined ? {} : { reviewId: meta.reviewId }), ...(meta.conversationId === undefined ? {} : { conversationId: meta.conversationId }), ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
		await this.appendFeed(entry);
		const versions = (await readdir(versionRoot)).filter((entry) => /^v\d+$/.test(entry)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
		for (const old of versions.slice(VERSIONS)) await rm(join(versionRoot, old), { recursive: true, force: true });
		return entry;
	}

	/** Copies a version snapshot to a staging directory, minus the `.location` metadata file. */
	private async stageVersion(version: string): Promise<string> {
		const staged = join(this.root, `.staged-${randomUUID()}`);
		await copyTree(version, staged);
		await rm(join(staged, ".location"), { force: true });
		return staged;
	}

	private async appendFeed(entry: FeedEntry): Promise<void> {
		await mkdir(this.root, { recursive: true });
		const entries = (await readFeed(this.root)).reverse();
		entries.push(entry);
		await writeFileAtomic(join(this.root, "feed.jsonl"), entries.slice(-FEED_ENTRIES).map((item) => JSON.stringify(item)).join("\n") + "\n");
	}
}
