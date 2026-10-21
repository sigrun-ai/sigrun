/**
 * The skills convention (spec §3.2 + §9.4) — CORE-OWNED, not an extension
 * package.
 *
 * v1 discovered ONE root: `skills/<dir>/SKILL.md` in the conversation
 * workspace. W5 Task 4 (spec §9.4) grows discovery to THREE roots, with
 * first-wins precedence in this order:
 *
 * 1. the WORKSPACE root — `skills/` under the conversation workspace, read
 *    through the conversation `ExecutionEnv` (the section via
 *    `PromptInput.env`, the tool via `ToolExecutionApi.env`), so discovery
 *    follows the resolved workspace;
 * 2. the USER root — `<configDir>/skills/` (a named config-root entry),
 *    read from the host filesystem;
 * 3. PACKAGE roots — skill directories shipped by extension packages
 *    (manifest `sigrun.skills`/`pi.skills` dirs and factory-result `skills`
 *    dirs, collected by the loader in install order), read from the host
 *    filesystem.
 *
 * A name that appears in several roots keeps the HIGHER root's skill and
 * logs `skills: "<name>" from <lower root> shadowed by <higher root>`.
 * `load_skill(name)` returns the WINNING skill's body, read from its own
 * root — the env for workspace skills, the filesystem for the others.
 * User/package skills belong to the deployment; workspace skills belong to
 * the workspace (under a future remote workspace the two sources differ in
 * location — intended).
 *
 * v1 semantics (spec §3.2, unchanged per root):
 *
 * - Discovery: `<dir>/SKILL.md` only; other files ignored.
 * - Frontmatter `name` and `description` required (single-line values,
 *   matching quotes stripped); `disable-model-invocation: true` hides the
 *   skill from the model entirely — absent from the section, unknown to
 *   `load_skill` (pi's convention); all other fields ignored. A SKILL.md
 *   missing either required field — or the `---` block entirely — is
 *   skipped with a log.
 * - Within one root, duplicate names resolve first-wins (the earlier
 *   directory in sorted order) with a log; across roots, the precedence
 *   order above decides.
 * - The section lists `- name: description (path)` per skill, capped at
 *   `sectionMaxBytes()` (default 4KB, read LIVE per render — boot wires
 *   the settings store) with a truncation notice when capped; zero skills
 *   render no section.
 * - `load_skill(name)` returns the SKILL.md body (everything after the
 *   frontmatter block); an unknown name is an explicit error listing the
 *   available skills.
 *
 * `listSkills` (Task 2c) is the `/skill:name`-facing list: the SAME
 * three-root discovery but WITHOUT the model-visibility filter — a
 * `disable-model-invocation: true` skill is hidden from the section and
 * unknown to `load_skill` yet still expands through `/skill:name`
 * (pi's convention). It carries the flag so the section keeps
 * filtering; nothing about the section's behaviour changes.
 * Built through `createSkillsExtension(opts)` so boot can wire the three
 * roots; it still installs as the core extension named `sigrun.skills`
 * (the reserved-section owner is unchanged) and never goes through the
 * extension loader.
 */

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	section,
} from "@earendil-works/pi-durable";
import type {
	Extension,
	PromptInput,
	ToolExecutionApi,
	ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv, FileInfo } from "@earendil-works/pi-durable/env";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The section key the skills list renders under. */
export const SKILLS_SECTION_KEY = "skills";

/** Total rendered-section budget (spec §3.2: 4KB, notice included). */
export const SKILLS_SECTION_LIMIT_BYTES = 4096;

const SKILLS_DIRECTORY = "skills";
const SKILL_FILE = "SKILL.md";
const FRONTMATTER_DELIMITER = "---";

const SKILLS_SECTION_HEADER =
	"Workspace skills. Call the load_skill tool with a skill's name to read its full instructions; each entry shows the skill's path, so you can also read its SKILL.md directly.";

/** The three discovery roots, in precedence order (§9.4). */
const ROOT_PRECEDENCE = ["workspace", "user dir", "package"] as const;

