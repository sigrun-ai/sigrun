/**
 * Overlays (curator P2 part 2, spec §6.2): a per-user addendum attached
 * to a skill the user does NOT own — a workspace, user-dir or package
 * skill. The upstream keeps flowing (updates, reinstalls); the overlay
 * rides on top: `load_skill` and `/skill:name` serve the upstream body
 * followed by the overlay text under {@link OVERLAY_HEADING}, and the
 * skills section lists the skill once, unchanged.
 *
 * Keying: root kind + skill name, plus the canonical workspace path for
 * workspace skills (two workspaces can each own a skill of the same
 * name). An overlay NEVER applies to a learned skill — the user owns
 * that copy outright, so the store is the right tool (put throws).
 *
 * Storage: `curationDir/overlays/<root>/<sha256-of-key>.json`, one file
 * per overlay (`Overlay` verbatim). A vanished upstream stops serving
 * but the overlay is KEPT, marked `orphanedSince` by
 * {@link OverlayStore.markOrphans} (present again clears the mark), and
 * removable.
 *
 * Every overlay change commits to the user's curation history repo
 * (tabs+skills Task 9): one commit per put/remove with the Sigrun-*
 * trailers, so overlay changes appear in the same feed as learned-skill
 * changes. `OverlayStore` owns the files.
 */

