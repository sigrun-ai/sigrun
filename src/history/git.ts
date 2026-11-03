/**
 * GitHistory — isolated local git for sigrun-owned history stores
 * (tabs+skills plan, Task 7). The history repos are tamper-resistant only
 * under active sandbox isolation; the isolation argv contract below is the
 * whole point of the module:
 *
 * - execFile, never a shell; every argv is produced by gitArgs();
 * - --git-dir and --work-tree are explicit on every invocation (the work
 *   tree is a user's live directory, never the git dir's parent);
 * - env GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1, HOME and
 *   XDG_CONFIG_HOME = opts.gitHome (created empty), GIT_TERMINAL_PROMPT=0;
 * - -c commit.gpgsign=false -c tag.gpgsign=false -c core.hooksPath=/dev/null
 *   -c core.attributesFile=/dev/null -c core.excludesFile=/dev/null
 *   -c core.fsmonitor=false -c safe.directory=<workTree>. safe.directory
 *   must ride the -c flags: git honours it only from protected config,
 *   never from the repo's own config.
 *
 * Failure semantics are fail-soft: the caller's mutation always runs; git
 * failures are logged and degrade to "no commit" (write returns undefined).
 * A corrupt git dir is renamed to <gitDir>.broken-<UTC stamp> and
 * re-initialized with a snapshot commit; a stale index.lock (> 10 minutes)
 * is removed with a log line while a fresh one fails only the commit.
 */