/**
 * One discovered workspace skill (the workspace root's shape — other
 * roots reuse it with filesystem-read fields).
 */
export interface WorkspaceSkill {
	/** Frontmatter `name` — the skill's identity for the section and the tool. */
	readonly name: string;
	/** Frontmatter `description` — one line, listed in the section. */
	readonly description: string;
	/** The SKILL.md body: everything after the frontmatter block. */
	readonly body: string;
	/** The skill directory as displayed in the section (`skills/<dir>` for workspace skills, the absolute dir otherwise). */
	readonly dir: string;
	/** Frontmatter `disable-model-invocation: true` — hidden from the model. */
	readonly disableModelInvocation: boolean;
}

/**
 * Build the core skills extension. `openHarness` installs the result
 * unconditionally (as `sigrun.skills`) before `Harness.open`.
 *
 * The options are all read LIVE: `packageRoots` and `sectionMaxBytes` are
 * functions so boot can hand late-filled collections (the loader collects
 * package skill dirs after the extension installs — sections render per
 * request, so the late fill is visible) and a settings read (the cap is a
 * live setting).
 */
export interface SkillsOptions {
	/** The user-wide root: `<configDir>/skills/` (absent = the designed empty case). */
	readonly userDir: string;
	/**
	 * Package skill roots, in install order — `{extension, dir}` pairs the
	 * loader collected (extension slug + its skill directory).
	 */
	readonly packageRoots: () => readonly { extension: string; dir: string }[];
	/** The rendered-section budget in bytes, read per render (default 4096). */
	readonly sectionMaxBytes: () => number;
}

/** Parsed frontmatter: required fields absent when missing or empty. */
interface ParsedSkillFile {
	readonly name?: string;
	readonly description?: string;
	/** Frontmatter `disable-model-invocation: true` — the skill is hidden. */
	readonly disableModelInvocation: boolean;
	readonly body: string;
}

const encoder = new TextEncoder();

/** UTF-8 byte length — the unit the section cap is measured in. */
function byteLength(text: string): number {
	return encoder.encode(text).length;
}

/** Strip one matching pair of surrounding quotes, if present. */
function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/**
 * Parse a SKILL.md: the frontmatter must be a `---`-delimited block of
 * `key: value` lines at the very top; the body is everything after the
 * closing delimiter. Returns `undefined` when the block is absent or never
 * closes (neither required field could have parsed).
 */
function parseSkillFile(text: string): ParsedSkillFile | undefined {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return undefined;
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === FRONTMATTER_DELIMITER) {
			close = i;
			break;
		}
	}
	if (close === -1) return undefined;
	const fields: Record<string, string> = {};
	for (const line of lines.slice(1, close)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (match === null) continue;
		const value = unquote(match[2].trim());
		if (value !== "") fields[match[1]] = value;
	}
	return {
		name: fields.name,
		description: fields.description,
		disableModelInvocation:
			fields["disable-model-invocation"] === "true",
		body: lines
			.slice(close + 1)
			.join("\n")
			.replace(/^\r?\n/, ""),
	};
}

/**
 * Parse one read SKILL.md into a skill, applying the shared skip/hide
 * rules with a log. `displayDir` is the path named in the logs and the
 * section entry; `fileLabel` names the file in skip logs.
 */
function skillFromFile(
	text: string,
	displayDir: string,
	fileLabel: string,
): WorkspaceSkill | undefined {
	const parsed = parseSkillFile(text);
	if (parsed === undefined) {
		console.warn(
			`skills: skipping ${fileLabel} (the frontmatter block is required)`,
		);
		return undefined;
	}
	if (parsed.name === undefined) {
		console.warn(`skills: skipping ${fileLabel} (the "name" field is required)`);
		return undefined;
	}
	if (parsed.description === undefined) {
		console.warn(
			`skills: skipping ${fileLabel} (the "description" field is required)`,
		);
		return undefined;
	}
	return {
		name: parsed.name,
		description: parsed.description,
		body: parsed.body,
		dir: displayDir,
		disableModelInvocation: parsed.disableModelInvocation,
	};
}