import { randomUUID, createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { GitHistory } from "../history/git.js";
import { curationDir, learnedSkillsDir } from "./paths.js";
import { validSkillName } from "./names.js";
import type { Actor, FeedEntry } from "./store.js";
import type { SkillsOptions } from "../skills/index.js";
import type { HistoryActor } from "../history/git.js";

/** The Sigrun actor shape for a history commit. */
function historyActor(actor: Actor, user: string): HistoryActor {
	switch (actor) {
		case "user": return { kind: "user", user };
		case "curator": return { kind: "curator" };
		case "agent": return { kind: "agent" };
		case "outside": return { kind: "outside" };
	}
}

/**
 * The heading the served overlay follows: upstream body, then this
 * heading, then the overlay text (one blank line each side of the
 * heading).
 */
export const OVERLAY_HEADING = "## Your notes for this skill";

/** The roots an overlay can attach to (never `"learned"`). */
type OverlayRoot = "workspace" | "user dir" | "package";

/** Identifies one upstream skill for one user: root kind + name (+ workspace). */
export type OverlayKey = {
	readonly root: OverlayRoot;
	readonly skill: string;
	/**
	 * The canonical workspace path — the workspace root the skill was
	 * discovered under. Required (and the only place it is meaningful)
	 * for `root: "workspace"`.
	 */
	readonly workspace?: string;
};

/** One stored overlay: the addendum text and the upstream it was written against. */
export interface Overlay {
	readonly key: OverlayKey;
	readonly text: string;
	/** sha256 of the upstream SKILL.md bytes the text was written against (drift detection). */
	readonly upstreamHash: string;
	/** Set by `markOrphans` when the upstream is absent; cleared when it returns. */
	readonly orphanedSince?: string;
}

/** The actor-side metadata an overlay change records in the feed. */
export interface OverlayMeta {
	readonly actor: Actor;
	readonly reason?: string;
	readonly reviewId?: string;
	readonly conversationId?: number;
}

/** What `OverlayStore` needs: the user's area and the user's history repo. */
export interface OverlayStoreOptions {
	/** The owner's user area: `<dataDir>/users/<user>`. */
	readonly userArea: string;
	readonly user: string;
	/** Checked before every operation; false → throws `user removed` (the A4 pattern). */
	readonly userExists: () => boolean;
	/** The user's curation history repo — overlay changes commit here. */
	readonly history: GitHistory;
}

/** Directory label per root kind (no spaces in path segments). */
const ROOT_DIR: Record<OverlayRoot, string> = {
	"workspace": "workspace",
	"user dir": "user-dir",
	"package": "package",
};

const ROOT_ORDER: readonly OverlayRoot[] = ["workspace", "user dir", "package"];

/**
 * The canonical key encoding: stable field order, `workspace` omitted
 * for non-workspace keys. This is the input hashed into the file name —
 * never change it silently (a change orphans every stored overlay).
 */
function keyString(key: OverlayKey): string {
	return JSON.stringify({
		root: key.root,
		skill: key.skill,
		...(key.workspace === undefined ? {} : { workspace: key.workspace }),
	});
}

/** sha256 hex of the key encoding — the overlay's file name stem. */
function keyHash(key: OverlayKey): string {
	return createHash("sha256").update(keyString(key)).digest("hex");
}

/** Validate a key on every store operation: a valid name, and a workspace path exactly for workspace keys. */
function checkKey(key: OverlayKey): void {
	if (!validSkillName(key.skill)) throw new Error(`invalid skill name: ${key.skill}`);
	if (key.root === "workspace" && (key.workspace === undefined || key.workspace === "")) {
		throw new Error("a workspace overlay requires the workspace path");
	}
	if (key.root !== "workspace" && key.workspace !== undefined) {
		throw new Error("the workspace path is only valid for a workspace overlay");
	}
}

/** sha256 hex of the upstream SKILL.md bytes. */
export function hashSkill(body: string): string {
	return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * The served shape: the upstream body, then {@link OVERLAY_HEADING},
 * then the overlay text — one blank line each side of the heading.
 */
export function withOverlay(body: string, text: string): string {
	return `${body}\n${OVERLAY_HEADING}\n\n${text}`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function writeFileAtomic(path: string, text: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	const temp = `${path}.${randomUUID()}.tmp`;
	await writeFile(temp, text);
	await rename(temp, path);
}

/** The one on-disk record read back as an `Overlay`. */
interface OverlayFile extends Overlay {}

/**
 * The per-user overlay store: files under
 * `curationDir/overlays/<root>/<sha256-of-key>.json`, every change
 * recorded in the skill store's feed as an `"overlay"` entry.
 */
export class OverlayStore {
	private readonly options: OverlayStoreOptions;
	private readonly root: string;

	constructor(options: OverlayStoreOptions) {
		this.options = options;
		this.root = curationDir(options.userArea);
	}

	/** The one overlay for a key, `undefined` when none is stored. */
	async get(key: OverlayKey): Promise<Overlay | undefined> {
		this.requireUser();
		checkKey(key);
		return this.read(this.fileOf(key));
	}

	/**
	 * Create or replace the overlay for a key (the upstream hash pins
	 * what the text was written against; drift detection is the caller's
	 * job — `resolveUpstream` + `markOrphans`). Throws for a learned
	 * skill: the user owns that copy, so the store is the right tool.
	 * Returns the feed entry the change recorded.
	 */
	async put(key: OverlayKey, text: string, upstreamHash: string, meta: OverlayMeta): Promise<FeedEntry> {
		this.requireUser();
		checkKey(key);
		if (await exists(join(learnedSkillsDir(this.options.userArea), key.skill))) {
			throw new Error(`an overlay never applies to a learned skill: ${key.skill}`);
		}
		// The repo's work tree must exist before the git dir can init.
		await mkdir(curationDir(this.options.userArea), { recursive: true });
		const overlay: OverlayFile = { key, text, upstreamHash };
		const summary = `overlay ${key.root}:${key.skill}`;
		const sha = await this.options.history.write(
			{
				actor: historyActor(meta.actor, this.options.user),
				summary,
				action: "overlay",
				skill: key.skill,
				...(meta.reason === undefined ? {} : { reason: meta.reason }),
				...(meta.reviewId === undefined ? {} : { reviewId: meta.reviewId }),
				...(meta.conversationId === undefined ? {} : { conversationId: meta.conversationId }),
			},
			async () => {
				this.requireUser();
				await writeFileAtomic(this.fileOf(key), `${JSON.stringify(overlay, null, 2)}\n`);
			},
			{ kind: "outside" },
		);
		return this.entry(key, sha, meta, summary);
	}

	/** Remove the overlay for a key; returns the feed entry. Throws when none is stored. */
	async remove(key: OverlayKey, meta: OverlayMeta): Promise<FeedEntry> {
		this.requireUser();
		checkKey(key);
		const file = this.fileOf(key);
		if (!(await exists(file))) throw new Error(`unknown overlay: ${keyString(key)}`);
		await mkdir(curationDir(this.options.userArea), { recursive: true });
		const summary = `overlay ${key.root}:${key.skill}`;
		const sha = await this.options.history.write(
			{
				actor: historyActor(meta.actor, this.options.user),
				summary,
				action: "overlay",
				skill: key.skill,
				...(meta.reason === undefined ? {} : { reason: meta.reason }),
				...(meta.reviewId === undefined ? {} : { reviewId: meta.reviewId }),
				...(meta.conversationId === undefined ? {} : { conversationId: meta.conversationId }),
			},
			async () => {
				this.requireUser();
				await rm(file);
			},
			{ kind: "outside" },
		);
		return this.entry(key, sha, meta, summary);
	}

	/** Every stored overlay (present upstreams and orphans alike), sorted by root then name. */
	async list(): Promise<readonly Overlay[]> {
		this.requireUser();
		const result: Overlay[] = [];
		for (const root of ROOT_ORDER) {
			const dir = join(this.root, "overlays", ROOT_DIR[root]);
			let entries: string[] = [];
			try {
				entries = (await readdir(dir)).filter((entry) => entry.endsWith(".json"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const entry of entries.sort()) {
				const overlay = await this.read(join(dir, entry));
				if (overlay !== undefined) result.push(overlay);
			}
		}
		return result;
	}

	/**
	 * Mark every overlay whose upstream is absent (per `present`) with
	 * `orphanedSince: now`, and CLEAR the mark when the upstream is back
	 * (the overlay resumes serving). `present` receives each stored key.
	 */
	async markOrphans(present: (key: OverlayKey) => boolean, now: string): Promise<void> {
		this.requireUser();
		for (const overlay of await this.list()) {
			const here = present(overlay.key);
			if (here && overlay.orphanedSince === undefined) continue;
			if (!here && overlay.orphanedSince !== undefined) continue;
			const next: OverlayFile = here
				? { key: overlay.key, text: overlay.text, upstreamHash: overlay.upstreamHash }
				: { key: overlay.key, text: overlay.text, upstreamHash: overlay.upstreamHash, orphanedSince: overlay.orphanedSince ?? now };
			await writeFileAtomic(this.fileOf(overlay.key), `${JSON.stringify(next, null, 2)}\n`);
		}
	}

	private requireUser(): void {
		if (!this.options.userExists()) throw new Error("user removed");
	}

	private fileOf(key: OverlayKey): string {
		return join(this.root, "overlays", ROOT_DIR[key.root], `${keyHash(key)}.json`);
	}

	/** Read one overlay file; `undefined` on ENOENT (none stored). */
	private async read(path: string): Promise<Overlay | undefined> {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const value = JSON.parse(text) as Partial<OverlayFile>;
		if (
			typeof value.key?.root !== "string" ||
			typeof value.key.skill !== "string" ||
			typeof value.text !== "string" ||
			typeof value.upstreamHash !== "string"
		) {
			throw new Error(`corrupt overlay file: ${path}`);
		}
		return {
			key: value.key,
			text: value.text,
			upstreamHash: value.upstreamHash,
			...(typeof value.orphanedSince === "string" ? { orphanedSince: value.orphanedSince } : {}),
		};
	}

	/** Record one overlay change in the user repo as an `"overlay"` entry. */
	private entry(key: OverlayKey, sha: string | undefined, meta: OverlayMeta, summary: string): FeedEntry {
		return {
			id: sha ?? `(no-commit-${randomUUID()})`,
			at: new Date().toISOString(),
			actor: meta.actor,
			action: "overlay",
			skill: key.skill,
			reason: meta.reason ?? summary,
			...(meta.reviewId === undefined ? {} : { reviewId: meta.reviewId }),
			...(meta.conversationId === undefined ? {} : { conversationId: meta.conversationId }),
			...(sha === undefined ? {} : { after: sha }),
		};
	}
}

/**
 * The CURRENT upstream SKILL.md for a key, read from its own root —
 * core-side discovery: the workspace root through the conversation env
 * (or the key's workspace path from the host filesystem), the user dir
 * and the package roots through `opts`. `undefined` when the upstream
 * is absent (vanished — the caller marks orphans).
 *
 * `opts` defaults to an empty user dir and no package roots: a
 * workspace key needs only the env; a user-dir or package key needs the
 * caller to hand the roots it discovered under (boot's skills options).
 */
export async function resolveUpstream(
	key: OverlayKey,
	env: ExecutionEnv | undefined,
	ctx: Context,
	opts?: { userDir?: string; packageRoots?: () => readonly { extension: string; dir: string }[] },
): Promise<{ body: string; hash: string } | undefined> {
	checkKey(key);
	const fromText = (text: string): { body: string; hash: string } => ({
		body: text,
		hash: hashSkill(text),
	});
	if (key.root === "workspace") {
		// The conversation env sees the workspace the skill was discovered
		// under; the key's canonical path is the host-side fallback (and
		// the only route without an env).
		if (env !== undefined) {
			const joined = await env.joinPath(["skills", key.skill, "SKILL.md"], ctx);
			if (joined.ok) {
				const read = await env.readTextFile(joined.value, ctx);
				if (read.ok) return fromText(read.value);
			}
		}
		if (key.workspace !== undefined) {
			const text = await readHost(join(key.workspace, "skills", key.skill, "SKILL.md"));
			if (text !== undefined) return fromText(text);
		}
		return undefined;
	}
	if (key.root === "user dir") {
		const userDir = opts?.userDir;
		if (userDir === undefined) return undefined;
		const text = await readHost(join(userDir, key.skill, "SKILL.md"));
		return text === undefined ? undefined : fromText(text);
	}
	for (const root of opts?.packageRoots?.() ?? []) {
		const text = await readHost(join(root.dir, key.skill, "SKILL.md"));
		if (text !== undefined) return fromText(text);
	}
	return undefined;
}

/** Read one host-local SKILL.md; `undefined` on ENOENT. */
async function readHost(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * The overlay text to serve for one discovered skill, if any: looks the
 * skill up in the owner's overlay store and skips orphans. A learned
 * skill never has one (the store refuses those keys). Exported for the
 * `/skill:name` expansion, which serves the same shape `load_skill`
 * does.
 */
export async function overlayForSkill(
	opts: SkillsOptions,
	owner: string | undefined,
	skill: { readonly name: string; readonly root: "workspace" | "user dir" | "package" | "learned" },
	env: ExecutionEnv | undefined,
): Promise<string | undefined> {
	if (skill.root === "learned") return undefined;
	const store = opts.overlays?.(owner);
	if (store === undefined) return undefined;
	// The canonical workspace key (curator A9): the ROOT path, never
	// `env.cwd` — a conversation whose `pi.agent.cwd` points at a
	// subdirectory must still see the overlay written against the
	// workspace root. The root accessor wins when present; the env's
	// cwd is the pre-A9 fallback (the hermetic single-user boot shape).
	const workspace =
		skill.root === "workspace"
			? (opts.workspaceRoot?.() ?? env?.cwd)
			: undefined;
	const key: OverlayKey = {
		root: skill.root,
		skill: skill.name,
		...(workspace === undefined ? {} : { workspace }),
	};
	const overlay = await store.get(key);
	if (overlay === undefined || overlay.orphanedSince !== undefined) return undefined;
	return overlay.text;
}