import { execFile } from "node:child_process";
import {
	access,
	mkdir,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { relative, sep } from "node:path";
import { promisify } from "node:util";
import {
	actorEmail,
	actorName,
	decodeActor,
	encodeTrailers,
	sanitizeMeta,
} from "./trailers.js";

const execFileAsync = promisify(execFile);

export type HistoryActor =
	| { readonly kind: "user"; readonly user: string }
	| { readonly kind: "curator" }
	| { readonly kind: "agent" }
	| { readonly kind: "outside" };

export interface CommitMeta {
	readonly actor: HistoryActor;
	readonly summary: string;
	readonly action?: string;
	readonly skill?: string;
	readonly reviewId?: string;
	readonly conversationId?: number;
	readonly reason?: string;
	readonly undoes?: string;
}

export interface HistoryCommit extends CommitMeta {
	readonly sha: string;
	readonly at: string;
	readonly paths: readonly string[];
}

export interface GitRepoSpec {
	readonly gitDir: string;
	readonly workTree: string;
	readonly pathspec: readonly string[];
}

export type HistoryAvailability =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

export interface GitHistoryOptions {
	readonly gitHome: string;
	readonly gitBinary?: string;
	readonly now?: () => Date;
	readonly log?: (line: string) => void;
}

/** Files larger than this (or binary) are not inlined into changes(). */
const MAX_INLINE_BYTES = 64 * 1024;
export const OVERSIZE_MARKER = "(binary or larger than 64 KiB)";
/** A fresh index.lock fails the commit; one older than this is removed. */
const STALE_LOCK_MS = 10 * 60 * 1000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const RS = "\x1e";
const FS = "\x1f";

/** One in-process async mutex per gitDir (module-level, keyed by gitDir). */
const locks = new Map<string, Promise<void>>();

function utcStamp(now: Date): string {
	return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * The ONE argv builder: every git invocation goes through this so the
 * isolation flags can never be dropped at a call site.
 */
export function gitArgs(spec: GitRepoSpec, ...args: string[]): string[] {
	return [
		`--git-dir=${spec.gitDir}`,
		`--work-tree=${spec.workTree}`,
		"-c",
		"commit.gpgsign=false",
		"-c",
		"tag.gpgsign=false",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.attributesFile=/dev/null",
		"-c",
		"core.excludesFile=/dev/null",
		"-c",
		"core.fsmonitor=false",
		"-c",
		`safe.directory=${spec.workTree}`,
		...args,
	];
}

export class GitHistory {
	private readonly spec: GitRepoSpec;
	private readonly git: string;
	private readonly gitHome: string;
	private readonly now: () => Date;
	private readonly logLine: (line: string) => void;
	/** catchUp's prepare failure logs once per instance (never per settle). */
	private prepareFailureLogged = false;

	constructor(spec: GitRepoSpec, opts: GitHistoryOptions) {
		this.spec = spec;
		this.git = opts.gitBinary ?? "git";
		this.gitHome = opts.gitHome;
		this.now = opts.now ?? (() => new Date());
		this.logLine = opts.log ?? (() => {});
	}

	async availability(): Promise<HistoryAvailability> {
		try {
			await access(this.spec.workTree, constants.R_OK | constants.W_OK);
		} catch {
			return {
				ok: false,
				reason: `work tree ${this.spec.workTree} is not readable and writable by the sigrun process`,
			};
		}
		try {
			await this.run(["rev-parse", "--git-dir"]);
			return { ok: true };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				reason: `git unavailable for ${this.spec.gitDir} (${this.git}): ${detail}`,
			};
		}
	}

	/**
	 * Lock → catch-up (actor catchUpAs) → mutate → commit(meta). The
	 * mutation runs even when git is unavailable or failing; the failure is
	 * logged and the result is undefined (no commit).
	 */
	write(
		meta: CommitMeta,
		mutate: () => Promise<void>,
		catchUpAs?: HistoryActor,
	): Promise<string | undefined> {
		return this.withLock(async () => {
			const state = await this.prepare();
			if (!state.ok) {
				await mutate();
				this.logLine(`history write landed without a commit: ${state.reason}`);
				return undefined;
			}
			if (catchUpAs !== undefined) await this.commitDirty(catchUpAs);
			await mutate();
			return this.commit(meta);
		});
	}

	/**
	 * Lock → commit uncommitted changes as meta (a catch-up). A prepare
	 * failure is logged ONCE per instance (the settle-time catch-up fires
	 * per run — the legitimate "agent never wrote skills" state must not
	 * warn every settle) and degrades to no commit.
	 */
	catchUp(meta: CommitMeta): Promise<string | undefined> {
		return this.withLock(async () => {
			const state = await this.prepare();
			if (!state.ok) {
				if (!this.prepareFailureLogged) {
					this.prepareFailureLogged = true;
					this.logLine(`history catch-up skipped: ${state.reason}`);
				}
				return undefined;
			}
			return this.commit(meta);
		});
	}

	/**
	 * Lock → DISCARD any existing repo → init fresh → one commit of the
	 * current pathspec content as meta (the curation migration import,
	 * Task 9). Atomic under the per-repo lock: a concurrent write either
	 * lands before the discard (its content is re-imported from disk —
	 * nothing lost) or after the import commit. Returns the import
	 * commit's sha, or undefined when nothing could be staged.
	 */
	freshImport(meta: CommitMeta): Promise<string | undefined> {
		return this.withLock(async () => {
			await rm(this.spec.gitDir, { recursive: true, force: true });
			const state = await this.prepare();
			if (!state.ok) {
				this.logLine(`history import landed without a commit: ${state.reason}`);
				return undefined;
			}
			return this.commit(meta);
		});
	}

	async log(opts: {
		readonly path?: string;
		readonly limit: number;
		readonly before?: string;
	}): Promise<readonly HistoryCommit[]> {
		if (await this.headMissing()) return [];
		const head = await this.output(["rev-parse", "--verify", "HEAD"]);
		// `before` pages strictly older commits: start from the cursor's
		// parent so the cursor commit itself is excluded.
		const start =
			opts.before === undefined ? head.trim() : `${opts.before}^`;
		// Paging from the root commit's sha (`<root>^` does not exist) is an
		// empty page, not an error: Task 12's paginator reaches it normally.
		if (opts.before !== undefined && (await this.parentOf(opts.before)) === undefined) {
			return [];
		}
		const format = [
			"--format=%x1e%H%x1f%aI%x1f%s%x1f%an",
			"%x1f%(trailers:key=Sigrun-Actor,valueonly)",
			"%x1f%(trailers:key=Sigrun-Action,valueonly)",
			"%x1f%(trailers:key=Sigrun-Skill,valueonly)",
			"%x1f%(trailers:key=Sigrun-Review,valueonly)",
			"%x1f%(trailers:key=Sigrun-Conversation,valueonly)",
			"%x1f%(trailers:key=Sigrun-Reason,valueonly)",
			"%x1f%(trailers:key=Sigrun-Undoes,valueonly)",
		].join("");
		const args = [
			"log",
			`--max-count=${opts.limit}`,
			format,
			"--name-only",
			"-z",
			start,
		];
		if (opts.path !== undefined) args.push("--", opts.path);
		const stdout = await this.output(args);
		const commits: HistoryCommit[] = [];
		for (const record of stdout.split(RS)) {
			// --name-only with -z appends a NUL and the NUL-separated path list
			// after the %x1f fields; it belongs to this record.
			const nulAt = record.indexOf("\0");
			const head = (nulAt === -1 ? record : record.slice(0, nulAt)).trim();
			if (head === "") continue;
			const paths =
				nulAt === -1
					? []
					: record
							.slice(nulAt + 1)
							.split("\0")
							.map((line) => line.trim())
							.filter((line) => line !== "");
			// Single-line %x1f fields can carry a trailing newline: first-line.
			const parts = head.split(FS).map((part) => {
				const newlineAt = part.indexOf("\n");
				return newlineAt === -1 ? part.trim() : part.slice(0, newlineAt).trim();
			});
			const sha = parts[0] ?? "";
			const at = parts[1] ?? "";
			const summary = parts[2] ?? "";
			const authorName = parts[3] ?? "";
			const trailers = parts.slice(4, 11).map((value) => orUndefined(value));
			const actorRaw = trailers[0];
			const conversationRaw = trailers[4];
			commits.push({
				sha,
				at: at !== "" ? new Date(at).toISOString() : "",
				summary: summary.trim(),
				actor: decodeActor(
					actorRaw === undefined ? authorName.trim() : actorRaw,
				),
				action: trailers[1],
				skill: trailers[2],
				reviewId: trailers[3],
				conversationId:
					conversationRaw === undefined ? undefined : Number(conversationRaw),
				reason: trailers[5],
				undoes: trailers[6],
				paths,
			});
		}
		return commits;
	}

	/**
	 * Per-file before/after text for one commit, restricted to path. Binary
	 * or oversize (> 64 KiB) blobs return OVERSIZE_MARKER on the affected
	 * side; the side with no blob (add / delete) is the empty string.
	 */
	async changes(
		sha: string,
		path?: string,
	): Promise<readonly { path: string; before: string; after: string }[]> {
		const parent = await this.parentOf(sha);
		const beforeTree = parent === undefined ? EMPTY_TREE : parent;
		const args = ["diff-tree", "-r", "--format=", beforeTree, sha];
		if (path !== undefined) args.push("--", path);
		const raw = await this.output(args);
		const pairs: { path: string; before: string | null; after: string | null }[] = [];
		for (const line of raw.split("\n")) {
			if (!line.startsWith(":")) continue;
			const match =
				/^:\d+ \d+ ([0-9a-f]{40}) ([0-9a-f]{40}) [A-Z]\t(.+)$/.exec(line);
			if (match === null) continue;
			const [, beforeSha, afterSha, filePath] = match;
			if (beforeSha === undefined || afterSha === undefined || filePath === undefined) {
				continue;
			}
			const ZERO = "0000000000000000000000000000000000000000";
			pairs.push({
				path: filePath,
				before: beforeSha === ZERO ? null : beforeSha,
				after: afterSha === ZERO ? null : afterSha,
			});
		}
		const result: { path: string; before: string; after: string }[] = [];
		for (const pair of pairs) {
			result.push({
				path: pair.path,
				before: pair.before === null ? "" : await this.blob(pair.before),
				after: pair.after === null ? "" : await this.blob(pair.after),
			});
		}
		return result;
	}

	/**
	 * Lock → make paths exactly as they were at sha → commit(meta).
	 * sha === undefined means "before history began": the paths are removed.
	 */
	restore(
		sha: string | undefined,
		paths: readonly string[],
		meta: CommitMeta,
	): Promise<string | undefined> {
		return this.withLock(async () => {
			const state = await this.prepare();
			if (!state.ok) return undefined;
			const head = await this.output(["rev-parse", "--verify", "HEAD"]);
			const headSha = head.trim();
			const headTree = await this.treeListing(headSha, paths);
			const atSha =
				sha === undefined ? new Set<string>() : await this.treeListing(sha, paths);
			const remove = [...headTree].filter((path) => !atSha.has(path));
			if (remove.length > 0) {
				await this.run(["rm", "-q", "-r", "--ignore-unmatch", "--", ...remove]);
			}
			if (sha !== undefined && atSha.size > 0) {
				const present = paths.filter((path) => this.existsAt(sha, atSha, path));
				const restoreArgs = ["checkout", sha, "--", ...present];
				await this.run(restoreArgs);
			}
			return this.commit(meta);
		});
	}

	/** sha's first parent, or undefined for a root commit. */
	async parentOf(sha: string): Promise<string | undefined> {
		const stdout = await this.output([
			"rev-list",
			"--max-parents=0",
			"HEAD",
			"--",
		]);
		const roots = new Set(stdout.split("\n").map((line) => line.trim()));
		if (roots.has(sha)) return undefined;
		const parent = await this.output(["rev-parse", "--verify", `${sha}^`]);
		const trimmed = parent.trim();
		return trimmed === "" ? undefined : trimmed;
	}

	// ---- internals ------------------------------------------------------

	private async blob(sha: string): Promise<string> {
		const info = await this.output(["cat-file", "-s", sha]);
		if (Number(info.trim()) > MAX_INLINE_BYTES) return OVERSIZE_MARKER;
		const content = Buffer.from(await this.outputBuffer(["cat-file", "blob", sha]));
		if (content.indexOf(0) !== -1) return OVERSIZE_MARKER;
		return content.toString("utf8");
	}

	/** Files in `tree` under any pathspec entry (path-restricted ls-tree). */
	private async treeListing(
		tree: string,
		paths: readonly string[],
	): Promise<Set<string>> {
		const result = new Set<string>();
		for (const path of paths) {
			const stdout = await this.output([
				"ls-tree",
				"-r",
				"--name-only",
				tree,
				"--",
				path,
			]);
			for (const line of stdout.split("\n")) {
				const trimmed = line.trim();
				if (trimmed !== "") result.add(trimmed);
			}
		}
		return result;
	}

	/**
	 * Whether a pathspec entry has any files at sha. ls-tree reports dirs as
	 * a single "skills" line without -r, so compare against the recursive
	 * listing plus the entry itself.
	 */
	private existsAt(sha: string, listing: Set<string>, entry: string): boolean {
		void sha;
		if (listing.has(entry)) return true;
		const prefix = entry.endsWith("/") ? entry : `${entry}/`;
		for (const file of listing) {
			if (file.startsWith(prefix)) return true;
		}
		return false;
	}

	/** No HEAD yet → the log reads as empty (never a git error surface). */
	private async headMissing(): Promise<boolean> {
		try {
			await this.run(["rev-parse", "--verify", "HEAD"]);
			return false;
		} catch {
			return true;
		}
	}

	private withLock<T>(operation: () => Promise<T>): Promise<T> {
		const key = this.spec.gitDir;
		const previous = locks.get(key) ?? Promise.resolve();
		const gate = new Promise<void>((resolve) => {
			previous.then(resolve, resolve);
		});
		const run = gate.then(operation);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		locks.set(key, tail);
		return run;
	}

	/**
	 * Inside the lock: make the repo usable, or explain why not. The work
	 * tree itself is never created or modified here.
	 */
	private async prepare(): Promise<{ ok: true } | { ok: false; reason: string }> {
		try {
			await access(this.spec.workTree, constants.R_OK | constants.W_OK);
		} catch {
			return {
				ok: false,
				reason: `work tree ${this.spec.workTree} is not readable and writable`,
			};
		}
		try {
			await mkdir(this.gitHome, { recursive: true });
		} catch {
			// The env still points at gitHome; git tolerates it missing.
		}
		try {
			await this.run(["rev-parse", "--git-dir"]);
		} catch (error) {
			if (this.isMissingBinary(error)) {
				return {
					ok: false,
					reason: `git binary not usable: ${this.git}`,
				};
			}
			const gitDirInfo = await stat(this.spec.gitDir).catch(() => undefined);
			if (gitDirInfo === undefined) {
				try {
					// The git dir's PARENT must exist: `git init` does not create
					// it, and this module owns the git dir (never the work tree).
					await mkdir(this.spec.gitDir, { recursive: true });
					await this.run(["init", "--initial-branch=main"]);
					await this.writeInfoExclude();
				} catch (initError) {
					if (this.isMissingBinary(initError)) {
						return {
							ok: false,
							reason: `git binary not usable: ${this.git}`,
						};
					}
					return {
						ok: false,
						reason: `git init failed for ${this.spec.gitDir}: ${String(initError)}`,
					};
				}
			} else {
				// Corrupt recovery is fail-soft like everything else: any failure
				// here (rename blocked, init failing) degrades to no-commit; the
				// caller's mutation still runs.
				try {
					await this.recoverCorrupt();
				} catch (recoverError) {
					this.logLine(
						`corrupt git dir recovery failed for ${this.spec.gitDir}: ${String(recoverError)}`,
					);
					return {
						ok: false,
						reason: `corrupt git dir at ${this.spec.gitDir} could not be recovered: ${String(recoverError)}`,
					};
				}
			}
		}
		return { ok: true };
	}

	private isMissingBinary(error: unknown): boolean {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		);
	}

	/** Corrupt git dir → move aside, re-init, snapshot commit (loud log). */
	private async recoverCorrupt(): Promise<void> {
		const brokenName = `${this.spec.gitDir.split(sep).pop() ?? "repo"}.broken-${utcStamp(this.now())}`;
		const brokenPath = `${this.spec.gitDir}.broken-${utcStamp(this.now())}`;
		await rename(this.spec.gitDir, brokenPath);
		this.logLine(
			`corrupt git dir moved aside: ${this.spec.gitDir} → ${brokenPath}`,
		);
		await this.run(["init", "--initial-branch=main"]);
		await this.writeInfoExclude();
		const sha = await this.commit({
			actor: { kind: "outside" },
			summary: `Re-initialized after a corrupt history (old repo moved to ${brokenName})`,
		});
		void sha;
	}

	/** The git dir must never be read as work-tree content. */
	private async writeInfoExclude(): Promise<void> {
		const relativeGitDir = relative(this.spec.workTree, this.spec.gitDir);
		if (relativeGitDir === "" || relativeGitDir.startsWith("..")) return;
		const infoDir = `${this.spec.gitDir}/info`;
		await mkdir(infoDir, { recursive: true });
		await writeFile(`${infoDir}/exclude`, `/${relativeGitDir}\n`);
	}

	/**
	 * Staging: `add --all --force -- <entries>` filtered to entries that
	 * exist (git fatals on a pathspec matching nothing), minus any nested
	 * .git dirs, which are logged and excluded via a computed :(exclude)
	 * pathspec. Returns false when nothing could be staged.
	 */
	private async stage(): Promise<boolean> {
		const entries: string[] = [];
		const excluded: string[] = [];
		for (const entry of this.spec.pathspec) {
			const absolute = `${this.spec.workTree}/${entry}`;
			const info = await stat(absolute).catch(() => undefined);
			if (info === undefined) {
				// An absent entry still stages when git tracks files under it:
				// that's how a deleted pathspec root records its deletions.
				// `git add --all` fatals only when the pathspec matches nothing
				// in the index OR the work tree.
				if (!(await this.tracksAny(entry))) continue;
				entries.push(entry);
				continue;
			}
			if (info.isDirectory()) {
				for (const nested of await this.nestedGitDirs(absolute, entry)) {
					excluded.push(nested);
					this.logLine(`skipping nested .git dir: ${this.spec.workTree}/${nested}`);
				}
			}
			entries.push(entry);
		}
		if (entries.length === 0) return false;
		await this.run([
			"add",
			"--all",
			"--force",
			"--",
			...entries,
			...excluded.map((path) => `:(exclude)${path}`),
		]);
		return true;
	}

	/** Whether the index tracks any file under the pathspec entry. */
	private async tracksAny(entry: string): Promise<boolean> {
		try {
			const stdout = await this.output(["ls-files", "--", entry]);
			return stdout.trim() !== "";
		} catch {
			return false;
		}
	}

	private async nestedGitDirs(
		absolute: string,
		relativeRoot: string,
	): Promise<string[]> {
		const found: string[] = [];
		const walk = async (dir: string, prefix: string): Promise<void> => {
			const children = await readdir(dir, { withFileTypes: true }).catch(
				() => [],
			);
			for (const child of children) {
				if (!child.isDirectory()) continue;
				const childPath = `${dir}/${child.name}`;
				const childRelative = `${prefix}${child.name}`;
				if (child.name === ".git") {
					// Exclude the whole nested repo root, not just its .git dir.
					found.push(prefix.slice(0, -1));
					continue;
				}
				await walk(childPath, `${childRelative}/`);
			}
		};
		const root = relativeRoot.endsWith("/") ? relativeRoot : `${relativeRoot}/`;
		await walk(absolute, root);
		return found;
	}

	/** A fresh index.lock fails the commit; a stale one is removed. */
	private async checkIndexLock(): Promise<{ ok: true } | { ok: false; reason: string }> {
		const lockPath = `${this.spec.gitDir}/index.lock`;
		const info = await stat(lockPath).catch(() => undefined);
		if (info === undefined) return { ok: true };
		const ageMs = this.now().getTime() - info.mtimeMs;
		if (ageMs > STALE_LOCK_MS) {
			await rm(lockPath, { force: true });
			this.logLine(
				`removed stale index.lock (age ${Math.round(ageMs / 60000)} min) at ${lockPath}`,
			);
			return { ok: true };
		}
		return {
			ok: false,
			reason: `index.lock present at ${lockPath} (age ${Math.round(ageMs / 1000)}s)`,
		};
	}

	/**
	 * Stage + commit if anything changed. Returns the new commit's sha, or
	 * undefined when there was no change or git failed (logged).
	 */
	private async commit(meta: CommitMeta): Promise<string | undefined> {
		try {
			// Trailer/content injection guard: every string that flows into
			// the message is sanitized first (trailers.ts).
			const cleanMeta = sanitizeMeta(meta);
			const lockState = await this.checkIndexLock();
			if (!lockState.ok) {
				this.logLine(`history commit skipped: ${lockState.reason}`);
				return undefined;
			}
			if (!(await this.stage())) return undefined;
			const status = await this.output([
				"status",
				"--porcelain",
				"--",
				...this.spec.pathspec,
			]);
			if (status.trim() === "") return undefined;
			const trailers = encodeTrailers(cleanMeta);
			const message =
				trailers === "" ? cleanMeta.summary : `${cleanMeta.summary}\n\n${trailers}`;
			const sha = await this.runCommit(message, cleanMeta);
			await this.gc();
			return sha;
		} catch (error) {
			this.logLine(`history commit failed: ${String(error)}`);
			return undefined;
		}
	}

	/** commitDirty = the catch-up half of write(): commit what is there. */
	private async commitDirty(actor: HistoryActor): Promise<string | undefined> {
		return this.commit({ actor, summary: "outside changes" });
	}

	private async runCommit(message: string, meta: CommitMeta): Promise<string> {
		const env = {
			...this.env(),
			GIT_AUTHOR_NAME: actorName(meta.actor),
			GIT_AUTHOR_EMAIL: actorEmail(meta.actor),
			GIT_COMMITTER_NAME: "sigrun",
			GIT_COMMITTER_EMAIL: "sigrun@sigrun.invalid",
		};
		await execFileAsync(this.git, gitArgs(this.spec, "commit", "-m", message), {
			env,
			maxBuffer: 64 * 1024 * 1024,
		});
		const sha = await this.output(["rev-parse", "--verify", "HEAD"]);
		return sha.trim();
	}

	private async gc(): Promise<void> {
		try {
			await this.run(["gc", "--auto", "--quiet"]);
		} catch (error) {
			this.logLine(`git gc --auto failed (ignored): ${String(error)}`);
		}
	}

	private env(): NodeJS.ProcessEnv {
		// Ambient GIT_* variables (GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
		// GIT_COMMON_DIR, ...) survive an argv-level -c and would let the
		// caller's environment redirect or corrupt the repo. Strip them all;
		// the module sets exactly the five it needs.
		const env: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("GIT_")) env[key] = value;
		}
		return {
			...env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			HOME: this.gitHome,
			XDG_CONFIG_HOME: this.gitHome,
			GIT_TERMINAL_PROMPT: "0",
		};
	}

	private async run(args: string[]): Promise<void> {
		await execFileAsync(this.git, gitArgs(this.spec, ...args), {
			env: this.env(),
			maxBuffer: 64 * 1024 * 1024,
		});
	}

	private async output(args: string[]): Promise<string> {
		const { stdout } = await execFileAsync(
			this.git,
			gitArgs(this.spec, ...args),
			{ env: this.env(), maxBuffer: 64 * 1024 * 1024 },
		);
		return stdout;
	}

	private async outputBuffer(args: string[]): Promise<Buffer> {
		const { stdout } = await execFileAsync(
			this.git,
			gitArgs(this.spec, ...args),
			{
				env: this.env(),
				maxBuffer: 64 * 1024 * 1024,
				encoding: "buffer",
			},
		);
		return stdout;
	}
}

function orUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