/** Directory-name comparison (plain code-point order, locale-independent). */
function byDirectoryName(a: FileInfo, b: FileInfo): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Skill-name comparison (plain code-point order, locale-independent). */
function bySkillName(a: WorkspaceSkill, b: WorkspaceSkill): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Read and parse one skill directory's SKILL.md; `undefined` = not a skill. */
async function readSkill(
	env: ExecutionEnv,
	dir: FileInfo,
	context: Context,
): Promise<WorkspaceSkill | undefined> {
	const relative = `${SKILLS_DIRECTORY}/${dir.name}/${SKILL_FILE}`;
	const joined = await env.joinPath(
		[SKILLS_DIRECTORY, dir.name, SKILL_FILE],
		context,
	);
	if (!joined.ok) {
		throw new Error(`Failed to build path for ${relative}: ${joined.error.message}`, {
			cause: joined.error,
		});
	}
	const read = await env.readTextFile(joined.value, context);
	if (!read.ok) {
		if (read.error.code === "not_found") {
			// A directory without SKILL.md is simply not a skill (v1 ignores
			// every other file in a skill directory).
			return undefined;
		}
		throw new Error(`Failed to read ${relative}: ${read.error.message}`, {
			cause: read.error,
		});
	}
	return skillFromFile(read.value, `${SKILLS_DIRECTORY}/${dir.name}`, relative);
}

/**
 * Scan the workspace's skills through the conversation `ExecutionEnv`.
 * An absent `skills/` directory is the designed empty case; any other read
 * failure fails loud. Directories are visited in sorted name order so
 * duplicate frontmatter names resolve deterministically first-wins.
 * `includeHidden` (the `listSkills` path): a skill with
 * `disable-model-invocation: true` is KEPT in the list carrying the
 * flag; the default (`false`, the section and `load_skill` path) hides
 * it from the model entirely — it never reaches the section or the
 * tool.
 */
export async function scanSkills(
	env: ExecutionEnv,
	context: Context,
	opts?: { includeHidden?: boolean },
): Promise<WorkspaceSkill[]> {
	const listing = await env.listDir(SKILLS_DIRECTORY, context);
	if (!listing.ok) {
		if (listing.error.code === "not_found") return [];
		throw new Error(
			`Failed to list the ${SKILLS_DIRECTORY}/ directory: ${listing.error.message}`,
			{ cause: listing.error },
		);
	}
	const directories = listing.value
		.filter((entry) => entry.kind === "directory")
		.sort(byDirectoryName);
	const byName = new Map<string, WorkspaceSkill>();
	for (const entry of directories) {
		const skill = await readSkill(env, entry, context);
		if (skill === undefined) continue;
		if (skill.disableModelInvocation && opts?.includeHidden !== true) {
			console.warn(
				`skills: hiding ${skill.dir} (disable-model-invocation)`,
			);
			continue;
		}
		if (!byName.has(skill.name)) {
			byName.set(skill.name, skill);
		} else {
			const winner = byName.get(skill.name) as WorkspaceSkill;
			console.warn(
				`skills: duplicate name "${skill.name}" (${skill.dir} ignored; ${winner.dir} wins)`,
			);
		}
	}
	return [...byName.values()].sort(bySkillName);
}

/**
 * Scan ONE filesystem root (the user dir or a package's skills dir).
 * Same rules as the workspace root — `SKILL.md` only, sorted directory
 * order, first-wins within the root — read synchronously through
 * `node:fs` (the root is host-local by definition). An absent root is
 * the designed empty case. `includeHidden` keeps
 * `disable-model-invocation: true` skills (the `listSkills` path); the
 * default hides them with a log, exactly like the workspace root.
 */
