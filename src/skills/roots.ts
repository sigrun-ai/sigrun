/**
 * Task 11: every-root discovery with safe reads.
 *
 * `listAllRoots` is the Skills-tab (core/skills view) counterpart to
 * `discoverSkills`: where `merge()` keeps only the winning skill per
 * name, this lists EVERY root's skills — losers included — in precedence
 * order (workspace > learned > user dir > packages in install order),
 * with shadowing info (`shadowedBy` names the root kind that won), the
 * hidden flag, and `{error}` rows for skills that fail the safety
 * checks. The frontmatter parsing is `scanFsRoot`'s own.
 *
 * `readSkillFile` / `listSupportFiles` are the ONLY read paths the view
 * uses: core reads these roots with HOST privileges, so every read
 * refuses symlinks on EVERY path segment, verifies real-path containment
 * within the discovery root, allows only SKILL.md or
 * `references|templates|scripts|assets/<rel>`, and caps reads at
 * 256 KiB — the same checks the curator store applies
 * (`assertNoSymlinks` + support-file shape). Without them the view is a
 * confused deputy: a symlinked SKILL.md would show the user a file the
 * agent's sandbox could never read. A skill that fails the checks
 * becomes `{error}` and is never read further.
 */

import { lstat, readdir, realpath, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { validSkillName } from "../curation/names.js";
import { parseSkillFile } from "./index.js";

/** The discovery roots, in precedence order (matches src/skills/index.ts). */
export type SkillRootKind = "workspace" | "learned" | "user dir" | "package";

/** One skill as one root lists it — a readable row or an error row. */
export interface RootSkill {
	readonly name: string;
	readonly description: string;
	readonly root: SkillRootKind;
	/** The contributing package's extension slug (package roots only). */
	readonly packageName?: string;
	/** Absolute discovery root (e.g. <workspace>/skills, a package's skills dir): the containment anchor. */
	readonly rootDir: string;
	/** Absolute skill directory, inside rootDir. */
	readonly dir: string;
	/** Frontmatter `disable-model-invocation: true`. */
	readonly hidden: boolean;
	/** Loser rows: the root kind whose same-named skill won. */
	readonly shadowedBy?: SkillRootKind;
	/** Safety-check failure — the row renders as an error, never content. */
	readonly error?: string;
}

/** The largest file the view will read (SKILL.md or a support file). */
export const SKILL_READ_CAP_BYTES = 256 * 1024;

const SKILL_FILE = "SKILL.md";
const SUPPORT_ROOTS = ["references", "templates", "scripts", "assets"] as const;
const SYMLINK_REFUSED = "symlinks are not allowed in skill files";

/**
 * The file argument's allowed shapes: exactly `SKILL.md`, or a relative
 * path under `references/`, `templates/`, `scripts/`, or `assets/` with
 * no empty/`.`/`..` segments, no backslashes, no absolute prefix, no NUL.
 * Returns the forward-slash segments.
 */
function fileSegments(file: string): string[] {
	if (file === SKILL_FILE) return [file];
	if (file.includes("\\") || file.startsWith("/") || file.includes("\0")) {
		throw new Error(
			"skill file must be SKILL.md or a relative support-file path",
		);
	}
	const parts = file.split("/");
	if (
		parts.length < 2 ||
		!(SUPPORT_ROOTS as readonly string[]).includes(parts[0]) ||
		parts.some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(
			"skill file must be SKILL.md or under references/, templates/, scripts/ or assets/",
		);
	}
	return parts;
}

/**
 * Refuse symlinks on EVERY segment of `<root>/<segments>` (the curator
 * store's `assertNoSymlinks` check): a symlink anywhere on the path means
 * the read target is not what the root contains, so the read is refused
 * outright. Returns once a segment does not exist — the read itself will
 * report the absence.
 */
async function assertNoSymlinks(root: string, segments: readonly string[]): Promise<void> {
	let path = root;
	for (const segment of segments) {
		path = join(path, segment);
		try {
			if ((await lstat(path)).isSymbolicLink()) throw new Error(SYMLINK_REFUSED);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

/**
 * Real-path containment: after resolving every link, `target` must sit
 * inside `root`. The belt to `assertNoSymlinks`'s braces — a hardlink-free
 * lstat walk still cannot see a rename race, and containment catches any
 * resolution that escaped the anchor regardless of how.
 */
async function assertContained(root: string, target: string): Promise<void> {
	const [realRoot, realTarget] = await Promise.all([
		realpath(root),
		realpath(target),
	]);
	if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
		throw new Error("skill file escapes its discovery root");
	}
}

/**
 * The ONLY read path the core/skills view uses. `rootDir` is the
 * discovery root (the containment anchor), `skill` the skill directory
 * name inside it, `file` either `SKILL.md` or a support-file path under
 * `references|templates|scripts|assets`. Symlinks on any segment and any
 * escape from `rootDir` are refused; reads over 256 KiB are refused.
 */
export async function readSkillFile(
	rootDir: string,
	skill: string,
	file: string,
): Promise<string> {
	if (!validSkillName(skill)) throw new Error(`invalid skill name: ${skill}`);
	const segments = [skill, ...fileSegments(file)];
	await assertNoSymlinks(rootDir, segments);
	const target = join(rootDir, ...segments);
	await assertContained(rootDir, target);
	const info = await stat(target);
	if (info.size > SKILL_READ_CAP_BYTES) {
		throw new Error(`skill file exceeds the 256 KiB read cap: ${file}`);
	}
	const buffer = await readFile(target);
	if (buffer.byteLength > SKILL_READ_CAP_BYTES) {
		throw new Error(`skill file exceeds the 256 KiB read cap: ${file}`);
	}
	return buffer.toString("utf8");
}

/**
 * Recursively collect relative file paths under `dir`, never following
 * symlinks: a symlinked entry (file or directory) is skipped, not
 * traversed — the listing mirrors what `readSkillFile` would serve.
 */
async function collectFiles(dir: string, prefix: string, out: string[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const relative = `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			await collectFiles(join(dir, entry.name), relative, out);
		} else if (entry.isFile()) {
			out.push(relative);
		}
	}
}

/**
 * The support-file listing under one skill, with the same safety posture
 * as `readSkillFile`: the skill directory must be symlink-free and
 * contained in `rootDir`, and symlinked entries inside the support roots
 * are excluded rather than followed. A skill without support files (or
 * without a directory at all) lists nothing.
 */
export async function listSupportFiles(
	rootDir: string,
	skill: string,
): Promise<readonly string[]> {
	if (!validSkillName(skill)) throw new Error(`invalid skill name: ${skill}`);
	await assertNoSymlinks(rootDir, [skill]);
	const skillDir = join(rootDir, skill);
	try {
		if (!(await lstat(skillDir)).isDirectory()) return [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	await assertContained(rootDir, skillDir);
	const out: string[] = [];
	for (const root of SUPPORT_ROOTS) {
		await collectFiles(join(skillDir, root), root, out);
	}
	return out.sort();
}

interface ListRoot {
	readonly kind: SkillRootKind;
	readonly rootDir: string;
	readonly packageName?: string;
}

/** The safety check a skill must pass before its SKILL.md is ever read. */
async function skillSafetyError(
	rootDir: string,
	dirName: string,
): Promise<string | undefined> {
	try {
		await assertNoSymlinks(rootDir, [dirName]);
		const skillDir = join(rootDir, dirName);
		if (!(await lstat(skillDir)).isDirectory()) return undefined; // not a skill
		await assertContained(rootDir, skillDir);
		// SKILL.md itself: present, symlink-free, and inside the root.
		await assertNoSymlinks(rootDir, [dirName, SKILL_FILE]);
		await assertContained(rootDir, join(skillDir, SKILL_FILE));
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * List ONE root's skill directories, applying the safety checks before
 * any read. Entries that are not directories, and directories without a
 * SKILL.md, are not skills (the v1 rule, unchanged). A symlinked skill
 * dir or SKILL.md is an error row — named by its directory, never read.
 * Readable skills parse through `parseSkillFile` (scanFsRoot's own
 * frontmatter parsing); within one root, duplicate names resolve
 * first-wins in sorted directory order with a log, exactly like
 * scanFsRoot.
 */
async function scanRootSafely(root: ListRoot): Promise<RootSkill[]> {
	let entries;
	try {
		entries = await readdir(root.rootDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const names = [...new Set(entries.map((entry) => entry.name))].sort();
	const skills: RootSkill[] = [];
	const byName = new Map<string, RootSkill>();
	for (const dirName of names) {
		if (!validSkillName(dirName)) continue;
		const dir = join(root.rootDir, dirName);
		const base = {
			root: root.kind,
			rootDir: root.rootDir,
			dir,
			hidden: false,
			...(root.packageName === undefined ? {} : { packageName: root.packageName }),
		};
		// A symlinked entry (skill dir or SKILL.md inside) is an error row —
		// never read further, so the target's content leaks nowhere.
		const safetyError = await skillSafetyError(root.rootDir, dirName);
		if (safetyError !== undefined) {
			skills.push({ ...base, name: dirName, description: "", error: safetyError });
			continue;
		}
		let text: string;
		try {
			text = await readSkillFile(root.rootDir, dirName, SKILL_FILE);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // no SKILL.md — not a skill
			skills.push({
				...base,
				name: dirName,
				description: "",
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		const parsed = parseSkillFile(text);
		if (parsed === undefined || parsed.name === undefined || parsed.description === undefined) {
			// The v1 skip rule (a malformed SKILL.md is not a skill) holds for
			// the view too — the row simply does not appear.
			continue;
		}
		const skill: RootSkill = {
			...base,
			name: parsed.name,
			description: parsed.description,
			hidden: parsed.disableModelInvocation,
		};
		if (!byName.has(skill.name)) {
			byName.set(skill.name, skill);
			skills.push(skill);
		} else {
			console.warn(
				`skills: duplicate name "${skill.name}" (${dir} ignored; ${byName.get(skill.name)?.dir} wins)`,
			);
		}
	}
	return skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Every root's skills, losers included, in precedence order: workspace,
 * learned, user dir, then packages in install order. A name listed by
 * several roots wins in the FIRST (highest-precedence) root; every
 * lower-precedence row carries `shadowedBy` naming the winning root
 * kind. Absent roots are the designed empty case.
 */
export async function listAllRoots(opts: {
	workspace?: string;
	learned?: string;
	userDir: string;
	packageRoots: readonly { extension: string; dir: string }[];
}): Promise<readonly RootSkill[]> {
	const roots: ListRoot[] = [];
	if (opts.workspace !== undefined) {
		roots.push({ kind: "workspace", rootDir: opts.workspace });
	}
	if (opts.learned !== undefined) {
		roots.push({ kind: "learned", rootDir: opts.learned });
	}
	roots.push({ kind: "user dir", rootDir: opts.userDir });
	for (const pkg of opts.packageRoots) {
		roots.push({ kind: "package", rootDir: pkg.dir, packageName: pkg.extension });
	}
	const out: RootSkill[] = [];
	const winners = new Map<string, SkillRootKind>();
	for (const root of roots) {
		for (const skill of await scanRootSafely(root)) {
			if (skill.error === undefined) {
				const winner = winners.get(skill.name);
				if (winner === undefined) {
					winners.set(skill.name, skill.root);
				} else {
					out.push({ ...skill, shadowedBy: winner });
					continue;
				}
			}
			out.push(skill);
		}
	}
	return out;
}