function scanFsRoot(
	root: string,
	opts?: { includeHidden?: boolean },
): WorkspaceSkill[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
		throw new Error(
			`Failed to list the skills root ${root}: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
			{ cause },
		);
	}
	const byName = new Map<string, WorkspaceSkill>();
	const directories = [...entries]
		.filter((entry) => entry.isDirectory())
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of directories) {
		const file = join(root, entry.name, SKILL_FILE);
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") {
				// A directory without SKILL.md is simply not a skill.
				continue;
			}
			throw new Error(
				`Failed to read ${file}: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
				{ cause },
			);
		}
		const skill = skillFromFile(text, join(root, entry.name), file);
		if (skill === undefined) continue;
		if (skill.disableModelInvocation && opts?.includeHidden !== true) {
			console.warn(
				`skills: hiding ${skill.dir} (disable-model-invocation)`,
			);
			continue;
		}
		if (!byName.has(skill.name)) {
			byName.set(skill.name, skill);
		} else {
			const winner = byName.get(skill.name) as WorkspaceSkill;
			console.warn(
				`skills: duplicate name "${skill.name}" (${skill.dir} ignored; ${winner.dir} wins)`,
			);
		}
	}
	return [...byName.values()].sort(bySkillName);
}

/**
 * The §9.4 root label for a collision log: "workspace", "user dir", or
 * the contributing package's extension name (packages are attributed).
 */
function rootLabelOf(root: (typeof ROOT_PRECEDENCE)[number], extension?: string): string {
	if (root === "package" && extension !== undefined) return extension;
	return root;
}

/**
 * Merge the three roots in precedence order (workspace > user > packages,
 * packages in install order): first-wins on the skill NAME, every loss
 * logged as `skills: "<name>" from <lower root> shadowed by <higher root>`.
 * `includeHidden` threads to each root scan (the `listSkills` path).
 */
export async function discoverSkills(
	env: ExecutionEnv | undefined,
	context: Context,
	opts: SkillsOptions,
	options?: { includeHidden?: boolean },
): Promise<WorkspaceSkill[]> {
	const byName = new Map<string, { skill: WorkspaceSkill; root: (typeof ROOT_PRECEDENCE)[number]; extension?: string }>();
	const merge = (
		skills: readonly WorkspaceSkill[],
		root: (typeof ROOT_PRECEDENCE)[number],
		extension?: string,
	): void => {
		for (const skill of skills) {
			const existing = byName.get(skill.name);
			if (existing === undefined) {
				byName.set(skill.name, { skill, root, extension });
				continue;
			}
			const higher = ROOT_PRECEDENCE.indexOf(root);
			const lower = ROOT_PRECEDENCE.indexOf(existing.root);
			if (higher < lower) {
				// The new root outranks the recorded one — it wins, and the
				// loser is logged.
				byName.set(skill.name, { skill, root, extension });
				console.warn(
					`skills: "${skill.name}" from ${rootLabelOf(existing.root, existing.extension)} shadowed by ${rootLabelOf(root, extension)}`,
				);
			} else {
				console.warn(
					`skills: "${skill.name}" from ${rootLabelOf(root, extension)} shadowed by ${rootLabelOf(existing.root, existing.extension)}`,
				);
			}
		}
	};
	if (env !== undefined) {
		merge(await scanSkills(env, context, options), "workspace");
	}
	merge(scanFsRoot(opts.userDir, options), "user dir");
	for (const root of opts.packageRoots()) {
		merge(scanFsRoot(root.dir, options), "package", root.extension);
	}
	return [...byName.values()].map((entry) => entry.skill).sort(bySkillName);
}

/**
 * The `/skill:name`-facing skill list (Task 2c): the same three-root
 * discovery as `discoverSkills`, but `disable-model-invocation: true`
 * skills are INCLUDED (carrying the flag) — `/skill:name` works for
 * them while the section and `load_skill` keep them hidden. Read LIVE
 * per call (the same posture as the section's per-render scan).
 */
export async function listSkills(
	env: ExecutionEnv | undefined,
	context: Context,
	opts: SkillsOptions,
): Promise<WorkspaceSkill[]> {
	return discoverSkills(env, context, opts, { includeHidden: true });
}

/**
 * Assemble the section text: the header plus one `- name: description
 * (path)` line per skill, capped at `limitBytes` bytes including the
 * truncation notice. The path lets the model read the SKILL.md directly
 * (and resolve bundled references) via the read tool, complementing
 * `load_skill`. Whole lines drop from the end until the text fits; the
 * notice names how many skills were cut. When even the header cannot
 * fit, the NOTICE alone renders — the model learns skills exist and are
 * reachable through `load_skill`, which is the section's whole point at
 * that size. Zero skills render no section at all.
 */
export function renderSkillList(
	skills: readonly WorkspaceSkill[],
	limitBytes: number,
): string | undefined {
	// `disable-model-invocation: true` never reaches the section — the
	// filter is the section's own (a hidden skill passed in through the
	// `/skill:name` list is still invisible here).
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return undefined;
	const header = `${SKILLS_SECTION_HEADER}\n\n`;
	const lines = visible.map(
		(skill) => `- ${skill.name}: ${skill.description} (${skill.dir})`,
	);
	const full = header + lines.join("\n");
	if (byteLength(full) <= limitBytes) return full;
	let kept = lines.length - 1;
	while (kept >= 0) {
		const dropped = lines.length - kept;
		const notice = `\n(skill list truncated: ${dropped} more not shown)`;
		const body = lines.slice(0, kept).join("\n");
		const text = header + body + notice;
		if (byteLength(text) <= limitBytes) return text;
		kept -= 1;
	}
	// Not even the header fits: the notice alone (the smallest honest
	// rendering — it says skills exist and how many were cut).
	return `(skill list truncated: ${lines.length} more not shown — call load_skill by name)`;
}

/** Section render: discover all three roots, list the winning skills. */
async function renderSkills(
	input: PromptInput,
	context: Context,
	opts: SkillsOptions,
): Promise<string | undefined> {
	const skills = await discoverSkills(input.env, context, opts);
	return renderSkillList(skills, opts.sectionMaxBytes());
}

/** An explicit tool error: text content the model can read and recover from. */
function skillError(message: string): ToolExecutionResult {
	return { output: [{ type: "text", text: message }], isError: true };
}

/** Build the `load_skill` tool against the same three-root discovery. */
function buildLoadSkillTool(opts: SkillsOptions) {
	return defineTool({
		name: "load_skill",
		description:
			"Load one skill's full instructions by name, as listed in the skills section.",
		parameters: Type.Object({
			name: Type.String({
				description: "The skill name exactly as listed in the skills section.",
			}),
		}),
		async execute(
			args: { name: string },
			api: ToolExecutionApi,
			context: Context,
		): Promise<ToolExecutionResult> {
			const skills = await discoverSkills(api.env, context, opts);
			const skill = skills.find((candidate) => candidate.name === args.name);
			if (skill === undefined) {
				if (skills.length === 0) {
					return skillError(
						`load_skill: unknown skill "${args.name}"; no skills are installed.`,
					);
				}
				const available = skills.map((candidate) => candidate.name).join(", ");
				return skillError(
					`load_skill: unknown skill "${args.name}"; available skills: ${available}`,
				);
			}
			api.output(skill.body);
			return {};
		},
	});
}

/**
 * Build the skills extension (core-owned): one prompt section plus one
 * tool over the three-root discovery. `openHarness` installs the result
 * unconditionally before `Harness.open`, under the unchanged core name
 * `sigrun.skills`.
 */
export function createSkillsExtension(opts: SkillsOptions): Extension {
	return defineExtension({
		name: "sigrun.skills",
		sections: [
			section(SKILLS_SECTION_KEY, (input, context) =>
				renderSkills(input, context, opts),
			),
		],
		tools: [buildLoadSkillTool(opts)],
	});
}
